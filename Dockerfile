FROM node:22-slim
WORKDIR /app
RUN npm i -g corepack@latest && corepack enable && corepack prepare pnpm@9.15.9 --activate
COPY . .
RUN pnpm install --frozen-lockfile --prod
CMD ["node", "--enable-source-maps", "api-server/dist/index.mjs"]
