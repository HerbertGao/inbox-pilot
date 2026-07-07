-- migration §1.3 / design D3：mail_messages 加 re-poll 计数列（死信门）。
-- PG16 元数据级 ADD COLUMN + 常量 DEFAULT（无表重写，既有行填 0；上线锁仅 ms）。
-- 应用（APPLY）需 live PostgreSQL —— 交由用户在自己环境跑 `prisma migrate deploy`，本变更不落库。
ALTER TABLE "mail_messages" ADD COLUMN "repollCount" INTEGER NOT NULL DEFAULT 0;
