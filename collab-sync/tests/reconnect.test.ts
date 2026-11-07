// collab-sync/tests/reconnect.test.ts
import 'fake-indexeddb/auto';
import { ClientSync, ConnectionManagerMock } from '../client/ClientSync';
import { RGAOperation } from '../shared/protocol';

// A controllable mock to simulate network states and sudden drops
class ControllableConnection implements ConnectionManagerMock {
  state: "disconnected" | "connected" = "disconnected";
  sentMessages: any[] = [];
  failAfterXMessages: number = Infinity;

  getState(): "disconnected" | "connected" {
    return this.state;
  }

  send(msg: any): boolean {
    if (this.state !== "connected") return false;
    
    // Simulate a mid-flush disconnect
    if (this.sentMessages.length >= this.failAfterXMessages) {
      this.state = "disconnected";
      return false;
    }

    this.sentMessages.push(msg);
    return true;
  }
}

describe('ClientSync Reconnect & Flush Logic (Stream C)', () => {
  const SITE_ID = "test-site-2";
  let clientSync: ClientSync;
  let mockConn: ControllableConnection;

  // Helper to inject fake operations directly into Phase 1's Replica outbox
  const generateFakeOps = (count: number) => {
    const ops: RGAOperation[] = [];
    for (let i = 0; i < count; i++) {
      ops.push({
        kind: "insert",
        id: { siteId: SITE_ID, clock: i + 1 },
        value: `char-${i}`,
        offset: i
      } as any);
    }
    // Override drainOutbox to simulate Phase 1 generating ops
    clientSync.replica.drainOutbox = () => ops;
  };

  beforeEach(async () => {
    // Clean up DB before each test
    const request = indexedDB.deleteDatabase(`collab_sync_offline_${SITE_ID}`);
    await new Promise((resolve) => {
      request.onsuccess = resolve;
      request.onerror = resolve;
      request.onblocked = resolve;
    });

    mockConn = new ControllableConnection();
    clientSync = new ClientSync(SITE_ID, mockConn);
    await clientSync.init();
  });

  afterEach(() => {
    if (clientSync && clientSync.offlineQueue) {
      clientSync.offlineQueue.close();
    }
  });

  test('ops queued offline are not sent but saved to DB', async () => {
    mockConn.state = "disconnected";
    generateFakeOps(3);
    
    await clientSync.sendLoop();

    expect(mockConn.sentMessages.length).toBe(0);
    const queuedSize = await clientSync.offlineQueue.size();
    expect(queuedSize).toBe(3);
  });

  test('offline queue empty after successful flush', async () => {
    // 1. Generate ops while offline
    mockConn.state = "disconnected";
    generateFakeOps(3);
    await clientSync.sendLoop();
    expect(await clientSync.offlineQueue.size()).toBe(3);

    // 2. Come online and trigger flush
    mockConn.state = "connected";
    await clientSync.onOnline();

    // 3. Verify they were sent and queue is empty
    expect(mockConn.sentMessages.length).toBe(3);
    expect(await clientSync.offlineQueue.size()).toBe(0);
  });

  test('partial flush: remaining ops still present after mid-flush disconnect', async () => {
    // 1. Generate 5 ops while offline
    mockConn.state = "disconnected";
    generateFakeOps(5);
    await clientSync.sendLoop();
    expect(await clientSync.offlineQueue.size()).toBe(5);

    // 2. Come online, but set network to fail after sending exactly 2 messages
    mockConn.state = "connected";
    mockConn.failAfterXMessages = 2;
    await clientSync.onOnline();

    // 3. Verify only 2 made it out
    expect(mockConn.sentMessages.length).toBe(2);

    // 4. Verify the remaining 3 are still safely in the queue
    const remainingOps = await clientSync.offlineQueue.getAll();
    expect(remainingOps.length).toBe(3);
    expect(remainingOps[0].value).toBe("char-2"); // The 3rd operation (0-indexed)
  });
});