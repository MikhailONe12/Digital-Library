FROM node:20
WORKDIR /app
COPY package.json ./
RUN npm install --production --silent
RUN apt-get update && apt-get install -y --no-install-recommends calibre djvulibre-bin poppler-utils \
    && rm -rf /var/lib/apt/lists/*
COPY server.js init.sql ./
EXPOSE 3001

# Run the mounted copy when there is one, the baked-in copy otherwise.
#
# Deploys bind-mount the current server.js and init.sql at /app/live, so
# shipping a code change is a restart rather than an image rebuild — no base
# image to re-resolve, no registry to reach, seconds instead of minutes. The
# image still carries its own copy, so a container started with no mount (a
# fresh install, a manual `docker run`) works exactly as before.
#
# Node resolves modules by walking up from the running file, so /app/live finds
# /app/node_modules, and server.js reads init.sql from its own directory either
# way.
CMD ["sh", "-c", "if [ -f /app/live/server.js ]; then exec node /app/live/server.js; else exec node /app/server.js; fi"]
