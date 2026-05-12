FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --production --silent
COPY server.js init.sql ./
EXPOSE 3001
CMD ["node", "server.js"]
