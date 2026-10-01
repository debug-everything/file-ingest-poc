FROM node:22-slim
ENV NODE_ENV=production PORT=8080
WORKDIR /app
RUN corepack enable
# Build context is the repo root, so Railway can build this without any dashboard settings.
COPY facade-api/package.json facade-api/pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile
COPY facade-api/src ./src
USER node
EXPOSE 8080
CMD ["node", "src/server.js"]
