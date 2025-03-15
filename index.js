import express from "express";
import dotenv from "dotenv";
import axios from "axios";
import crypto from "crypto";

dotenv.config();

const app = express();
app.use(express.json());

// --------------------
// LOCAL VARIABLES
// --------------------

// in-memory KVS, for each key, an object with:
// { value: string, versions: string[], clock: {[nodeId]: number}, deps: string[] }
// version: `v<count>.<node>.<key>`
const store = {};
const NODE_IDENTIFIER = process.env.NODE_IDENTIFIER;
let currentShards = {};
let myShard = null;

// --------------------
// HELPER FUNCTIONS
// --------------------

const isOnline = () => {
  return myShard != null;
};

const checkOnline = (req, res, next) => {
  if (!isOnline()) {
    return res.status(503).json({ error: "Node is not online" });
  }
  next();
};

/**
 * all endpoints under /data require that the node is online
 */
app.use("/data", checkOnline);

const getShardForKey = (key) => {
  const shards = Object.keys(currentShards).sort();
  if (shards.length == 0) return null;
  const hashHex = crypto.createHash("sha256").update(key).digest("hex");
  const hashInt = BigInt("0x" + hashHex);
  const index = Number(hashInt % BigInt(shards.length));
  return shards[index];
};

const compareClocks = (clockA, clockB) => {
  let aBigger = false;
  let bBigger = false;
  const allNodes = new Set([...Object.keys(clockA), ...Object.keys(clockB)]);
  for (const node of allNodes) {
    const aVal = clockA[node] || 0;
    const bVal = clockB[node] || 0;
    if (aVal > bVal) aBigger = true;
    if (aVal < bVal) bBigger = true;
  }
  if (aBigger && !bBigger) return 1;
  if (!aBigger && bBigger) return -1;
  return 0;
};

// const compareVersions = (versionA, versionB) => {
//   if (versionA > versionB) return 1;
//   if (versionA < versionB) return -1;
//   return 0;
// };

const mergeClocks = (clockA, clockB) => {
  const newClock = { ...clockA };
  for (const [node, count] of Object.entries(clockB)) {
    newClock[node] = Math.max(newClock[node] || 0, count);
  }
  return newClock;
};

const clockSatisfied = (clientClock, storeClock) => {
  for (const node in clientClock) {
    if ((storeClock[node] || 0) < clientClock[node]) return false;
  }
  return true;
};

const replicateToOthers = async (replicationData) => {
  const myShardNodes = currentShards[myShard] || [];
  const others = myShardNodes.filter(
    (node) => String(node.id) !== String(NODE_IDENTIFIER)
  );

  for (const node of others) {
    const url = `http://${node.address}/internal/replicate`;
    try {
      await axios.post(url, replicationData, { timeout: 5000 });
    } catch (err) {
      console.error(
        `Failed to replicate to others at ${node.address}: ${err.message}`
      );
    }
  }
};

// const pruneClock = (clock) => {
//   const allowed = new Set(currentView.map((n) => String(n.id)));
//   return Object.fromEntries(
//     Object.entries(clock).filter(([id, count]) => allowed.has(id))
//   );
// };

const buildGlobalMetadata = () => {
  const meta = {};
  for (const [k, entry] of Object.entries(store)) {
    meta[k] = entry.clock;
  }
  return meta;
};

const mergeGlobalMetadata = (clientMeta) => {
  for (const [key, clientClock] of Object.entries(clientMeta)) {
    if (!store.hasOwnProperty(key)) {
      continue;
    }
    store[key].clock = mergeClocks(store[key].clock, clientClock);
  }
};

const globalDependencies = () => {
  const deps = new Set();
  for (const entry of Object.values(store)) {
    if (entry.deps && Array.isArray(entry.deps)) {
      for (const dep of entry.deps) {
        deps.add(dep);
      }
    }
  }
  return deps;
};

