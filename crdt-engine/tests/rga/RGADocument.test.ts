import { RGADocument } from "../../src/rga/RGADocument";
import { NodeId, RGAInsert, RGADelete, nodeKey } from "../../src/types";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Build a minimal clock snapshot with a single entry. */
const clock = (siteId: string, n: number) => ({ [siteId]: n });
const emptyClock = {};

/**
 * Insert a string character-by-character into a document starting at the end.
 * Returns the list of NodeIds in insertion order.
 */
function insertString(doc: RGADocument, text: string): NodeId[] {
  const ids: NodeId[] = [];
  for (const ch of text) {
    const afterId = doc.getAfterIdForOffset(doc.getVisibleLength());
    const op = doc.localInsert(afterId, ch, emptyClock);
    ids.push(op.nodeId);
  }
  return ids;
}

// ── Basic insert / visible string ────────────────────────────────────────────

describe("RGADocument — basic insert", () => {
  test("empty document has empty string", () => {
    const doc = new RGADocument("A");
    expect(doc.toVisibleString()).toBe("");
    expect(doc.getVisibleLength()).toBe(0);
  });

  test("single character insert at head", () => {
    const doc = new RGADocument("A");
    doc.localInsert(null, "x", emptyClock);
    expect(doc.toVisibleString()).toBe("x");
  });

  test("sequential inserts build correct string", () => {
    const doc = new RGADocument("A");
    insertString(doc, "hello");
    expect(doc.toVisibleString()).toBe("hello");
  });

  test("insert in the middle", () => {
    const doc = new RGADocument("A");
    insertString(doc, "helo"); // "helo"
    // Find afterId for offset 2 (after 'e'), insert 'l'
    const afterId = doc.getAfterIdForOffset(2)!;
    doc.localInsert(afterId, "l", emptyClock);
    expect(doc.toVisibleString()).toBe("hello");
  });

  test("insert at head (offset 0)", () => {
    const doc = new RGADocument("A");
    insertString(doc, "bc");
    doc.localInsert(null, "a", emptyClock);
    expect(doc.toVisibleString()).toBe("abc");
  });
});

// ── Delete / tombstone ────────────────────────────────────────────────────────

describe("RGADocument — delete", () => {
  test("delete first character", () => {
    const doc = new RGADocument("A");
    insertString(doc, "abc");
    const nodeId = doc.getNodeIdAtOffset(0)!;
    doc.localDelete(nodeId, emptyClock);
    expect(doc.toVisibleString()).toBe("bc");
  });

  test("delete middle character", () => {
    const doc = new RGADocument("A");
    insertString(doc, "abc");
    const nodeId = doc.getNodeIdAtOffset(1)!; // 'b'
    doc.localDelete(nodeId, emptyClock);
    expect(doc.toVisibleString()).toBe("ac");
  });

  test("delete last character", () => {
    const doc = new RGADocument("A");
    insertString(doc, "abc");
    const nodeId = doc.getNodeIdAtOffset(2)!; // 'c'
    doc.localDelete(nodeId, emptyClock);
    expect(doc.toVisibleString()).toBe("ab");
  });

  test("delete all characters leaves empty string", () => {
    const doc = new RGADocument("A");
    insertString(doc, "hi");
    doc.localDelete(doc.getNodeIdAtOffset(0)!, emptyClock);
    doc.localDelete(doc.getNodeIdAtOffset(0)!, emptyClock);
    expect(doc.toVisibleString()).toBe("");
    expect(doc.getVisibleLength()).toBe(0);
  });

  test("delete is idempotent (double delete same node)", () => {
    const doc = new RGADocument("A");
    insertString(doc, "abc");
    const nodeId = doc.getNodeIdAtOffset(1)!;
    doc.localDelete(nodeId, emptyClock);
    // Simulate receiving the same delete twice
    const del: RGADelete = { type: "delete", targetId: nodeId, clock: emptyClock };
    expect(() => doc.applyDelete(del)).not.toThrow();
    expect(doc.toVisibleString()).toBe("ac");
  });

  test("node count includes tombstones", () => {
    const doc = new RGADocument("A");
    insertString(doc, "abc");
    expect(doc.totalNodeCount).toBe(3);
    doc.localDelete(doc.getNodeIdAtOffset(0)!, emptyClock);
    expect(doc.totalNodeCount).toBe(3); // tombstone stays
    expect(doc.getVisibleLength()).toBe(2);
  });
});

