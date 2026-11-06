-- Frameback: approval flow per project + default for new projects. Additive.
-- Existing projects keep today's behaviour (clients may approve any version).
BEGIN;
ALTER TABLE "Project" ADD COLUMN "reviewFlow" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Settings" ADD COLUMN "defaultReviewFlow" BOOLEAN NOT NULL DEFAULT false;
COMMIT;
