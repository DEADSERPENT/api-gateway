# Multi-stage image: compile TypeScript in one stage, ship only dist/ and production
# dependencies. The same image runs the gateway and the mock services (different CMD).

FROM node:25-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY services ./services
COPY scripts/copy-assets.mjs ./scripts/copy-assets.mjs
RUN npm run build

FROM node:25-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:25-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
USER node
EXPOSE 3000
CMD ["node", "dist/src/server.js"]
