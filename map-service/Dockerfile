FROM node:20-slim

WORKDIR /app

RUN apt-get update && apt-get install -y python3 make g++ netcat-openbsd && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install

COPY . .
EXPOSE 3003
CMD ["node", "index.js"]
