-- Frameback: durable opt-out from reply mails per project + address. Additive.
BEGIN;
CREATE TABLE "ReplyMailOptOut" (
    "id"        TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "email"     TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ReplyMailOptOut_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ReplyMailOptOut_projectId_email_key" ON "ReplyMailOptOut"("projectId", "email");
ALTER TABLE "ReplyMailOptOut" ADD CONSTRAINT "ReplyMailOptOut_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
COMMIT;
