FROM node:22-alpine
WORKDIR /app

COPY package.json package-lock.json ./
COPY server/package.json ./server/package.json
COPY client/package.json ./client/package.json
RUN npm ci --omit=dev --workspace=api && npm cache clean --force

COPY server/src ./server/src

# P2B: the operational scripts were NEVER in the image.
#
# Found by Docker verification, not by any test: `docker compose exec api node
# scripts/platform-admin.js list` failed with MODULE_NOT_FOUND because only
# `server/src` was ever copied. That silently applied to every script in the
# directory — backup, restore and the migrations included — so the documented
# recovery procedures could not actually be run inside a container.
#
# Copied explicitly rather than by widening to `COPY server ./server`, which
# would drag the test suite and its dev-only fixtures into a production image.
COPY server/scripts ./server/scripts
WORKDIR /app/server

ENV NODE_ENV=production
EXPOSE 4000
HEALTHCHECK --interval=10s --timeout=3s --start-period=40s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:4000/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

USER node
CMD ["node", "src/index.js"]
