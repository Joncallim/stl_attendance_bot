FROM node:22-bookworm-slim

ENV NODE_ENV=production

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY README.md ./

RUN mkdir -p /app/data && chown -R node:node /app

USER node

VOLUME ["/app/data"]

CMD ["node", "src/index.js"]
