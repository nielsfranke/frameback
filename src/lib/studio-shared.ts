/** Client-safe studio helpers (no database imports): shared by server and UI. */
export type GroupState = 'draft' | 'waiting' | 'changes' | 'approved'

/** State of a video group = state of its current (highest READY) version */
export function groupState(v: { reviewState: string | null; approved: boolean }): GroupState {
  if (v.reviewState === 'APPROVED' || v.approved) return 'approved'
  if (v.reviewState === 'IN_REVIEW') return 'waiting'
  if (v.reviewState === 'CHANGES_REQUESTED') return 'changes'
  return 'draft'
}
