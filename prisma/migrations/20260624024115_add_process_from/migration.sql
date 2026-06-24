-- onboarding-watermark（决策 1/4）：mail_accounts 加 processFrom 水位线列。
-- 可空 TIMESTAMP(3) = PG16 元数据级 ADD COLUMN（无重写、无回填）——既有行兼容：processFrom=NULL（不设下界、行为不变）。
-- 手工撰写（非 migrate dev 生成）：仅此一行 ADD COLUMN，**不含**对 mail_actions 两个 partial index
-- （mail_actions_active_uniq / mail_actions_due_retry_idx）的 DROP——Prisma schema 表达不了 partial index，
-- migrate dev 自动生成时会误判 drift 写出 DROP；那两个索引必须保留（见 schema.prisma 注释）。

-- AlterTable
ALTER TABLE "mail_accounts" ADD COLUMN "processFrom" TIMESTAMP(3);
