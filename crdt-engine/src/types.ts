/**
 * crdt-engine/src/types.ts — Shared type definitions for the RGA CRDT engine.
 *
 * All types here are pure data shapes with no methods. They flow between
 * RGADocument, VectorClock, CausalBuffer, Replica, and the Phase 2 wire
 * protocol without modification.
 */

// ─── Primitive identifiers ────────────────────────────────────────────────────

/** 128-bit random UUID string, e.g. "a3f2c1d0-...". One per client session. */
export type SiteId = string;

/**
 * Globally unique identity for a single character node in the RGA list.
 * Uniqueness guarantee: no two nodes ever share both siteId and counter.
 *
 * `counter` is RGADocument's per-site insert-only Lamport counter.
 * It counts only insert operations, so it diverges from the VectorClock
 * counter (which counts all operations including deletes) once any delete
 * has been issued by this site. Do not use NodeId.counter to advance a
 * VectorClock — use op.clock[senderSiteId] + 1 instead.
 */
export type NodeId = {
  readonly siteId: SiteId;
  readonly counter: number;
};

// ─── Vector clock ─────────────────────────────────────────────────────────────

/**
 * Immutable snapshot of a vector clock at a point in time.
 * clock[siteId] = number of operations (inserts + deletes) this site has
 * delivered from siteId. Missing entries are treated as 0.
 */
export type VectorClockSnapshot = Readonly<Record<SiteId, number>>;

// ─── RGA operations ───────────────────────────────────────────────────────────

/**
 * Insert a single character into the RGA document.
 * `afterId` = null means insert at the document head.
 * `clock` = the sender's vector clock snapshot taken BEFORE this operation
 * was generated (i.e. before the sender incremented its own counter).
 */
export type RGAInsert = {
  readonly type: "insert";
  readonly nodeId: NodeId;
  readonly afterId: NodeId | null;
  readonly value: string;
  readonly clock: VectorClockSnapshot;
};

/**
 * Soft-delete a character (tombstone). The node remains in the linked list
 * so that any insert using it as `afterId` still resolves correctly.
 * `clock` follows the same snapshot-before-increment convention as RGAInsert.
 */
export type RGADelete = {
  readonly type: "delete";
  readonly targetId: NodeId;
  readonly clock: VectorClockSnapshot;
};

export type RGAOperation = RGAInsert | RGADelete;

// ─── LWW types ────────────────────────────────────────────────────────────────

/**
 * A single field update produced by LWWRegister.set() or merge().
 * Carries the winning value, the timestamp used for tie-breaking, and the
 * siteId for a second-level tie-break (higher siteId wins).
 */
export type LWWUpdate<T> = {
  type: "lww_update";
  field: string;
  value: T;
  timestamp: number;  // Unix ms
  siteId: SiteId;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Canonical string key for a NodeId, used as Map/Set keys. */
export function nodeKey(id: NodeId): string {
  return `${id.siteId}:${id.counter}`;
}

/** True if a and b refer to the same logical node. */
export function nodeIdEqual(a: NodeId | null, b: NodeId | null): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return a.siteId === b.siteId && a.counter === b.counter;
}