// ── applyInsert / remote ops ──────────────────────────────────────────────────

describe("RGADocument — applyInsert remote", () => {
  test("applying same insert twice is idempotent", () => {
    const doc = new RGADocument("A");
    const op = doc.localInsert(null, "a", emptyClock);
    // Re-apply the same insert
    expect(() => doc.applyInsert(op)).not.toThrow();
    expect(doc.toVisibleString()).toBe("a");
  });

  test("throws if predecessor is missing", () => {
    const doc = new RGADocument("A");
    const missingId: NodeId = { siteId: "Z", counter: 99 };
    const op: RGAInsert = {
      type: "insert",
      nodeId: { siteId: "B", counter: 1 },
      afterId: missingId,
      value: "x",
      clock: emptyClock,
    };
    expect(() => doc.applyInsert(op)).toThrow();
  });

  test("throws if delete target is missing", () => {
    const doc = new RGADocument("A");
    const missingId: NodeId = { siteId: "Z", counter: 99 };
    const op: RGADelete = { type: "delete", targetId: missingId, clock: emptyClock };
    expect(() => doc.applyDelete(op)).toThrow();
  });
});

// ── Conflict resolution ───────────────────────────────────────────────────────

describe("RGADocument — concurrent insert conflict resolution", () => {
  /**
   * Replay a set of operations on a fresh document in the given order.
   * Returns the resulting visible string.
   */
  function replayOps(ops: (RGAInsert | RGADelete)[]): string {
    const doc = new RGADocument("observer");
    for (const op of ops) {
      if (op.type === "insert") doc.applyInsert(op);
      else doc.applyDelete(op);
    }
    return doc.toVisibleString();
  }

  test("concurrent head inserts ordered by descending siteId", () => {
    // Three sites all insert at head simultaneously (afterId = null)
    // Higher siteId → placed to the left
    const opA: RGAInsert = { type: "insert", nodeId: { siteId: "A", counter: 1 }, afterId: null, value: "a", clock: emptyClock };
    const opB: RGAInsert = { type: "insert", nodeId: { siteId: "B", counter: 1 }, afterId: null, value: "b", clock: emptyClock };
    const opC: RGAInsert = { type: "insert", nodeId: { siteId: "C", counter: 1 }, afterId: null, value: "c", clock: emptyClock };

    // All 6 permutations must produce the same result: "cba" (C > B > A)
    const permutations = [
      [opA, opB, opC],
      [opA, opC, opB],
      [opB, opA, opC],
      [opB, opC, opA],
      [opC, opA, opB],
      [opC, opB, opA],
    ];

    const results = permutations.map(replayOps);
    expect(new Set(results).size).toBe(1); // all same
    expect(results[0]).toBe("cba");
  });

  test("concurrent inserts after same node converge regardless of delivery order", () => {
    // Site A has document "X". B inserts 'b' after X. C inserts 'c' after X.
    // C > B lex, so expected result is "Xcb" (C to the left, then B, then end... wait)
    // C has higher siteId so C's node appears first after X: "Xcb"
    const opX: RGAInsert = { type: "insert", nodeId: { siteId: "A", counter: 1 }, afterId: null, value: "X", clock: emptyClock };
    const opB: RGAInsert = { type: "insert", nodeId: { siteId: "B", counter: 1 }, afterId: { siteId: "A", counter: 1 }, value: "b", clock: emptyClock };
    const opC: RGAInsert = { type: "insert", nodeId: { siteId: "C", counter: 1 }, afterId: { siteId: "A", counter: 1 }, value: "c", clock: emptyClock };

    const r1 = replayOps([opX, opB, opC]);
    const r2 = replayOps([opX, opC, opB]);
    expect(r1).toBe(r2);
    expect(r1).toBe("Xcb"); // C > B
  });

  test("insert after a tombstoned node still positions correctly", () => {
    // Document "abc". Delete 'b'. Then insert 'X' after 'b' (now tombstoned).
    // Result should be "aXc".
    const docA = new RGADocument("A");
    insertString(docA, "abc");
    const nodeB = docA.getNodeIdAtOffset(1)!; // 'b'

    const delOp = docA.localDelete(nodeB, emptyClock);
    // Now insert 'X' after the tombstoned 'b'
    const insertOp = docA.localInsert(nodeB, "X", emptyClock);
    expect(docA.toVisibleString()).toBe("aXc");
  });

  test("two replicas exchange ops in different interleaving order and converge", () => {
    // Phase 1 scope: test that applying the same set of concurrent ops
    // (ops from different sites, causally independent) in different
    // interleaving order produces the same result.
    //
    // Each site's own chain is always delivered in order (causal order
    // within a site). Only the interleaving between sites varies.
    // Shuffling within a single site's chain would require CausalBuffer
    // (Phase 2) and is out of scope here.
    const docA = new RGADocument("A");
    const docB = new RGADocument("B");

    const aOps: RGAInsert[] = [];
    const bOps: RGAInsert[] = [];

    for (const ch of "hello") {
      const afterId = docA.getAfterIdForOffset(docA.getVisibleLength());
      aOps.push(docA.localInsert(afterId, ch, emptyClock));
    }
    for (const ch of "world") {
      const afterId = docB.getAfterIdForOffset(docB.getVisibleLength());
      bOps.push(docB.localInsert(afterId, ch, emptyClock));
    }

    // Interleaving 1: all of A then all of B
    const docObs1 = new RGADocument("obs1");
    for (const op of aOps) docObs1.applyInsert(op);
    for (const op of bOps) docObs1.applyInsert(op);

    // Interleaving 2: all of B then all of A
    const docObs2 = new RGADocument("obs2");
    for (const op of bOps) docObs2.applyInsert(op);
    for (const op of aOps) docObs2.applyInsert(op);

    // Interleaving 3: element-wise interleave A[i], B[i]
    const docObs3 = new RGADocument("obs3");
    for (let i = 0; i < 5; i++) {
      docObs3.applyInsert(aOps[i]!);
      docObs3.applyInsert(bOps[i]!);
    }

    // Interleaving 4: reverse element-wise interleave B[i], A[i]
    const docObs4 = new RGADocument("obs4");
    for (let i = 0; i < 5; i++) {
      docObs4.applyInsert(bOps[i]!);
      docObs4.applyInsert(aOps[i]!);
    }

    const results = [
      docObs1.toVisibleString(),
      docObs2.toVisibleString(),
      docObs3.toVisibleString(),
      docObs4.toVisibleString(),
    ];

    expect(new Set(results).size).toBe(1);
    expect(results[0]).toHaveLength(10);
  });
});

