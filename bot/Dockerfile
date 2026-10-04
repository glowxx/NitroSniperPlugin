FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY bot ./bot
RUN mkdir -p /app/bot/data && chown node:node /app/bot/data
USER node
ENV HOST=0.0.0.0 DATABASE_PATH=/app/bot/data/notifications.sqlite
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:8787/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "bot/index.mjs"]