const syncKeyFromPeers = async (key) => {
  const myShardNodes = currentShards[myShard] || [];
  const others = myShardNodes.filter(
    (node) => String(node.id) !== String(NODE_IDENTIFIER)
  );
  for (const node of others) {
    const url = `http://${node.address}/internal/sync`;
    try {
      const response = await axios.get(url, { timeout: 5000 });
      const remoteStore = response.data.remoteStore;
      if (remoteStore.hasOwnProperty(key)) {
        if (!store.hasOwnProperty(key)) {
          store[key] = remoteStore[key];
        } else {
          const cmp = compareClocks(store[key].clock, remoteStore[key].clock);
          if (cmp === -1) {
            store[key] = remoteStore[key];
          } else {
            store[key].clock = mergeClocks(
              store[key].clock,
              remoteStore[key].clock
            );
          }
        }
      }
    } catch (err) {
      console.error(
        `Active sync failed with node ${node.address}: ${err.message}`
      );
    }
  }
};

const parseVersion = (version) => {
  const parts = version.split(".");
  if (parts.length < 3) return null;
  const countStr = parts[0].substring(1);
  return { count: parseInt(countStr, 10), node: parts[1] };
};

const getClockFromVersions = (versions) => {
  const clock = {};
  for (const version of versions) {
    const parsed = parseVersion(version);
    if (parsed) {
      clock[parsed.node] = (clock[parsed.node] || 0) + 1;
    }
  }
  return clock;
};

const isSameCount = (clockA, clockB) => {
  const sumA = Object.values(clockA).reduce((acc, val) => acc + val, 0);
  const sumB = Object.values(clockB).reduce((acc, val) => acc + val, 0);
  return sumA == sumB;
};

const replicateToShard = async (targetShard, replicationData) => {
  const nodes = currentShards[targetShard];
  if (!nodes || nodes.length === 0) {
    console.error(
      `No nodes available in shard ${targetShard} for cross-shard replication.`
    );
    return;
  }
  const targetNode = nodes[0]; // choose the first available node
  const url = `http://${targetNode.address}/internal/replicate`;
  try {
    await axios.post(url, replicationData, { timeout: 5000 });
  } catch (err) {
    console.error(
      `Failed to replicate key ${replicationData.key} to shard ${targetShard} at ${targetNode.address}: ${err.message}`
    );
  }
};
// --------------------
// ENDPOINTS
// --------------------

/**
 * GET /ping
 * health check endpoint
 */
app.get("/ping", (req, res) => {
  return res.sendStatus(200);
});

/**
 * PUT /view
 * update the view of cluster and performing resharding
 */
app.put("/view", async (req, res) => {
  if (!req.body || !req.body.view || typeof req.body.view !== "object") {
    return res.status(400).json({ error: "Invalid view format" });
  }
  currentShards = req.body.view;

  myShard = null;
  for (const [shard, nodes] of Object.entries(currentShards)) {
    if (nodes.some((node) => String(node.id) === NODE_IDENTIFIER)) {
      myShard = shard;
      break;
    }
  }
  if (!myShard) {
    console.warn(
      `Current node ${NODE_IDENTIFIER} is not in any shard in the view.`
    );
    return res.sendStatus(200);
  }

  for (const key in store) {
    const responsibleShard = getShardForKey(key);
    if (responsibleShard !== myShard) {
      const replicationData = {
        operation: "PUT",
        key,
        value: store[key].value,
        versions: store[key].versions,
        clock: store[key].clock,
        deps: store[key].deps,
      };
      await replicateToShard(responsibleShard, replicationData);
      console.log(
        `Relocating key ${key} from shard ${myShard} to shard ${responsibleShard}`
      );
      delete store[key];
    }
  }

  const myShardNodes = currentShards[myShard].filter(
    (node) => String(node.id) !== NODE_IDENTIFIER
  );
  const allowedNodes = new Set(myShardNodes.map((node) => String(node.id)));
  for (const key in store) {
    const keyClock = store[key].clock;
    for (const nodeId in keyClock) {
      if (!allowedNodes.has(nodeId)) {
        console.log(
          `Pruning key ${key} because its clock contains dropped node ${nodeId}`
        );
        delete store[key];
        break;
      }
    }
  }
  /**
   * 1. iterate node of currentView
   *  1-1. if NODE_IDENTIFIER is not node.id
   *    1-1-1. try sync w/ the node
   *    1-1-2. merge each key from remote store
   *    1-1-3. break if sync w/ one node is successful
   */
  for (const node of myShardNodes) {
    if (String(node.id) != NODE_IDENTIFIER) {
      const url = `http://${node.address}/internal/sync`;
      try {
        const response = await axios.get(url, { timeout: 5000 });
        const { remoteStore } = response.data;
        for (const key in remoteStore) {
          if (store.hasOwnProperty(key)) {
            const cmp = compareClocks(store[key].clock, remoteStore[key].clock);
            if (cmp == -1) {
              store[key] = remoteStore[key];
            } else {
              store[key].clock = mergeClocks(
                store[key].clock,
                remoteStore[key].clock
              );
            }
          } else {
            store[key] = remoteStore[key];
          }
        }
        break;
      } catch (err) {
        console.error(`Sync failed with node ${node.address}: ${err.message}`);
      }
    }
  }
  return res.sendStatus(200);
});

