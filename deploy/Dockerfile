# ---- Build stage ----
FROM node:20-alpine AS build

WORKDIR /app

ENV VITE_DEFAULT_API_URL=__VITE_DEFAULT_API_URL_PLACEHOLDER__

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# ---- Production stage ----
FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/data
ENV PUBLIC_DIR=/app/dist

COPY --from=build /app/dist ./dist
COPY server ./server
COPY package.json ./package.json

VOLUME ["/data"]
EXPOSE 3000

CMD ["node", "server/server.mjs"]
