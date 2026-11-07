import { RGADocument } from '@crdt-engine/rga/RGADocument';
import { VectorClock } from '@crdt-engine/clocks/VectorClock';
import { CausalBuffer } from '@crdt-engine/clocks/CausalBuffer';
import { TombstoneGC } from '@crdt-engine/rga/TombstoneGC';
import type { RGAOperation, RGAInsert, RGADelete } from '@crdt-engine/types';

export class Peer {
  readonly siteId: string;
  readonly doc: RGADocument;
  readonly clock: VectorClock;
  readonly buffer: CausalBuffer;
  readonly gc: TombstoneGC;
  readonly outbox: RGAOperation[] = [];

  constructor(siteId: string) {
    this.siteId = siteId;
    this.doc = new RGADocument(siteId);
    this.clock = new VectorClock();
    this.buffer = new CausalBuffer(this.clock);
    this.gc = new TombstoneGC();
  }

  /** Insert a single character at a visible offset */
  insertAt(offset: number, char: string): RGAInsert {
    const afterId = this.doc.getAfterIdForOffset(offset);
    const clockSnap = this.clock.snapshot();
    const op = this.doc.localInsert(afterId, char, clockSnap);
    this.clock.increment(this.siteId);
    this.outbox.push(op);
    return op;
  }

  /** Delete the character at a visible offset */
  deleteAt(offset: number): RGADelete | null {
    const nodeId = this.doc.getNodeIdAtOffset(offset);
    if (!nodeId) return null;
    const clockSnap = this.clock.snapshot();
    const op = this.doc.localDelete(nodeId, clockSnap);
    this.clock.increment(this.siteId);
    this.outbox.push(op);
    return op;
  }

  /** Receive a remote op into the causal buffer */
  receive(op: RGAOperation): void {
    this.buffer.receive(op);
  }

  /** Drain causal buffer and apply all ready ops. Returns count applied. */
  applyReady(): number {
    const ready = this.buffer.drain();
    for (const op of ready) {
      if (op.type === 'insert') this.doc.applyInsert(op);
      else this.doc.applyDelete(op);
    }
    return ready.length;
  }

  /** Current visible text */
  get text(): string {
    return this.doc.toVisibleString();
  }

  /** Number of pending ops in the causal buffer */
  get pendingCount(): number {
    return this.buffer.pendingCount();
  }
}
