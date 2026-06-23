-- durable-retry（决策 2/4/5/6）：mail_actions 加 retryCount/nextRetryAt 列 + 三索引（含两 partial）。
-- PG16：可空 nextRetryAt = 元数据级 ADD COLUMN（无重写）；retryCount Int DEFAULT 0 NOT NULL 用常量默认
-- = PG11+ 元数据级、无全表回填——既有行兼容（retryCount=0、nextRetryAt=null；drain 只选 status='retrying'）。

-- AlterTable
ALTER TABLE "mail_actions" ADD COLUMN     "nextRetryAt" TIMESTAMP(3),
ADD COLUMN     "retryCount" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
-- 重建「最新分类」（决策 5/6）：FK 现无索引、否则每条 seq scan；createdAt 降序覆盖 [createdAt desc] 排序前缀。
CREATE INDEX "mail_classifications_messageId_createdAt_idx" ON "mail_classifications"("messageId", "createdAt" DESC);

-- CreateIndex（raw SQL，Prisma schema 无法表达 partial index）
-- 活跃行唯一性（决策 4）：同一 (messageId, actionType) 任意时刻至多一条**活跃**行（pending/retrying）；
-- 终态行（done/failed/skipped/dead_letter）可多条、不受约束。配合 recordAction upsert 强制行粒度互补。
CREATE UNIQUE INDEX "mail_actions_active_uniq" ON "mail_actions" ("messageId", "actionType") WHERE status IN ('pending', 'retrying');

-- CreateIndex（raw SQL，partial）
-- drain 查询索引（决策 6）：selectDueRetries 每 poll 每账号跑一次（status='retrying' ∧ nextRetryAt≤now，
-- 按 nextRetryAt 升序）；partial WHERE status='retrying' 使索引不随终态行膨胀。
CREATE INDEX "mail_actions_due_retry_idx" ON "mail_actions" ("nextRetryAt") WHERE status = 'retrying';
