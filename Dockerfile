FROM node:18-alpine

WORKDIR /app

COPY package*.json /app/

RUN npm install

COPY . /app/

EXPOSE 8081

CMD ["npm", "start"]
