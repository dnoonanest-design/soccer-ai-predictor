FROM node:22-slim
WORKDIR /app
RUN npm i -g corepack@0.36.0 && corepack enable && corepack prepare pnpm@11.19.0 --activate
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm railway:build
CMD ["node", "--enable-source-maps", "api-server/dist/index.mjs"]
# Migrations run once per deploy via railway.toml preDeployCommand, not on every container start.
