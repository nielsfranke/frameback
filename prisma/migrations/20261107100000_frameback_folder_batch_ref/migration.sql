-- Frameback S2b-1: which move batch last placed a project (exact undo check). Additive.
BEGIN;
ALTER TABLE "Project" ADD COLUMN "folderBatchId" TEXT;
COMMIT;
