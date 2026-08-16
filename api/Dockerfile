FROM node:20
WORKDIR /app
COPY package.json ./
RUN npm install --production --silent
RUN apt-get update && apt-get install -y --no-install-recommends calibre djvulibre-bin poppler-utils ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# yt-dlp fetches a platform's own subtitle track — seconds and a few kilobytes,
# with timecodes already in it. That is the cheapest transcript there is, and it
# is why speech recognition is the fallback rather than the plan.
#
# Latest release by default, and that is a deliberate reversal.
#
# Pinning was the wrong instinct for this one tool: platforms change their
# internals constantly and yt-dlp follows within days, so a pin is not stability
# — it is a guarantee that the build stops working on a schedule nobody
# controls. A version fixed in January failed against YouTube on the first real
# attempt.
#
# Reproducibility is still available when it matters: pass
# --build-arg YTDLP_VERSION=2025.08.11 to freeze a known-good one.
ARG YTDLP_VERSION=latest
ADD https://github.com/yt-dlp/yt-dlp/releases/${YTDLP_VERSION}/download/yt-dlp_linux /usr/local/bin/yt-dlp
RUN chmod a+rx /usr/local/bin/yt-dlp
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
