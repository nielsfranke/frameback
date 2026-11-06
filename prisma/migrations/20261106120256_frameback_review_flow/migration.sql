-- Frameback review flow (docs/redesign/PLAN.md §3.2–3.4)
--
-- Additive only. Hand-written on purpose: `prisma migrate dev` also proposed
-- unrelated drift changes from upstream (dropping Video_status_idx, defaults,
-- a re-created ProjectUpload FK). Those belong to upstream and are NOT touched here.
-- Runs in ONE transaction (explicit BEGIN/COMMIT): a failed check leaves no partial DDL.
-- No notifications are triggered by SQL.

BEGIN;

-- Pre-checks (before any DDL) ---------------------------------------------------
-- Abort if two versions of the same video share a version number or a video has more
-- than one approved version: groups must be clean before the unique indexes below.
DO $$
DECLARE dup INTEGER;
BEGIN
  SELECT count(*) INTO dup FROM (
    SELECT 1 FROM "Video" GROUP BY "projectId", "name", "version" HAVING count(*) > 1
  ) d;
  IF dup > 0 THEN
    RAISE EXCEPTION 'Frameback backfill: % duplicate (projectId, name, version) combinations – resolve before migrating', dup;
  END IF;
END $$;
DO $$
DECLARE multi INTEGER;
BEGIN
  SELECT count(*) INTO multi FROM (
    SELECT 1 FROM "Video" WHERE "approved" GROUP BY "projectId", "name" HAVING count(*) > 1
  ) d;
  IF multi > 0 THEN
    RAISE EXCEPTION 'Frameback backfill: % videos with several approved versions – resolve before migrating', multi;
  END IF;
END $$;

-- Enums --------------------------------------------------------------------
CREATE TYPE "ReviewState" AS ENUM ('DRAFT', 'IN_REVIEW', 'CHANGES_REQUESTED', 'APPROVED');
CREATE TYPE "ReviewOutcome" AS ENUM ('APPROVED', 'CHANGES_REQUESTED', 'WITHDRAWN', 'SUPERSEDED');
CREATE TYPE "DecisionKind" AS ENUM ('APPROVE', 'REQUEST_CHANGES', 'REVOKE', 'ADMIN_OVERRIDE', 'SENT_FOR_REVIEW', 'WITHDRAWN');
CREATE TYPE "ApprovalRule" AS ENUM ('ANY', 'ALL');

-- Comment: editing, soft delete, ownership, resolve status, frame accuracy ---
ALTER TABLE "Comment"
  ADD COLUMN "editedAt"      TIMESTAMP(3),
  ADD COLUMN "deletedAt"     TIMESTAMP(3),
  ADD COLUMN "deletedBy"     TEXT,
  ADD COLUMN "authorKeyHash" TEXT,
  ADD COLUMN "verifiedEmail" TEXT,
  ADD COLUMN "resolvedAt"    TIMESTAMP(3),
  ADD COLUMN "resolvedById"  TEXT,
  ADD COLUMN "resolvedVia"   TEXT,
  ADD COLUMN "frame"         INTEGER,
  ADD COLUMN "frameEnd"      INTEGER,
  ADD COLUMN "fpsNum"        INTEGER,
  ADD COLUMN "fpsDen"        INTEGER;

-- Video: group, review state, version note ---------------------------------
ALTER TABLE "Video"
  ADD COLUMN "groupId"     TEXT,
  ADD COLUMN "reviewState" "ReviewState" NOT NULL DEFAULT 'DRAFT',
  ADD COLUMN "versionNote" TEXT;

