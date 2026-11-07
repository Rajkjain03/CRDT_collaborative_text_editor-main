/**
 * OfflineQueue — IndexedDB-backed persistent op queue for offline editing.
 *
 * When the client loses connectivity, locally-generated operations go
 * into this queue instead of being sent immediately. On reconnect, the
 * queue is drained in order and each op is sent to the relay.
 *
 * ── Why IndexedDB and not localStorage? ──────────────────────────────────────
 *
 * localStorage is synchronous (blocks the main thread) and size-limited
 * (~5MB total per origin). IndexedDB is async, supports structured data,
 * and typical quotas are in hundreds of MB. For a text editor where a
 * user might type uninterrupted for an hour offline, IndexedDB is the
 * only sensible choice.
 *
 * ── Causal ordering ──────────────────────────────────────────────────────────
 *
 * Ops are enqueued in the order Replica generates them. Because Replica
 * increments its clock before placing each op in the outbox, the enqueue
 * order IS the causal order for this site. The autoIncrementing `seqNo`
 * key on the IndexedDB store preserves this order across getAll() calls.
 * No explicit sort needed on drain.
 *
 * ── Environment compatibility ────────────────────────────────────────────────
 *
 * In the browser, `indexedDB` is a global. In Node.js tests, pass
 * `fake-indexeddb` via the options argument.
 */

import type { RGAOperation } from "crdt-engine";

export interface OfflineQueueOptions {
  /** Custom IDBFactory (e.g. fake-indexeddb in Node.js tests). */
  indexedDBImpl?: IDBFactory;
}

/**
 * Record stored in IndexedDB. `seqNo` is the auto-incrementing primary
 * key — IndexedDB assigns it on put(). We use it both as a stable identity
 * for partial-flush resilience and as a natural ordering.
 */
interface QueuedOpRecord {
  seqNo?: number; // assigned by IndexedDB on put
  op: RGAOperation;
  enqueuedAt: number; // Unix ms — useful for diagnostics, not ordering
}

export class OfflineQueue {
  private readonly dbName: string;
  private readonly storeName = "offline_ops";
  private readonly idbFactory: IDBFactory;
  private db: IDBDatabase | null = null;

  constructor(siteId: string, options: OfflineQueueOptions = {}) {
    this.dbName = `collab-sync-queue-${siteId}`;

    const factory =
      options.indexedDBImpl ??
      (typeof globalThis !== "undefined" && "indexedDB" in globalThis
        ? (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB
        : null);

    if (!factory) {
      throw new Error(
        "OfflineQueue: no IndexedDB implementation available. " +
          "In Node.js tests, pass { indexedDBImpl: require('fake-indexeddb') }.",
      );
    }
    this.idbFactory = factory;
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  /**
   * Open the database and create the object store if needed.
   * Must be called before any other method. Idempotent.
   */
  open(): Promise<void> {
    if (this.db) return Promise.resolve();

    return new Promise((resolve, reject) => {
      const req = this.idbFactory.open(this.dbName, 1);

      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(this.storeName)) {
          db.createObjectStore(this.storeName, {
            keyPath: "seqNo",
            autoIncrement: true,
          });
        }
      };

      req.onsuccess = () => {
        this.db = req.result;
        resolve();
      };

      req.onerror = () =>
        reject(req.error ?? new Error("IndexedDB open failed"));
    });
  }

  /**
   * Persist an op to the end of the queue.
   * Returns the seqNo assigned by IndexedDB.
   */
  enqueue(op: RGAOperation): Promise<number> {
    const db = this.requireDb();

    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, "readwrite");
      const store = tx.objectStore(this.storeName);

      const record: QueuedOpRecord = { op, enqueuedAt: Date.now() };
      const req = store.add(record);

      req.onsuccess = () => resolve(req.result as number);
      req.onerror = () => reject(req.error ?? new Error("enqueue failed"));
    });
  }

  /**
   * Return all queued ops in insertion order, along with their seqNos.
   * Each returned { seqNo, op } can be sent individually; use clearUpTo(seqNo)
   * after each successful send to support partial flush.
   */
  getAll(): Promise<Array<{ seqNo: number; op: RGAOperation }>> {
    const db = this.requireDb();

    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, "readonly");
      const store = tx.objectStore(this.storeName);
      const req = store.getAll();

      req.onsuccess = () => {
        const records = req.result as QueuedOpRecord[];
        // IndexedDB getAll returns in key order (seqNo ascending) by default.
        // This is the enqueue order, which is causal order for this site.
        resolve(
          records.map((r) => ({
            seqNo: r.seqNo!,
            op: r.op,
          })),
        );
      };
      req.onerror = () => reject(req.error ?? new Error("getAll failed"));
    });
  }

  /**
   * Remove all ops with seqNo <= the given value.
   * Called after the relay confirms receipt of a batch, so partial flushes
   * do not cause re-delivery of already-acknowledged ops on next reconnect.
   */
  clearUpTo(seqNo: number): Promise<void> {
    const db = this.requireDb();

    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, "readwrite");
      const store = tx.objectStore(this.storeName);

      // IDBKeyRange.upperBound(seqNo) selects all keys ≤ seqNo
      const range = IDBKeyRange.upperBound(seqNo);
      const req = store.delete(range);

      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error ?? new Error("clearUpTo failed"));
    });
  }

  /** Remove all queued ops. Use only when explicitly resetting the session. */
  clear(): Promise<void> {
    const db = this.requireDb();

    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, "readwrite");
      const req = tx.objectStore(this.storeName).clear();

      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error ?? new Error("clear failed"));
    });
  }

  /** Number of ops currently in the queue. */
  size(): Promise<number> {
    const db = this.requireDb();

    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, "readonly");
      const req = tx.objectStore(this.storeName).count();

      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("count failed"));
    });
  }

  /** Close the underlying database. Further calls will throw until open() again. */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  // ─── Internal ─────────────────────────────────────────────────────────────

  private requireDb(): IDBDatabase {
    if (!this.db) {
      throw new Error("OfflineQueue: call open() before using the queue");
    }
    return this.db;
  }
}
