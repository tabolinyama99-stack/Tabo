# ---------- build the web client ----------
FROM node:22-bookworm-slim AS client
WORKDIR /app/client
COPY client/package.json client/package-lock.json ./
RUN npm ci
COPY client/ ./
RUN npm run build

# ---------- runtime ----------
FROM node:22-bookworm-slim
ENV NODE_ENV=production PORT=4000 UPLOAD_DIR=/data/uploads BACKUP_DIR=/data/backups CLIENT_DIST=/app/client/dist
# pg_dump/pg_restore for backups, tesseract + poppler for on-server receipt OCR
RUN apt-get update && apt-get install -y --no-install-recommends postgresql-client tesseract-ocr poppler-utils ca-certificates tini \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev
COPY server/ ./
COPY --from=client /app/client/dist /app/client/dist
RUN mkdir -p /data/uploads /data/backups && chown -R node:node /data /app
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/index.js"]
