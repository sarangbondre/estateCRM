# insight: container image for AWS ECS Fargate (CR-018). Build from the repository root:
#   docker build -f services/insight/Dockerfile -t 11e/insight .
# Stage 1 builds the service and its workspace libraries; stage 2 holds only the deployed package (prod dependencies).
FROM node:24-bookworm-slim AS build
WORKDIR /repo
RUN npm install -g pnpm@12.7.0
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm turbo run build --filter=@11e/insight...
RUN pnpm --filter=@11e/insight deploy --prod --legacy /out

FROM node:24-bookworm-slim
ENV NODE_ENV=production PORT=3006
WORKDIR /app
COPY --from=build --chown=node:node /out ./
USER node
EXPOSE 3006
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/src/server.js"]
