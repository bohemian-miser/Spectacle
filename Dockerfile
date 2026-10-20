# Spectacle: build the client, then run the game server which serves it.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8787
# The server is one bundled file (scripts/build-server.mjs): no node_modules.
# shared/ ships as source only for the brains key (server/brains.ts hashes it).
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server ./dist-server
COPY package.json ./
COPY shared ./shared
# /data: where a volume can keep STATS_FILE across image updates (owned by node,
# so a new named volume mounted there is writable).
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:8787/health >/dev/null || exit 1
CMD ["node", "--enable-source-maps", "dist-server/index.mjs"]
