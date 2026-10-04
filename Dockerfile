# LifeOS server + ECLIPSE web client in one small image.
# Build: docker build -t lifeos .
# Run:   see docker-compose.yml and docs/deploy.md

FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
COPY package.json package-lock.json ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/promethee/package.json packages/promethee/
COPY packages/eclipse/package.json packages/eclipse/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY apps/companion/package.json apps/companion/
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY packages packages
COPY apps/server apps/server
COPY apps/web apps/web
RUN npm run build -w @lifeos/web && npm run build -w @lifeos/server

# The server bundle has no runtime dependencies: no node_modules in the final image.
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787
COPY --from=build /app/apps/server/dist apps/server/dist
COPY --from=build /app/apps/web/dist apps/web/dist
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/v1/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "apps/server/dist/server.js"]
