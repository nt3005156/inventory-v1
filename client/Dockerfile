FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY client/package.json ./client/package.json
COPY server/package.json ./server/package.json
RUN npm ci --workspace=web && npm cache clean --force

COPY client ./client
ARG VITE_API_URL=/api
ARG VITE_SOCKET_URL=
ENV VITE_API_URL=$VITE_API_URL
ENV VITE_SOCKET_URL=$VITE_SOCKET_URL
RUN npm run build --workspace=web

# Phase 28: the UNPRIVILEGED nginx image. The standard one starts as root to
# bind :80 and then drops to `nginx` for workers; this variant never runs as
# root at all and listens on 8080 inside the container. Verified before this
# change: `docker compose exec web id -u` returned 0.
FROM nginxinc/nginx-unprivileged:1.28-alpine
USER root
COPY client/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/client/dist /usr/share/nginx/html
# The unprivileged image already runs as uid 101; make ownership explicit so a
# read failure cannot masquerade as a routing problem.
RUN chown -R 101:101 /usr/share/nginx/html
USER 101
EXPOSE 8080
# Serve the SPA shell from local disk. The previous check proxied /health to
# the API, which cannot tell "nginx is broken" from "the API is down" and
# marked nginx unhealthy during an API restart even while it served correctly.
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=5 \
  CMD wget -qO- http://127.0.0.1:8080/index.html >/dev/null || exit 1