/**
 * GET /data
 * returns the entire KVS
 */
app.get("/data", (req, res) => {
  const clientMeta = req.body ? req.body["causal-metadata"] || {} : {};
  mergeGlobalMetadata(clientMeta);

  // ensure causal consistency by compare store[key].clock w/ clientClock
  for (const [key, entry] of Object.entries(store)) {
    const clientClockForKey = clientMeta[key] || {};
    if (!clockSatisfied(clientClockForKey, entry.clock)) {
      return res.status(503).json({
        error: `Server not caught up with causal dependencies for key ${key}`,
      });
    }
  }

  const items = {};
  for (const [key, entry] of Object.entries(store)) {
    items[key] = entry.value;
  }
  return res
    .status(200)
    .json({ items, "causal-metadata": buildGlobalMetadata() });
});

/**
 * GET /data/:key
 * returns the value associated w/ the given key
 */
app.get("/data/:key", async (req, res) => {
  const key = req.params.key;
  const targetShard = getShardForKey(key);
  if (targetShard != myShard) {
    const nodes = currentShards[targetShard];
    if (!nodes || nodes.length === 0) {
      return res.status(503).json({ error: "Target shard unavailable" });
    }
    const targetNode = nodes[0];
    const url = `http://${targetNode.address}/data/${key}`;
    try {
      const response = await axios.get(url, { data: req.body, timeout: 5000 });
      return res.status(response.status).json(response.data);
    } catch (err) {
      return res
        .status(503)
        .json({ error: "Failed to forward request to responsible shard" });
    }
  }

  const clientMetaRaw = req.body ? req.body["causal-metadata"] : undefined;
  const clientMetaProvided =
    clientMetaRaw != null && Object.keys(clientMetaRaw).length > 0;
  const clientMeta = clientMetaProvided ? clientMetaRaw : {};
  mergeGlobalMetadata(clientMeta);

  if (!store.hasOwnProperty(key)) {
    const deps = globalDependencies();
    if (!deps.has(key) || !clientMetaProvided) {
      return res.status(404).json({
        error: "Key not found",
        "causal-metadata": buildGlobalMetadata(),
      });
    } else {
      const timeout = 10000;
      const pollInterval = 100;
      const startTime = Date.now();
      while (Date.now() - startTime < timeout) {
        await syncKeyFromPeers(key);
        if (store.hasOwnProperty(key)) break;
        await new Promise((resolve) => setTimeout(resolve, pollInterval));
      }
      if (!store.hasOwnProperty(key)) {
        return res.status(408).json({
          error: "Timeout waiting for key",
          "causal-metadata": buildGlobalMetadata(),
        });
      }
    }
  }

  const computedClock = getClockFromVersions(store[key].versions);
  const clientClockForKey = clientMeta[key] || {};
  if (!clockSatisfied(clientClockForKey, computedClock)) {
    if (!isSameCount(clientClockForKey, computedClock)) {
      return res.status(408).json({
        error: `Timeout waiting with causal dependencies for key ${key}`,
        "causal-metadata": buildGlobalMetadata(),
      });
    }
  }

  return res.status(200).json({
    value: store[key].value,
    "causal-metadata": buildGlobalMetadata(),
  });
});

/**
 * PUT /data/:key
 * creates or updates the value of the key
 */
