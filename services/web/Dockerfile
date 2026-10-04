# web: container image for AWS ECS Fargate (CR-018). Build from the repository root:
#   docker build -f services/web/Dockerfile -t 11e/web .
# Stage 1 builds the Next.js app as a standalone server (NEXT_OUTPUT=standalone) traced from the monorepo; stage 2
# holds only that bundle and the static assets.
FROM node:24-bookworm-slim AS build
WORKDIR /repo
RUN npm install -g pnpm@12.7.0
COPY . .
RUN pnpm install --frozen-lockfile
ENV NEXT_OUTPUT=standalone NEXT_TELEMETRY_DISABLED=1
RUN pnpm turbo run build --filter=@11e/web...

FROM node:24-bookworm-slim
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
COPY --from=build --chown=node:node /repo/services/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/services/web/.next/static ./services/web/.next/static
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "services/web/server.js"]
