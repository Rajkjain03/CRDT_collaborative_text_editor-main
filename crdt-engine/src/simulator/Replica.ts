import {
  SiteId,
  RGAOperation,
  RGAInsert,
  RGADelete,
  VectorClockSnapshot,
} from "../types";
import { RGADocument } from "../rga/RGADocument";
import { TombstoneGC } from "../rga/TombstoneGC";
import { VectorClock } from "../clocks/VectorClock";
import { CausalBuffer } from "../clocks/CausalBuffer";
import { LWWRegister, LWWState } from "../lww/LWWRegister";

/**
 * Replica — a single participant in the collaborative session.
 *
 * Composes all Phase 1 components into one coherent unit:
 *   RGADocument   — document body (character linked list)
 *   TombstoneGC   — cleans up deleted nodes
 *   VectorClock   — causal clock for this site
 *   CausalBuffer  — holds out-of-order remote ops until dependencies arrive
 *   LWWRegister   — metadata (title, presence, roles)
 *
 * Used by NetworkSim (Phase 1) and by ClientSync (Phase 2). In Phase 2,
 * ClientSync passes the sender's siteId to receive() so that CausalBuffer
 * can advance the vector clock correctly for delete ops (which do not embed
 * the sender identity in the op itself).
 *
 * ── Correct local op sequence ────────────────────────────────────────────────
 *   1. clock.snapshot()  → attach to op as op.clock (BEFORE incrementing)
 *   2. doc.localInsert / localDelete  → generates + applies op locally
 *   3. clock.increment(siteId)  → advance clock AFTER generating
 *   The Replica encapsulates this sequence so callers cannot get it wrong.
 *
 * ── Correct remote op sequence ───────────────────────────────────────────────
 *   1. buffer.receive(op, senderSiteId?)  → enqueue with optional sender identity
 *   2. buffer.drain()  → returns ops whose dependencies are satisfied
 *   3. For each drained op: doc.applyInsert / applyDelete
 *      (CausalBuffer already incremented the clock internally during drain)
 *   The Replica encapsulates this too via receive().
 */
export class Replica {
  readonly siteId: SiteId;

  readonly doc: RGADocument;
  readonly lww: LWWRegister<unknown>;
  readonly gc: TombstoneGC;

  private clock: VectorClock;
  private buffer: CausalBuffer;

  /** Ops generated locally that have not yet been "broadcast" — drained by NetworkSim. */
  private outbox: RGAOperation[];

  constructor(siteId: SiteId) {
    this.siteId = siteId;
    this.clock = new VectorClock();
    this.buffer = new CausalBuffer(this.clock);
    this.doc = new RGADocument(siteId);
    this.gc = new TombstoneGC();
    this.lww = new LWWRegister();
    this.outbox = [];
  }

  // ─── Local operations ─────────────────────────────────────────────────────

  /**
   * Insert a character at the given cursor offset.
   *
   * Encapsulates the clock snapshot → generate → increment sequence.
   * The returned op is also placed in the outbox for NetworkSim to collect.
   *
   * @param offset  0-based visible character offset. 0 = insert at head.
   * @param value   Single character to insert.
   * @returns       The RGAInsert broadcast-ready operation.
   */
  insert(offset: number, value: string): RGAInsert {
    const clockSnap = this.clock.snapshot();
    const afterId = this.doc.getAfterIdForOffset(offset);
    const op = this.doc.localInsert(afterId, value, clockSnap);
    this.clock.increment(this.siteId);
    this.outbox.push(op);
    return op;
  }

  /**
   * Delete the character at the given cursor offset.
   *
   * @param offset  0-based visible character offset.
   * @returns       The RGADelete operation, or null if offset is out of range.
   */
  delete(offset: number): RGADelete | null {
    const nodeId = this.doc.getNodeIdAtOffset(offset);
    if (!nodeId) return null;

    const clockSnap = this.clock.snapshot();
    const op = this.doc.localDelete(nodeId, clockSnap);
    this.clock.increment(this.siteId);
    this.outbox.push(op);

    // Record self-acknowledgement for GC
    this.gc.acknowledge(nodeId, this.siteId);

    return op;
  }

