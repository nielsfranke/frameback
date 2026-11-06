-- Frameback S2b-2: remembered decisions on duplicate client suggestions. Additive.
BEGIN;
CREATE TABLE "ClientMergeDecision" (
    "aId"       TEXT NOT NULL,
    "bId"       TEXT NOT NULL,
    "decision"  TEXT NOT NULL,
    "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ClientMergeDecision_pkey" PRIMARY KEY ("aId", "bId"),
    CONSTRAINT "ClientMergeDecision_ordered" CHECK ("aId" < "bId"),
    CONSTRAINT "ClientMergeDecision_kind" CHECK ("decision" IN ('MERGED', 'KEEP_SEPARATE'))
);
COMMIT;
