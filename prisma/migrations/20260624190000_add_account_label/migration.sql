-- notification-mailbox-clarity（任务 1.1）：mail_accounts 加 label 展示别名列。
-- 可空 TEXT = PG16 元数据级 ADD COLUMN（无重写、无回填）——既有行兼容：label=NULL（渲染回落账号 email、行为改进）。
-- 手工撰写（非 migrate dev 生成）：仅此一行 ADD COLUMN，**不含**对 mail_actions 两个 partial index
-- （mail_actions_active_uniq / mail_actions_due_retry_idx）的 DROP——Prisma schema 表达不了 partial index，
-- migrate dev 自动生成时会误判 drift 写出 DROP；那两个索引必须保留（见 schema.prisma 注释）。

-- AlterTable
ALTER TABLE "mail_accounts" ADD COLUMN "label" TEXT;
