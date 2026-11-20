# One image for both processes:
#   API:     node dist/server.js         (default)
#   Indexer: node dist/indexer/main.js   (applies database/schema.sql on start)
#
# Healthchecking is intentionally NOT defined at the image level. A single
# image-level HEALTHCHECK cannot be correct for both entrypoints: the API
# serves /health on PORT, while the indexer serves /healthz and /readyz on
# INDEXER_HTTP_PORT. Probing the API's /health from the indexer container
# (the previous behaviour) was misleading and always reported the wrong
# process. Instead, each service declares its own healthcheck in
# deploy/docker-compose.yml, and the indexer probes its own in-process
# endpoint (a single HTTP request, no extra Node process or DB connection).

FROM node:20-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY database ./database
USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]