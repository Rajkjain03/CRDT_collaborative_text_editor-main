// collab-sync/client/ClientSync.ts
import { OfflineQueue } from './OfflineQueue';
import { RGAOperation, OpMessage } from '../shared/protocol';
// Note: You may need to adjust the path to your Phase 1 Replica class
import { Replica } from '../../crdt-engine/src/simulator/Replica'; 

type SiteId = string;

// Mock interface for what Stream B is building
export interface ConnectionManagerMock {
  getState(): "disconnected" | "connecting" | "connected" | "reconnecting";
  send(msg: any): boolean;
}

export class ClientSync {
  public replica: Replica;
  public offlineQueue: OfflineQueue;
  public connectionManager: ConnectionManagerMock;
  private siteId: SiteId;

  constructor(siteId: SiteId, connectionManagerMock: ConnectionManagerMock) {
    this.siteId = siteId;
    this.replica = new Replica(siteId); 
    this.offlineQueue = new OfflineQueue(siteId);
    this.connectionManager = connectionManagerMock;
  }

  // Called to initialize the database connection
  async init(): Promise<void> {
    await this.offlineQueue.open();
  }

  // Stream C Logic: Intercepts outgoing ops from Phase 1
  async sendLoop(): Promise<void> {
    const ops = this.replica.drainOutbox();
    
    for (const op of ops) {
      if (this.connectionManager.getState() !== "connected") {
        // Offline: Queue it in IndexedDB
        await this.offlineQueue.enqueue(op);
      } else {
        // Online: Try to send it
        const msg: OpMessage = { kind: "op", siteId: this.siteId, op };
        const success = this.connectionManager.send(msg);
        
        // If send unexpectedly fails, queue it
        if (!success) {
          await this.offlineQueue.enqueue(op);
        }
      }
    }
  }

  // Stream C Logic: Flush queue when connection is restored
  async onOnline(): Promise<void> {
    const queuedOps = await this.offlineQueue.getAll();
    if (queuedOps.length === 0) return;

    let successfullySentCount = 0;

    for (const op of queuedOps) {
      // Partial flush resilience check: did we drop offline mid-flush?
      if (this.connectionManager.getState() !== "connected") {
        break; 
      }

      const msg: OpMessage = { kind: "op", siteId: this.siteId, op };
      const success = this.connectionManager.send(msg);

      if (success) {
        successfullySentCount++;
      } else {
        break;
      }
    }

    // Clean up the queue based on what was actually sent
    if (successfullySentCount === queuedOps.length) {
      // Everything sent successfully
      await this.offlineQueue.clear();
    } else if (successfullySentCount > 0) {
      // Partial flush: clear only the operations that made it out
      // (Assuming successfullySentCount maps to the sequential auto-increment keys 1, 2, 3...)
      await this.offlineQueue.clearUpTo(successfullySentCount);
    }
  }
}