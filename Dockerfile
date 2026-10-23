# syntax=docker/dockerfile:1

# Build everything with the full toolchain.
FROM node:26-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY services/api/package.json services/api/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile
COPY packages packages
COPY services services
COPY apps apps
RUN pnpm build

# Run with only what the server needs: its production dependencies and the built output.
FROM node:26-slim
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json packages/core/
COPY services/api/package.json services/api/
COPY apps/web/package.json apps/web/
RUN pnpm install --prod --frozen-lockfile --filter "@concord/api..."
COPY --from=build /app/packages/core/dist packages/core/dist
COPY --from=build /app/services/api/dist services/api/dist
COPY --from=build /app/apps/web/dist apps/web/dist

# Every database lives under /data. Mount a volume there to keep them; without one they last
# only as long as the container.
RUN mkdir -p /data && chown node:node /data
ENV CONCORD_HOST=0.0.0.0 \
    CONCORD_DATA_DIR=/data
USER node
EXPOSE 4400
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.CONCORD_PORT||process.env.PORT||4400)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "services/api/dist/main.js"]
