-- Frameback: previous versions of edited comments (clients edit by name, no accounts).
-- Additive only; hand-written (upstream drift left untouched).
BEGIN;

CREATE TABLE "CommentRevision" (
    "id"         TEXT NOT NULL,
    "commentId"  TEXT NOT NULL,
    "content"    TEXT NOT NULL,
    "editedBy"   TEXT NOT NULL,
    "editorName" TEXT,
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CommentRevision_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "CommentRevision_commentId_idx" ON "CommentRevision"("commentId");
ALTER TABLE "CommentRevision" ADD CONSTRAINT "CommentRevision_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES "Comment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
