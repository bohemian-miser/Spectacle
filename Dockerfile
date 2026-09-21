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
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY shared ./shared
COPY server ./server
COPY tsconfig.json ./
EXPOSE 8787
CMD ["npx", "tsx", "server/index.ts"]
