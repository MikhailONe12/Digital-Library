FROM node:20
WORKDIR /app
COPY package.json ./
RUN npm install --production --silent
RUN apt-get update && apt-get install -y --no-install-recommends calibre djvulibre-bin \
    && rm -rf /var/lib/apt/lists/*
COPY server.js init.sql ./
EXPOSE 3001
CMD ["node", "server.js"]
