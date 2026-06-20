-- CreateTable
CREATE TABLE "mail_accounts" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "authJson" JSONB NOT NULL,
    "lastSyncCursor" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mail_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mail_messages" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "providerMessageId" TEXT NOT NULL,
    "messageId" TEXT,
    "threadId" TEXT,
    "uid" INTEGER,
    "subject" TEXT NOT NULL,
    "fromEmail" TEXT NOT NULL,
    "fromName" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "snippet" TEXT,
    "bodyText" TEXT,
    "bodyHash" TEXT,
    "hasAttachments" BOOLEAN NOT NULL DEFAULT false,
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mail_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mail_classifications" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "priority" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "reason" TEXT NOT NULL,
    "rawAiJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mail_classifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mail_actions" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "actionType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mail_actions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "digest_items" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "digestType" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "digest_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "mail_messages_accountId_providerMessageId_key" ON "mail_messages"("accountId", "providerMessageId");

-- AddForeignKey
ALTER TABLE "mail_messages" ADD CONSTRAINT "mail_messages_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "mail_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mail_classifications" ADD CONSTRAINT "mail_classifications_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "mail_messages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mail_actions" ADD CONSTRAINT "mail_actions_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "mail_messages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "digest_items" ADD CONSTRAINT "digest_items_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "mail_messages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
