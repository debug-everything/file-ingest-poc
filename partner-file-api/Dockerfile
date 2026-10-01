FROM node:22-slim
ENV NODE_ENV=production DATA_DIR=/data PORT=8080
WORKDIR /app
# No runtime dependencies, so there is nothing to install.
COPY package.json checksums.json ./
COPY src ./src
USER node
EXPOSE 8080
CMD ["node", "src/server.js"]
