FROM node:20-slim AS base
WORKDIR /app
COPY package*.json ./
RUN npm ci

FROM base AS builder
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM base AS prod-deps
RUN npm prune --omit=dev

FROM node:20-slim AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

EXPOSE 3000

CMD ["node", "dist/index.js"]
