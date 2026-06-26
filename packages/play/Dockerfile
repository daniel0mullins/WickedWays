# Multi-stage image for the @wickedways/play browser SPA.
#
# The build context MUST be the repo root (in Coolify: Base Directory = "/",
# Dockerfile Location = "/packages/play/Dockerfile"). The SPA bundles the
# `wickedways` engine straight from TypeScript source through the pnpm
# workspace, so the whole workspace must be present at install time and there
# is no separate engine build step.

# ---- build stage ----
FROM node:22-alpine AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare pnpm@9.15.6 --activate
WORKDIR /app

# Install against the full workspace, then build only the play package.
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @wickedways/play build

# ---- serve stage ----
FROM nginx:alpine AS serve
COPY packages/play/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/packages/play/dist /usr/share/nginx/html
EXPOSE 80
# nginx:alpine's default CMD already runs `nginx -g 'daemon off;'`.