// ── Offset / NodeId translation ───────────────────────────────────────────────

describe("RGADocument — offset index", () => {
  test("getNodeIdAtOffset returns correct ids", () => {
    const doc = new RGADocument("A");
    const ids = insertString(doc, "abc");
    expect(doc.getNodeIdAtOffset(0)).toEqual(ids[0]);
    expect(doc.getNodeIdAtOffset(1)).toEqual(ids[1]);
    expect(doc.getNodeIdAtOffset(2)).toEqual(ids[2]);
    expect(doc.getNodeIdAtOffset(3)).toBeNull();
  });

  test("getAfterIdForOffset returns null at offset 0", () => {
    const doc = new RGADocument("A");
    insertString(doc, "abc");
    expect(doc.getAfterIdForOffset(0)).toBeNull();
  });

  test("getAfterIdForOffset returns last char id at length", () => {
    const doc = new RGADocument("A");
    const ids = insertString(doc, "abc");
    expect(doc.getAfterIdForOffset(3)).toEqual(ids[2]);
  });

  test("toOffsetIndex maps node keys to correct offsets", () => {
    const doc = new RGADocument("A");
    const ids = insertString(doc, "abc");
    const index = doc.toOffsetIndex();

    expect(index.get(nodeKey(ids[0]))).toBe(0);
    expect(index.get(nodeKey(ids[1]))).toBe(1);
    expect(index.get(nodeKey(ids[2]))).toBe(2);
  });

  test("toOffsetIndex excludes tombstones and shifts offsets", () => {
    const doc = new RGADocument("A");
    const ids = insertString(doc, "abc");
    doc.localDelete(ids[1], emptyClock); // delete 'b'

    const index = doc.toOffsetIndex();
    expect(index.get(nodeKey(ids[0]))).toBe(0); // 'a' still at 0
    expect(index.has(nodeKey(ids[1]))).toBe(false); // 'b' not in index
    expect(index.get(nodeKey(ids[2]))).toBe(1); // 'c' shifts to 1
  });

  test("getNodeIdAtOffset is stable after remote inserts", () => {
    const doc = new RGADocument("A");
    insertString(doc, "ac"); // "ac", offset 1 = 'c'

    const cId = doc.getNodeIdAtOffset(1)!; // 'c'

    // Remote insert 'b' between 'a' and 'c'
    const aId = doc.getNodeIdAtOffset(0)!;
    const remoteOp: RGAInsert = {
      type: "insert",
      nodeId: { siteId: "B", counter: 1 },
      afterId: aId,
      value: "b",
      clock: emptyClock,
    };
    doc.applyInsert(remoteOp);

    // 'c' is now at offset 2 but its NodeId hasn't changed
    expect(doc.toVisibleString()).toBe("abc");
    expect(doc.getNodeIdAtOffset(2)).toEqual(cId);
  });
});

