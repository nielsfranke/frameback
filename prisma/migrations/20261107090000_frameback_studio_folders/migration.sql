-- Frameback S2b-1: studio folders, undoable move batches, per-user read state. Additive.
BEGIN;

CREATE TABLE "Folder" (
    "id"        TEXT NOT NULL,
    "name"      TEXT NOT NULL,
    "parentId"  TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Folder_pkey" PRIMARY KEY ("id"),
    -- one level for now; nesting needs cycle/depth checks under lock first
    CONSTRAINT "Folder_single_level" CHECK ("parentId" IS NULL),
    CONSTRAINT "Folder_name_not_blank" CHECK (length(btrim("name")) > 0)
);
CREATE INDEX "Folder_parentId_idx" ON "Folder"("parentId");
ALTER TABLE "Folder" ADD CONSTRAINT "Folder_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Folder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Project" ADD COLUMN "folderId" TEXT;
ALTER TABLE "Project" ADD COLUMN "folderChangedAt" TIMESTAMP(3);
CREATE INDEX "Project_folderId_idx" ON "Project"("folderId");
ALTER TABLE "Project" ADD CONSTRAINT "Project_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "Folder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "FolderMoveBatch" (
    "id"               TEXT NOT NULL,
    "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "undoneAt"         TIMESTAMP(3),
    "createdFolderIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "actorUserId"      TEXT,
    CONSTRAINT "FolderMoveBatch_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "FolderMoveItem" (
    "batchId"      TEXT NOT NULL,
    "projectId"    TEXT NOT NULL,
    "prevFolderId" TEXT,
    "newFolderId"  TEXT,
    CONSTRAINT "FolderMoveItem_pkey" PRIMARY KEY ("batchId", "projectId")
);
CREATE INDEX "FolderMoveItem_projectId_idx" ON "FolderMoveItem"("projectId");
ALTER TABLE "FolderMoveItem" ADD CONSTRAINT "FolderMoveItem_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "FolderMoveBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FolderMoveItem" ADD CONSTRAINT "FolderMoveItem_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Existing feedback counts as read: the baseline is the moment this ships
ALTER TABLE "User" ADD COLUMN "feedbackSeenBaseline" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE TABLE "StudioCommentSeen" (
    "userId"    TEXT NOT NULL,
    "commentId" TEXT NOT NULL,
    "seenAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StudioCommentSeen_pkey" PRIMARY KEY ("userId", "commentId")
);
CREATE INDEX "StudioCommentSeen_commentId_idx" ON "StudioCommentSeen"("commentId");
ALTER TABLE "StudioCommentSeen" ADD CONSTRAINT "StudioCommentSeen_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StudioCommentSeen" ADD CONSTRAINT "StudioCommentSeen_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES "Comment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