app.put("/data/:key", async (req, res) => {
  const key = req.params.key;
  const targetShard = getShardForKey(key);
  if (targetShard !== myShard) {
    const nodes = currentShards[targetShard];
    if (!nodes || nodes.length === 0) {
      return res.status(503).json({ error: "Target shard unavailable" });
    }
    const targetNode = nodes[0];
    const url = `http://${targetNode.address}/data/${key}`;
    try {
      const response = await axios.put(url, req.body, { timeout: 5000 });
      return res.status(response.status).json(response.data);
    } catch (err) {
      return res
        .status(408)
        .json({ error: "Failed to forward request to responsible shard" });
    }
  }

  const clientMeta = req.body ? req.body["causal-metadata"] || {} : {};
  mergeGlobalMetadata(clientMeta);
  if (!req.body || typeof req.body.value != "string") {
    return res.status(400).json({ error: `Invalid request body` });
  }
  const value = req.body.value;
  const isNewkey = !store.hasOwnProperty(key);
  if (!store[key]) {
    store[key] = { value: "", versions: [], clock: {}, deps: [] };
  }
  store[key].deps = Object.keys(clientMeta);
  store[key].clock[NODE_IDENTIFIER] =
    (store[key].clock[NODE_IDENTIFIER] || 0) + 1;
  store[key].value = value;
  const newVersion = `v${store[key].clock[NODE_IDENTIFIER]}.${NODE_IDENTIFIER}.${key}`;
  store[key].versions.push(newVersion);

  await replicateToOthers({
    operation: "PUT",
    key,
    value,
    versions: store[key].versions,
    clock: store[key].clock,
    deps: store[key].deps,
  });

  return res.status(isNewkey ? 201 : 200).json({
    message: "Key store successfully",
    "causal-metadata": buildGlobalMetadata(),
  });
});

/**
 * DELETE /data/:key
 * deletes a key from the store
 * DOES NOT ENSURE causal consistency
 */
app.delete("/data/:key", async (req, res) => {
  const key = req.params.key;
  const targetShard = getShardForKey(key);
  if (targetShard != myShard) {
    const nodes = currentShards[targetShard];
    if (!nodes || nodes.length === 0) {
      return res.status(503).json({ error: "Target shard unavailable" });
    }
    const targetNode = nodes[0];
    const url = `http://${targetNode.address}/data/${key}`;
    try {
      const response = await axios.delete(url, {
        data: req.body,
        timeout: 5000,
      });
      return res.status(response.status).json(response.data);
    } catch (err) {
      return res
        .status(503)
        .json({ error: "Failed to forward request to responsible shard" });
    }
  }

  const clientMeta = req.body ? req.body["causal-metadata"] || {} : {};
  mergeGlobalMetadata(clientMeta);

  store[key].clock[NODE_IDENTIFIER] =
    (store[key].clock[NODE_IDENTIFIER] || 0) + 1;

  await replicateToOthers({
    operation: "DELETE",
    key,
    clock: store[key].clock,
  });

  if (store.hasOwnProperty(key)) {
    delete store[key];
    return res.status(200).json({
      message: "Key deleted successfully",
      "causal-metadata": buildGlobalMetadata(),
    });
  } else {
    return res.status(404).json({
      error: "Key not found",
      "causal-metadata": buildGlobalMetadata(),
    });
  }
});

// --------------------
// INTERNAL ENDPOINTS
// --------------------

/**
 * POST /internal/replicate
 * internal endpoint to replicate PUT and DELETE operations
 */
app.post("/internal/replicate", (req, res) => {
  if (!req.body || !req.body.operation || !req.body.key || !req.body.clock) {
    return res.status(400).json({ error: "Invalid replication request" });
  }

  const { operation, key, value, versions, clock, deps } = req.body;
  if (operation == "PUT") {
    if (!store[key]) {
      store[key] = { value: "", versions: [], clock: {}, deps: [] };
    }
    store[key].deps = deps || [];
    store[key].clock = mergeClocks(store[key].clock, clock);
    store[key].value = value;
    for (const ver of versions) {
      if (!store[key].versions.includes(ver)) {
        store[key].versions.push(ver);
      }
    }
  } else if (operation == "DELETE") {
    delete store[key];
  } else {
    return res.status(400).json({ error: "Invalid replication request" });
  }
  return res.sendStatus(200);
});

/**
 * GET /internal/sync
 * internal endpoint to sync store and local vector clock
 */
app.get("/internal/sync", (req, res) => {
  return res.status(200).json({ remoteStore: store });
});

// --------------------
// START THE SERVER
// --------------------

const port = process.env.PORT || 8081;
app.listen(port, () => {
  console.log(`node is listening on port ${port}`);
});
