FROM node:20-slim

WORKDIR /app

# Only install necessary build tools if you have native dependencies
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install

COPY . .

# Match the internal port your app actually listens on
EXPOSE 3000

CMD ["node", "server.js"]