-- Frameback: optional "email me when the studio replies" per client comment. Additive.
ALTER TABLE "Comment" ADD COLUMN "notifyReplies" BOOLEAN NOT NULL DEFAULT false;
