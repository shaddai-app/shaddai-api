# syntax=docker/dockerfile:1
# Imágenes de la API, sobre Node 24 en Debian:
# - runtime: la API (node dist/server.js), sin dependencias de desarrollo y con usuario sin privilegios.
# - migrator: aplica las migraciones y el seed (idempotente). Corre como job antes de cada deploy, con
#   el login SQL de migración (el de la app no puede cambiar el esquema).
ARG NODE_IMAGE=node:24-bookworm-slim

# Dependencias completas + cliente Prisma generado (postinstall). husky solo sirve en desarrollo.
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json prisma.config.ts ./
COPY prisma ./prisma
RUN npm pkg delete scripts.prepare && npm ci --no-audit --no-fund

FROM deps AS build
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM deps AS migrator
ENV NODE_ENV=production
COPY tsconfig.json ./
COPY src ./src
USER node
CMD ["sh", "-c", "npm run db:deploy && npm run db:seed"]

# Solo dependencias de producción (el cliente Prisma ya compilado viene en dist/generated).
FROM ${NODE_IMAGE} AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm pkg delete scripts.prepare scripts.postinstall && npm ci --omit=dev --no-audit --no-fund

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/v1/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/server.js"]