-- New tables -----------------------------------------------------------------
CREATE TABLE "VideoGroup" (
    "id"        TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name"      TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "VideoGroup_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ReviewRequest" (
    "id"            TEXT NOT NULL,
    "groupId"       TEXT NOT NULL,
    "videoId"       TEXT NOT NULL,
    "requestedById" TEXT,
    "requestedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rule"          "ApprovalRule" NOT NULL DEFAULT 'ANY',
    "closedAt"      TIMESTAMP(3),
    "outcome"       "ReviewOutcome",
    CONSTRAINT "ReviewRequest_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ReviewDecision" (
    "id"             TEXT NOT NULL,
    "requestId"      TEXT,
    "videoId"        TEXT NOT NULL,
    "kind"           "DecisionKind" NOT NULL,
    "actorName"      TEXT NOT NULL,
    "verifiedEmail"  TEXT,
    "viewerKeyHash"  TEXT,
    "adminUserId"    TEXT,
    "note"           TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "ip"             TEXT,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ReviewDecision_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ReviewDecisionComment" (
    "decisionId"   TEXT NOT NULL,
    "commentId"    TEXT NOT NULL,
    "textSnapshot" TEXT NOT NULL,
    CONSTRAINT "ReviewDecisionComment_pkey" PRIMARY KEY ("decisionId", "commentId")
);

-- Indexes ----------------------------------------------------------------------
CREATE UNIQUE INDEX "VideoGroup_projectId_name_key" ON "VideoGroup"("projectId", "name");
CREATE INDEX "ReviewRequest_groupId_idx" ON "ReviewRequest"("groupId");
CREATE INDEX "ReviewRequest_videoId_idx" ON "ReviewRequest"("videoId");
CREATE UNIQUE INDEX "ReviewDecision_idempotencyKey_key" ON "ReviewDecision"("idempotencyKey");
CREATE INDEX "ReviewDecision_videoId_idx" ON "ReviewDecision"("videoId");
CREATE INDEX "ReviewDecision_requestId_idx" ON "ReviewDecision"("requestId");
-- At most one open approval round per group (not expressible in the Prisma schema)
CREATE UNIQUE INDEX "ReviewRequest_one_open_per_group" ON "ReviewRequest"("groupId") WHERE "closedAt" IS NULL;

-- Foreign keys -------------------------------------------------------------------
ALTER TABLE "Video" ADD CONSTRAINT "Video_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "VideoGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VideoGroup" ADD CONSTRAINT "VideoGroup_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReviewRequest" ADD CONSTRAINT "ReviewRequest_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "VideoGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReviewRequest" ADD CONSTRAINT "ReviewRequest_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReviewDecision" ADD CONSTRAINT "ReviewDecision_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "ReviewRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ReviewDecision" ADD CONSTRAINT "ReviewDecision_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReviewDecisionComment" ADD CONSTRAINT "ReviewDecisionComment_decisionId_fkey" FOREIGN KEY ("decisionId") REFERENCES "ReviewDecision"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill ---------------------------------------------------------------------------
-- Abort if two versions of the same video share a version number: groups must be clean
-- before (groupId, version) can become unique. Resolve manually, then re-run.


-- 1. One group per (projectId, name); ordered by first upload
INSERT INTO "VideoGroup" ("id", "projectId", "name", "sortOrder", "createdAt", "updatedAt")
SELECT 'vg_' || md5(v."projectId" || chr(31) || v."name"),
       v."projectId",
       v."name",
       (row_number() OVER (PARTITION BY v."projectId" ORDER BY min(v."createdAt")) - 1)::int,
       min(v."createdAt"),
       CURRENT_TIMESTAMP
FROM "Video" v
GROUP BY v."projectId", v."name"
ON CONFLICT ("projectId", "name") DO NOTHING;

UPDATE "Video" v
   SET "groupId" = g."id"
  FROM "VideoGroup" g
 WHERE g."projectId" = v."projectId" AND g."name" = v."name" AND v."groupId" IS NULL;

-- 2. Approved versions become APPROVED, with a historic audit entry (no invented person)
UPDATE "Video" SET "reviewState" = 'APPROVED' WHERE "approved" = true AND "reviewState" = 'DRAFT';

INSERT INTO "ReviewDecision" ("id", "requestId", "videoId", "kind", "actorName", "idempotencyKey", "createdAt")
SELECT 'rd_mig_' || v."id", NULL, v."id", 'ADMIN_OVERRIDE', 'Migration', 'migration:' || v."id", COALESCE(v."approvedAt", v."updatedAt")
FROM "Video" v
WHERE v."approved" = true
ON CONFLICT ("idempotencyKey") DO NOTHING;

-- Make the backfill result explicit in the migration log
DO $$
DECLARE ungrouped INTEGER;
BEGIN
  SELECT count(*) INTO ungrouped FROM "Video" WHERE "groupId" IS NULL;
  IF ungrouped > 0 THEN
    RAISE EXCEPTION 'Frameback backfill: % videos without group', ungrouped;
  END IF;
END $$;

-- Enforce the invariants now that every video has a group ------------------------
ALTER TABLE "Video" ALTER COLUMN "groupId" SET NOT NULL;
CREATE UNIQUE INDEX "Video_groupId_version_key" ON "Video"("groupId", "version");
-- At most one approved version per group (legacy invariant, now enforced)
CREATE UNIQUE INDEX "Video_one_approved_per_group" ON "Video"("groupId") WHERE "approved";

COMMIT;
