# 多阶段构建：install → build → run。
# build 与 run 阶段同为 node:24-bookworm-slim flavor，避免 Prisma engine libc 不匹配。

# ── install：装全部依赖（含 devDep 的 prisma CLI），--ignore-scripts 避免 schema 拷入前触发 postinstall ──
FROM node:24-bookworm-slim AS install
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --ignore-scripts

# ── build：copy schema 后显式 prisma generate，再 copy src 并 tsc ──
FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY --from=install /app/node_modules ./node_modules
COPY package.json pnpm-lock.yaml ./
COPY prisma ./prisma
RUN pnpm exec prisma generate
COPY tsconfig.json ./
COPY src ./src
RUN pnpm exec tsc

# ── run：复用 build 的 node_modules（含 prisma CLI）+ dist + prisma（schema + migrations），不做 --prod 重装 ──
FROM node:24-bookworm-slim AS run
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY package.json ./
EXPOSE 3000
# 单条 shell 形式：set -e 使迁移失败即非零退出（crash-loop），exec 使信号直达 node。不加 until pg_isready。
ENTRYPOINT ["sh", "-c", "set -e; node_modules/.bin/prisma migrate deploy; exec node dist/main.js"]
