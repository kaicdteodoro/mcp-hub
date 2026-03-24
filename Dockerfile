FROM node:20-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
ENV NODE_ENV=production

RUN groupadd --system mcp && useradd --system --gid mcp --home /app mcp

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .
RUN chown -R mcp:mcp /app

USER mcp

EXPOSE 3333

CMD ["node", "index.js"]