// ── debugDump ─────────────────────────────────────────────────────────────────

describe("RGADocument — debugDump", () => {
  test("shows tombstone markers", () => {
    const doc = new RGADocument("A");
    insertString(doc, "ab");
    doc.localDelete(doc.getNodeIdAtOffset(0)!, emptyClock);
    const dump = doc.debugDump();
    expect(dump).toContain("a(✗)");
    expect(dump).toContain("b(✓)");
  });
});

// ── pruneNode (GC prerequisite) ───────────────────────────────────────────────

describe("RGADocument — pruneNode", () => {
  test("pruned tombstone is removed from node count", () => {
    const doc = new RGADocument("A");
    insertString(doc, "ab");
    const aId = doc.getNodeIdAtOffset(0)!;
    doc.localDelete(aId, emptyClock);

    expect(doc.totalNodeCount).toBe(2);
    doc.pruneNode(aId);
    expect(doc.totalNodeCount).toBe(1);
    expect(doc.toVisibleString()).toBe("b");
  });

  test("pruning a non-deleted node is a no-op", () => {
    const doc = new RGADocument("A");
    insertString(doc, "ab");
    const aId = doc.getNodeIdAtOffset(0)!;
    doc.pruneNode(aId); // 'a' is not deleted
    expect(doc.totalNodeCount).toBe(2);
    expect(doc.toVisibleString()).toBe("ab");
  });

  test("pruning head node updates head pointer", () => {
    const doc = new RGADocument("A");
    const ids = insertString(doc, "abc");
    doc.localDelete(ids[0], emptyClock); // delete 'a' (head)
    doc.pruneNode(ids[0]);
    expect(doc.toVisibleString()).toBe("bc");
    expect(doc.totalNodeCount).toBe(2);
  });
});