import type { RGAOperation } from '@crdt-engine/types';
import { Peer } from './Peer';

export type OpLogEntry = {
  id: number;
  from: string;
  to: string;
  opType: 'insert' | 'delete';
  char?: string;
  timestamp: number;
};

type PendingDelivery = {
  op: RGAOperation;
  from: string;
  to: string;
};

export class Scheduler {
  peers: Map<string, Peer> = new Map();
  private queue: PendingDelivery[] = [];
  private partitionedPeers: Set<string> = new Set();
  private logIdCounter = 0;
  opLog: OpLogEntry[] = [];

  addPeer(siteId: string): Peer {
    const peer = new Peer(siteId);
    this.peers.set(siteId, peer);
    // Register with all existing GCs
    for (const p of this.peers.values()) {
      for (const other of this.peers.values()) {
        p.gc.registerSite(other.siteId);
      }
    }
    return peer;
  }

  removePeer(siteId: string): void {
    this.peers.delete(siteId);
    this.partitionedPeers.delete(siteId);
    // Remove from GC registrations and pending queue
    for (const p of this.peers.values()) {
      p.gc.deregisterSite(siteId);
    }
    this.queue = this.queue.filter(m => m.from !== siteId && m.to !== siteId);
  }

  /** Partition a peer (block delivery to/from it) */
  partitionPeer(siteId: string): void {
    this.partitionedPeers.add(siteId);
  }

  /** Heal a partition */
  healPeer(siteId: string): void {
    this.partitionedPeers.delete(siteId);
  }

  isPartitioned(siteId: string): boolean {
    return this.partitionedPeers.has(siteId);
  }

  /** Collect outbox ops from all peers and enqueue for delivery */
  collectOutboxes(): void {
    for (const peer of this.peers.values()) {
      while (peer.outbox.length > 0) {
        const op = peer.outbox.shift()!;
        for (const target of this.peers.values()) {
          if (target.siteId === peer.siteId) continue;
          this.queue.push({
            op,
            from: peer.siteId,
            to: target.siteId,
          });
        }
      }
    }
  }

  /** Deliver all pending messages (skipping partitioned peers). Returns set of peers that received ops. */
  deliverAll(): Set<string> {
    const changed = new Set<string>();
    const stillPending: PendingDelivery[] = [];

    for (const msg of this.queue) {
      if (this.partitionedPeers.has(msg.from) || this.partitionedPeers.has(msg.to)) {
        stillPending.push(msg);
        continue;
      }
      const target = this.peers.get(msg.to);
      if (!target) continue;
      target.receive(msg.op);
      const applied = target.applyReady();
      if (applied > 0) {
        changed.add(msg.to);
      }

      // Log entry
      this.opLog.push({
        id: this.logIdCounter++,
        from: msg.from,
        to: msg.to,
        opType: msg.op.type === 'insert' ? 'insert' : 'delete',
        char: msg.op.type === 'insert' ? msg.op.value : undefined,
        timestamp: Date.now(),
      });
    }

    this.queue = stillPending;
    return changed;
  }

  /** Full sync cycle: collect + deliver */
  sync(): Set<string> {
    this.collectOutboxes();
    return this.deliverAll();
  }

  /** Number of messages waiting in the queue */
  get pendingMessageCount(): number {
    return this.queue.length;
  }

  /** Check convergence */
  checkConvergence(): { converged: boolean; texts: Record<string, string> } {
    const texts: Record<string, string> = {};
    for (const [id, peer] of this.peers) {
      texts[id] = peer.text;
    }
    const values = Object.values(texts);
    return {
      converged: values.length > 0 && new Set(values).size === 1,
      texts,
    };
  }
}
