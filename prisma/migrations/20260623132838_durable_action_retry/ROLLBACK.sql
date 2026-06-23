-- 手动回滚 durable_action_retry（Prisma 不生成 down-migration）。
-- **在回退应用代码之前运行。** 丢弃 mail_actions_active_uniq 是**必须**的：旧版 recordAction
-- 做无条件 INSERT，一旦写入第二条活跃行就会撞 P2002（活跃唯一约束）。
-- 两列 retryCount/nextRetryAt 可空/有默认、旧代码无视，保留即可（无需回滚列）。
DROP INDEX IF EXISTS "mail_actions_active_uniq";
DROP INDEX IF EXISTS "mail_actions_due_retry_idx";
DROP INDEX IF EXISTS "mail_classifications_messageId_createdAt_idx";
