// collab-sync/tests/offlineQueue.test.ts
import 'fake-indexeddb/auto'; 
import { OfflineQueue } from '../client/OfflineQueue';
import { RGAOperation } from '../shared/protocol';

describe('OfflineQueue', () => {
  const SITE_ID = "test-site-1";
  let queue: OfflineQueue;

  const createOp = (id: string): RGAOperation => ({
    kind: "insert", 
    id: { siteId: SITE_ID, clock: 1 },
    value: id,
    offset: 0
  } as any); 

  beforeEach(async () => {
    const request = indexedDB.deleteDatabase(`collab_sync_offline_${SITE_ID}`);
    await new Promise((resolve) => {
      request.onsuccess = resolve;
      request.onerror = resolve;
      request.onblocked = resolve; // Failsafe for fake-indexeddb
    });

    queue = new OfflineQueue(SITE_ID);
    await queue.open();
  });

  // Ensure DB is closed after every test so deleteDatabase doesn't hang!
  afterEach(() => {
    if (queue) {
      queue.close();
    }
  });

  test('enqueue persists op to IndexedDB and size increments', async () => {
    const op = createOp("A");
    await queue.enqueue(op);
    
    const size = await queue.size();
    expect(size).toBe(1);
  });

  test('getAll returns ops in insertion (causal) order', async () => {
    const op1 = createOp("A");
    const op2 = createOp("B");
    const op3 = createOp("C");

    await queue.enqueue(op1);
    await queue.enqueue(op2);
    await queue.enqueue(op3);

    const ops = await queue.getAll();
    expect(ops.length).toBe(3);
    expect(ops[0].value).toBe("A");
    expect(ops[1].value).toBe("B");
    expect(ops[2].value).toBe("C");
  });

  test('clear empties the queue', async () => {
    await queue.enqueue(createOp("A"));
    await queue.enqueue(createOp("B"));
    
    await queue.clear();
    const size = await queue.size();
    expect(size).toBe(0);
  });

  test('clearUpTo removes ops up to sequence number', async () => {
    await queue.enqueue(createOp("A")); // IDB key: 1
    await queue.enqueue(createOp("B")); // IDB key: 2
    await queue.enqueue(createOp("C")); // IDB key: 3

    await queue.clearUpTo(2); 
    
    const ops = await queue.getAll();
    expect(ops.length).toBe(1);
    expect(ops[0].value).toBe("C");
  });

  test('queue survives simulated page reload (re-open same DB)', async () => {
    await queue.enqueue(createOp("A"));
    
    // Close the original queue to simulate a page reload
    queue.close();
    
    const reloadedQueue = new OfflineQueue(SITE_ID);
    await reloadedQueue.open();
    
    const ops = await reloadedQueue.getAll();
    expect(ops.length).toBe(1);
    expect(ops[0].value).toBe("A");
    
    reloadedQueue.close();
  });
});