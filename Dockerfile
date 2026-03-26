FROM node:20-alpine
WORKDIR /app

# v3 timestamp 2026-03-27T04:00:00Z - force full rebuild
ARG CACHE_BUST=v3

COPY package.json ./
RUN npm install --production

COPY server.js ./
COPY seed.js ./
COPY seed_data.json ./
COPY public/ ./public/
COPY railway.json ./

RUN node seed.js

# Verify files are correct
RUN echo "=== server.js lines: $(wc -l < server.js) ===" && \
    echo "=== admin.html lines: $(wc -l < public/admin.html) ===" && \
    echo "=== seed_data size: $(wc -c < seed_data.json) ===" && \
    ls -la && ls -la public/

EXPOSE 3000
CMD ["node", "server.js"]