  // ─── Remote operations ────────────────────────────────────────────────────

  /**
   * Accept an incoming operation from the network.
   * Enqueues it in the causal buffer and immediately attempts to drain.
   * Any operations whose dependencies are satisfied are applied to the doc.
   *
   * @param op            The received RGAOperation.
   * @param senderSiteId  Identity of the sending site. Required for delete ops
   *                      so CausalBuffer can advance the vector clock correctly.
   *                      Omit only in simulator paths where all ops are same-site.
   * @returns             The list of operations actually applied (in delivery order).
   */
  receive(op: RGAOperation, senderSiteId?: SiteId): RGAOperation[] {
    this.buffer.receive(op, senderSiteId);
    return this._drain();
  }

  /**
   * Receive multiple ops at once (e.g. on relay log replay or reconnection flush).
   * All ops are enqueued before draining, so a later op in the batch can satisfy
   * the causal dependency of an earlier one in the same batch.
   *
   * @param ops           Batch of incoming operations (all from the same sender).
   * @param senderSiteId  Identity of the sending site. Same requirement as receive().
   * @returns             All operations actually applied, in delivery order.
   */
  receiveBatch(ops: RGAOperation[], senderSiteId?: SiteId): RGAOperation[] {
    for (const op of ops) this.buffer.receive(op, senderSiteId);
    return this._drain();
  }

  private _drain(): RGAOperation[] {
    const ready = this.buffer.drain();
    for (const op of ready) {
      if (op.type === "insert") {
        this.doc.applyInsert(op);
      } else {
        this.doc.applyDelete(op);
        // Record ack for GC — this site has now applied the delete
        this.gc.acknowledge(op.targetId, this.siteId);
      }
    }
    return ready;
  }

  // ─── LWW metadata ─────────────────────────────────────────────────────────

  /**
   * Set a metadata field locally (title, role, presence, etc.).
   * Returns an LWWUpdate for broadcast.
   */
  setMeta(field: string, value: unknown, timestamp = Date.now()) {
    return this.lww.set(field, value, timestamp, this.siteId);
  }

  /**
   * Merge a received LWW state snapshot.
   * Returns the list of fields that changed locally.
   */
  mergeMeta(state: LWWState<unknown>) {
    return this.lww.merge(state);
  }

  // ─── GC ───────────────────────────────────────────────────────────────────

  /**
   * Record that a remote site has applied a delete op (GC ack).
   * Called by NetworkSim after confirming delivery.
   */
  gcAck(nodeId: Parameters<TombstoneGC["acknowledge"]>[0], fromSite: SiteId) {
    this.gc.acknowledge(nodeId, fromSite);
  }

  /**
   * Run tombstone GC. Returns pruned NodeIds.
   * Call periodically — NetworkSim calls this after each round of delivery.
   */
  runGC(): ReturnType<TombstoneGC["collect"]> {
    return this.gc.collect(this.doc);
  }

  // ─── Outbox ───────────────────────────────────────────────────────────────

  /**
   * Drain the outbox. NetworkSim calls this to collect locally-generated
   * ops for delivery to other replicas.
   */
  drainOutbox(): RGAOperation[] {
    const ops = this.outbox.slice();
    this.outbox = [];
    return ops;
  }

  // ─── Reads ────────────────────────────────────────────────────────────────

  getText(): string {
    return this.doc.toVisibleString();
  }

  getLength(): number {
    return this.doc.getVisibleLength();
  }

  getPendingCount(): number {
    return this.buffer.pendingCount();
  }

  getClockSnapshot(): VectorClockSnapshot {
    return this.clock.snapshot();
  }
}
