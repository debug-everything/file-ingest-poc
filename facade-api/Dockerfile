FROM node:22-slim
ENV NODE_ENV=production PORT=8080
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile
COPY src ./src
USER node
EXPOSE 8080
CMD ["node", "src/server.js"]
