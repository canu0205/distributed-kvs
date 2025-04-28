# Distributed KVS (Key-Value Store)

A distributed key-value store project built for the Distributed Systems course (CSE138, Winter 2025, UCSC).

## Features

- Fault-tolerant key-value storage across multiple nodes
- Causal consistency using **Vector Clocks**
- Client-to-server and server-to-server communication handling
- Handling network partitions and ensuring **eventual consistency**

## Key Concepts

- **Replication**: Data is replicated across multiple nodes for fault tolerance.
- **Vector Clocks**: Track causality and maintain correct versioning in distributed updates.
- **Causal Consistency**: Ensures that operations are seen by all nodes in a causally consistent manner.

---

Part of my broader study into **distributed systems** and **blockchain consensus mechanisms**.
