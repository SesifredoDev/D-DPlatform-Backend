FROM node:20-slim
WORKDIR /app

RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 3002
EXPOSE 40000-40050/udp
EXPOSE 40000-40050/tcp

CMD ["node", "index.js"]