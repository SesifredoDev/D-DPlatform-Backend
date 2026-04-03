FROM node:20-slim

WORKDIR /app

# Install necessary tools including curl for health checks
RUN apt-get update && apt-get install -y python3 make g++ curl && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install

COPY . .

# Match the internal port your app actually listens on
EXPOSE 3000

CMD ["node", "server.js"]
