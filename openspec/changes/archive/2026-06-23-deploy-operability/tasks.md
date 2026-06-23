## 1. reload 命令

- [x] 1.1 在 `package.json` 增加 pnpm 脚本 `reload`，执行 `docker compose up -d --force-recreate`（不带服务名，使 `POSTGRES_HOST_PORT` 等 postgres 服务的端口映射改动也被一并重新应用）

## 2. 部署 runbook

- [x] 2.1 编写部署 runbook（`docs/DEPLOY.md` 或 README 章节）：三类配置生效语义（DB 形态重启生效 / env 形态需重建 / 文件形态热加载），并区分 `RULES_FILE` 路径覆盖（env 形态、需重建）与 `rules.yaml` 内容（文件形态、实时）；三条操作轴（镜像变更需 `build` / env 变更需 `reload` / 文件配置实时，均为操作命令；并单列一行说明 DB-config 载体经 CLI add/disable 在进程重启时生效、与三轴正交）；`POSTGRES_HOST_PORT` / `APP_HOST_PORT` 端口覆盖；远程 DB 的 ssh 隧道一行命令（far-end 端口绑定 `POSTGRES_HOST_PORT`，不硬编码 5432）；`reload`/recreate 重跑 `prisma migrate deploy` 的幂等性（已应用迁移经 `_prisma_migrations` 跳过）；`reload`/recreate 不触碰 `./data/postgres` 数据卷；坏挂载处置（宿主缺 `./rules/rules.yaml` 时空目录遮蔽烘焙拷贝 → carry-forward；纯镜像部署应移除该 volume 行回落到烘焙拷贝）；`reload` 不带服务名一并重建 postgres、要等 `service_healthy` 健康门（数十秒 app 间隙），并记 `up -d --force-recreate inbox-pilot` 仅重建 app 的进阶轻量捷径（限不触及 `POSTGRES_HOST_PORT` 的 env 改动）；重部署与校验顺序
- [x] 2.2 在 README 补全 `APP_HOST_PORT` 文档（`POSTGRES_HOST_PORT` 已有）

## 3. 运行时镜像

- [x] 3.1 Dockerfile build 阶段在 `prisma generate` 之前安装 `openssl`（`ca-certificates` 视需保留，理由为出站 HTTPS 根证书）
- [x] 3.2 Dockerfile run 阶段在 entrypoint 之前安装 `openssl`（+ 视需 `ca-certificates`）
- [ ] 3.3 重建镜像并确认 build 日志（`prisma generate` 阶段）与运行时启动日志均无 Prisma openssl / libssl 探测告警

## 4. 时区显式化与回退告警

- [x] 4.1 核验 `.env.example` 已有的 `TZ=Asia/Shanghai` 条目与注释（已存在，仅核验）
- [x] 4.2 在时区解析代码路径使用 `process.env.TZ || 'Asia/Shanghai'`（用 `||`，空字符串也回退），并在回退时发出一次性 `kind: 'tz-fallback-default'` 告警
- [x] 4.3 移除 docker-compose 的 `TZ: ${TZ:-Asia/Shanghai}` 默认注入，compose 仅从 `.env` 透传 `TZ`，使未设置 / 为空的 `TZ` 抵达应用回退分支、告警可观测
- [x] 4.4 新增单元测试：断言空字符串 `TZ` 解析为 `Asia/Shanghai` 且发出 `tz-fallback-default` 告警（钉死 `'' ?? x` 与 `'' || x` 的正确性边界；以 `src/digest/digestScheduler.test.ts` 为模型）

## 5. 容器内 rules.yaml 可达性

- [x] 5.1 核验 docker-compose 已有的 `./rules:/app/rules:ro` bind-mount（已存在，仅核验：默认规则存在且可宿主编辑，mtime 热加载实时；挂载目标 `/app/rules` 与 `dist/rules/` 经 `import.meta.url` 解析的路径对齐）
- [x] 5.2 Dockerfile run 阶段 `COPY rules ./rules` 烘焙镜像内拷贝作为无挂载兜底（净新增工作）
- [ ] 5.3 确认容器启动日志无 `rules-config-load-failed`，规则按 `rules.yaml` 加载而非 carry-forward 默认

## 6. 验证

- [ ] 6.1 改 `DIGEST_TIMES` → 执行 `pnpm run reload` → 确认新的 `taskCount` 生效；build + 运行时两处日志均无 openssl 告警；不设 / 置空 `TZ` 时触发 `tz-fallback-default` 告警、`TZ` 已设置时不触发；启动无 `rules-config-load-failed`
