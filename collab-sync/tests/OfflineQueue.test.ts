import "fake-indexeddb/auto";
import { OfflineQueue } from "../src/client/OfflineQueue";
import type { RGAInsert, RGADelete } from "crdt-engine/src/types";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeInsert(siteId: string, counter: number, value: string): RGAInsert {
  return {
    type: "insert",
    nodeId: { siteId, counter },
    afterId: null,
    value,
    siteId,
    clock: { [siteId]: counter },
  };
}

function makeDelete(siteId: string, counter: number): RGADelete {
  return {
    type: "delete",
    targetId: { siteId: "other", counter: 0 },
    siteId,
    clock: { [siteId]: counter },
  };
}

// ── Setup ─────────────────────────────────────────────────────────────────────

let uniqueSite = 0;
async function makeQueue(): Promise<OfflineQueue> {
  const q = new OfflineQueue(`test-${uniqueSite++}-${Date.now()}`);
  await q.open();
  return q;
}

// ── open / close ──────────────────────────────────────────────────────────────

describe("OfflineQueue — open and close", () => {
  test("open() creates the object store", async () => {
    const q = await makeQueue();
    expect(await q.size()).toBe(0);
    q.close();
  });

  test("open() is idempotent", async () => {
    const q = await makeQueue();
    await q.open(); // second call should not throw
    expect(await q.size()).toBe(0);
    q.close();
  });

  test("methods throw before open() is called", () => {
    const q = new OfflineQueue("never-opened");
    expect(() => q.enqueue(makeInsert("A", 0, "x"))).toThrow();
  });
});

// ── enqueue / size ────────────────────────────────────────────────────────────

describe("OfflineQueue — enqueue and size", () => {
  test("enqueue persists op and returns seqNo", async () => {
    const q = await makeQueue();
    const seqNo = await q.enqueue(makeInsert("A", 0, "x"));
    expect(typeof seqNo).toBe("number");
    expect(await q.size()).toBe(1);
    q.close();
  });

  test("size increments with each enqueue", async () => {
    const q = await makeQueue();
    await q.enqueue(makeInsert("A", 0, "a"));
    await q.enqueue(makeInsert("A", 1, "b"));
    await q.enqueue(makeInsert("A", 2, "c"));
    expect(await q.size()).toBe(3);
    q.close();
  });

  test("seqNo is monotonically increasing", async () => {
    const q = await makeQueue();
    const s1 = await q.enqueue(makeInsert("A", 0, "a"));
    const s2 = await q.enqueue(makeInsert("A", 1, "b"));
    const s3 = await q.enqueue(makeInsert("A", 2, "c"));
    expect(s2).toBeGreaterThan(s1);
    expect(s3).toBeGreaterThan(s2);
    q.close();
  });
});

// ── getAll — ordering ─────────────────────────────────────────────────────────

describe("OfflineQueue — getAll", () => {
  test("getAll returns empty array when queue is empty", async () => {
    const q = await makeQueue();
    expect(await q.getAll()).toEqual([]);
    q.close();
  });

  test("getAll returns ops in insertion order", async () => {
    const q = await makeQueue();
    await q.enqueue(makeInsert("A", 0, "a"));
    await q.enqueue(makeInsert("A", 1, "b"));
    await q.enqueue(makeInsert("A", 2, "c"));

    const all = await q.getAll();
    expect(all).toHaveLength(3);
    expect((all[0]!.op as RGAInsert).value).toBe("a");
    expect((all[1]!.op as RGAInsert).value).toBe("b");
    expect((all[2]!.op as RGAInsert).value).toBe("c");
    q.close();
  });

  test("getAll returns seqNos matching enqueue order", async () => {
    const q = await makeQueue();
    const s1 = await q.enqueue(makeInsert("A", 0, "a"));
    const s2 = await q.enqueue(makeInsert("A", 1, "b"));
    const all = await q.getAll();
    expect(all[0]!.seqNo).toBe(s1);
    expect(all[1]!.seqNo).toBe(s2);
    q.close();
  });

  test("getAll returns both insert and delete ops preserving order", async () => {
    const q = await makeQueue();
    await q.enqueue(makeInsert("A", 0, "a"));
    await q.enqueue(makeDelete("A", 1));
    await q.enqueue(makeInsert("A", 2, "b"));

    const all = await q.getAll();
    expect(all[0]!.op.type).toBe("insert");
    expect(all[1]!.op.type).toBe("delete");
    expect(all[2]!.op.type).toBe("insert");
    q.close();
  });
});

// ── clearUpTo ─────────────────────────────────────────────────────────────────

describe("OfflineQueue — clearUpTo", () => {
  test("clearUpTo removes ops with seqNo <= given value", async () => {
    const q = await makeQueue();
    const s1 = await q.enqueue(makeInsert("A", 0, "a"));
    await q.enqueue(makeInsert("A", 1, "b"));
    await q.enqueue(makeInsert("A", 2, "c"));

    await q.clearUpTo(s1);
    expect(await q.size()).toBe(2);

    const remaining = await q.getAll();
    expect((remaining[0]!.op as RGAInsert).value).toBe("b");
    expect((remaining[1]!.op as RGAInsert).value).toBe("c");
    q.close();
  });

  test("clearUpTo(latest seqNo) empties the queue", async () => {
    const q = await makeQueue();
    await q.enqueue(makeInsert("A", 0, "a"));
    await q.enqueue(makeInsert("A", 1, "b"));
    const lastSeq = await q.enqueue(makeInsert("A", 2, "c"));

    await q.clearUpTo(lastSeq);
    expect(await q.size()).toBe(0);
    q.close();
  });

  test("clearUpTo with seqNo lower than any queued is a no-op", async () => {
    const q = await makeQueue();
    await q.enqueue(makeInsert("A", 0, "a"));
    await q.clearUpTo(-1);
    expect(await q.size()).toBe(1);
    q.close();
  });
});

// ── clear ─────────────────────────────────────────────────────────────────────

describe("OfflineQueue — clear", () => {
  test("clear empties the queue", async () => {
    const q = await makeQueue();
    await q.enqueue(makeInsert("A", 0, "a"));
    await q.enqueue(makeInsert("A", 1, "b"));
    await q.clear();
    expect(await q.size()).toBe(0);
    expect(await q.getAll()).toEqual([]);
    q.close();
  });

  test("clear on empty queue is safe", async () => {
    const q = await makeQueue();
    await expect(q.clear()).resolves.toBeUndefined();
    q.close();
  });
});

// ── Persistence across close / reopen ─────────────────────────────────────────

describe("OfflineQueue — persistence", () => {
  test("data persists across close and reopen", async () => {
    const siteId = `persist-test-${Date.now()}`;
    const q1 = new OfflineQueue(siteId);
    await q1.open();
    await q1.enqueue(makeInsert("A", 0, "persisted"));
    q1.close();

    const q2 = new OfflineQueue(siteId);
    await q2.open();
    const all = await q2.getAll();
    expect(all).toHaveLength(1);
    expect((all[0]!.op as RGAInsert).value).toBe("persisted");
    q2.close();
  });
});
