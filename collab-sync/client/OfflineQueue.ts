// collab-sync/client/OfflineQueue.ts
import { RGAOperation } from '../shared/protocol';
type SiteId = string;

export class OfflineQueue {
  private dbName: string;
  private storeName = "offline_ops";
  private db: IDBDatabase | null = null;

  constructor(siteId: SiteId) {
    this.dbName = `collab_sync_offline_${siteId}`;
  }

  // Opens the IndexedDB connection
  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, 1);

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains(this.storeName)) {
          db.createObjectStore(this.storeName, { autoIncrement: true });
        }
      };

      request.onsuccess = (event) => {
        this.db = (event.target as IDBOpenDBRequest).result;
        resolve();
      };

      request.onerror = () => reject(request.error);
    });
  }

  // Closes the DB connection (crucial for tests!)
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  // Enqueues an operation to IndexedDB
  enqueue(op: RGAOperation): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.db) return reject(new Error("DB not open"));
      const tx = this.db.transaction(this.storeName, "readwrite");
      const store = tx.objectStore(this.storeName);
      store.add(op);
      
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  // Retrieves all ops in insertion (causal) order
  getAll(): Promise<RGAOperation[]> {
    return new Promise((resolve, reject) => {
      if (!this.db) return reject(new Error("DB not open"));
      const tx = this.db.transaction(this.storeName, "readonly");
      const store = tx.objectStore(this.storeName);
      const request = store.getAll();

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  // Returns the current size of the queue
  size(): Promise<number> {
    return new Promise((resolve, reject) => {
      if (!this.db) return reject(new Error("DB not open"));
      const tx = this.db.transaction(this.storeName, "readonly");
      const store = tx.objectStore(this.storeName);
      const request = store.count();

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  // Empties the queue completely
  clear(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.db) return reject(new Error("DB not open"));
      const tx = this.db.transaction(this.storeName, "readwrite");
      const store = tx.objectStore(this.storeName);
      store.clear();

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  // Clears the queue up to a certain sequence number/key
  clearUpTo(seqNo: number): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.db) return reject(new Error("DB not open"));
      const tx = this.db.transaction(this.storeName, "readwrite");
      const store = tx.objectStore(this.storeName);
      
      const range = IDBKeyRange.upperBound(seqNo);
      const request = store.delete(range);

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }
}