-- Frameback: nested studio folders + "Abgeschlossen" (done) for projects. Additive.
-- Cycle and depth checks for nesting run in src/lib/folders.ts under a tree-wide lock.
BEGIN;
ALTER TABLE "Folder" DROP CONSTRAINT "Folder_single_level";
ALTER TABLE "Folder" ADD CONSTRAINT "Folder_not_own_parent" CHECK ("parentId" IS NULL OR "parentId" <> "id");
ALTER TABLE "Project" ADD COLUMN "completedAt" TIMESTAMP(3);
COMMIT;
