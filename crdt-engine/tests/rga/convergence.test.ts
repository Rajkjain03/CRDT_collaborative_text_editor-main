import { RGADocument } from "../../src/rga/RGADocument";
import { RGAInsert, RGADelete, NodeId } from "../../src/types";

/**
 * Phase 1 convergence tests.
 *
 * Scope boundary
 * ──────────────
 * These tests only exercise properties the RGA layer itself must guarantee:
 *
 *   1. Commutativity of CONCURRENT ops — ops from different sites that are
 *      causally independent can be applied in any interleaving order and
 *      produce the same result.
 *
 *   2. Idempotency — applying the same op twice is a no-op.
 *
 *   3. Deterministic tie-breaking — concurrent inserts at the same position
 *      always resolve in the same order regardless of delivery order.
 *
 * OUT OF SCOPE for Phase 1 (belongs to Phase 2 / CausalBuffer):
 *   - Shuffling ops within a single site's causal chain. Each site's ops form
 *     a chain where op[i].afterId = op[i-1].nodeId. Delivering op[i] before
 *     op[i-1] is a causal ordering violation. RGADocument correctly throws in
 *     that case — it is CausalBuffer's job to prevent it.
 *
 * Rule applied in every test: a site's own ops are always delivered in the
 * order they were generated. Only the interleaving BETWEEN sites varies.
 */

const emptyClock = {};

type AnyOp = RGAInsert | RGADelete;

/** Build a fresh observer document by applying ops in the given order. */
function applyAll(ops: AnyOp[]): RGADocument {
  const doc = new RGADocument("observer");
  for (const op of ops) {
    if (op.type === "insert") doc.applyInsert(op);
    else doc.applyDelete(op);
  }
  return doc;
}

/** Insert a full string into a document, returning the ops in order. */
function insertString(doc: RGADocument, text: string): RGAInsert[] {
  const ops: RGAInsert[] = [];
  for (const ch of text) {
    const afterId = doc.getAfterIdForOffset(doc.getVisibleLength());
    ops.push(doc.localInsert(afterId, ch, emptyClock));
  }
  return ops;
}

// ── Tie-breaking: concurrent inserts at the same position ────────────────────

describe("Convergence — concurrent insert ordering", () => {
  test("all 6 permutations of 3 concurrent head inserts produce the same result", () => {
    // Three sites each insert one character at the head simultaneously.
    // These are fully concurrent (no causal dependencies between them).
    // Expected: higher siteId (lex) → leftmost. "C" > "B" > "A" → "cba".
    const opA: RGAInsert = { type: "insert", nodeId: { siteId: "A", counter: 1 }, afterId: null, value: "a", clock: emptyClock };
    const opB: RGAInsert = { type: "insert", nodeId: { siteId: "B", counter: 1 }, afterId: null, value: "b", clock: emptyClock };
    const opC: RGAInsert = { type: "insert", nodeId: { siteId: "C", counter: 1 }, afterId: null, value: "c", clock: emptyClock };

    const permutations = [
      [opA, opB, opC],
      [opA, opC, opB],
      [opB, opA, opC],
      [opB, opC, opA],
      [opC, opA, opB],
      [opC, opB, opA],
    ];

    const results = permutations.map(p => applyAll(p).toVisibleString());
    expect(new Set(results).size).toBe(1);
    expect(results[0]).toBe("cba");
  });

  test("concurrent inserts after same node converge in both delivery orders", () => {
    // Site A inserts 'X'. Sites B and C each independently insert after 'X'.
    // B and C are concurrent — their relative order must be the same
    // regardless of whether B or C arrives first.
    const opX: RGAInsert = {
      type: "insert",
      nodeId: { siteId: "A", counter: 1 },
      afterId: null,
      value: "X",
      clock: emptyClock,
    };
    const opB: RGAInsert = {
      type: "insert",
      nodeId: { siteId: "B", counter: 1 },
      afterId: { siteId: "A", counter: 1 },
      value: "b",
      clock: emptyClock,
    };
    const opC: RGAInsert = {
      type: "insert",
      nodeId: { siteId: "C", counter: 1 },
      afterId: { siteId: "A", counter: 1 },
      value: "c",
      clock: emptyClock,
    };

    const r1 = applyAll([opX, opB, opC]).toVisibleString();
    const r2 = applyAll([opX, opC, opB]).toVisibleString();

    expect(r1).toBe(r2);
    expect(r1).toBe("Xcb"); // C > B lex
  });

  test("tie-breaking is stable: same site, higher counter wins", () => {
    // Two ops from the same site targeting the same predecessor.
    // Higher counter → higher priority → leftmost.
    const opEarly: RGAInsert = {
      type: "insert",
      nodeId: { siteId: "A", counter: 2 },
      afterId: null,
      value: "2",
      clock: emptyClock,
    };
    const opLate: RGAInsert = {
      type: "insert",
      nodeId: { siteId: "A", counter: 5 },
      afterId: null,
      value: "5",
      clock: emptyClock,
    };

    const r1 = applyAll([opEarly, opLate]).toVisibleString();
    const r2 = applyAll([opLate, opEarly]).toVisibleString();

    expect(r1).toBe(r2);
    expect(r1).toBe("52"); // counter 5 > 2 → leftmost
  });
});

// ── Two-replica convergence ───────────────────────────────────────────────────

describe("Convergence — two replicas", () => {
  test("ops from two sites converge across all valid interleavings", () => {
    // Sites A and B each build independent chains. These chains are concurrent
    // (no op in A depends on any op in B or vice versa). The interleaving
    // between the two chains can vary; within each chain, causal order is
    // preserved.
    const docA = new RGADocument("A");
    const docB = new RGADocument("B");
    const aOps = insertString(docA, "abc");
    const bOps = insertString(docB, "xyz");

    // 4 valid interleavings
    const i1 = applyAll([...aOps, ...bOps]).toVisibleString();
    const i2 = applyAll([...bOps, ...aOps]).toVisibleString();
    const i3 = applyAll([aOps[0]!, bOps[0]!, aOps[1]!, bOps[1]!, aOps[2]!, bOps[2]!]).toVisibleString();
    const i4 = applyAll([bOps[0]!, aOps[0]!, bOps[1]!, aOps[1]!, bOps[2]!, aOps[2]!]).toVisibleString();

    expect(new Set([i1, i2, i3, i4]).size).toBe(1);
    expect(i1).toHaveLength(6);
  });

  test("concurrent deletes of the same node are idempotent and converge", () => {
    // Build shared history "hello" on both replicas.
    const docA = new RGADocument("A");
    const docB = new RGADocument("B");
    const ops = insertString(docA, "hello");
    for (const op of ops) docB.applyInsert(op);

    // Both delete 'e' (index 1) independently.
    const eId = ops[1]!.nodeId;
    const delA = docA.localDelete(eId, emptyClock);
    const delB = docB.localDelete(eId, emptyClock);

    // Cross-apply — each replica gets the other's delete.
    docA.applyDelete(delB); // idempotent
    docB.applyDelete(delA); // idempotent

    expect(docA.toVisibleString()).toBe("hllo");
    expect(docB.toVisibleString()).toBe("hllo");
  });

  test("insert after a node that is concurrently deleted converges", () => {
    // Shared history "ac". A inserts 'b' after 'a'. B deletes 'a'.
    // These are concurrent. Both delivery orders must converge.
    const docA = new RGADocument("A");
    const docB = new RGADocument("B");

    const sharedOps = insertString(docA, "ac");
    for (const op of sharedOps) docB.applyInsert(op);

    const aId = sharedOps[0]!.nodeId;
    const insB = docA.localInsert(aId, "b", emptyClock); // insert after 'a'
    const delA = docB.localDelete(aId, emptyClock);       // delete 'a'

    // Order 1: insert then delete
    docB.applyInsert(insB);
    docA.applyDelete(delA);

    expect(docA.toVisibleString()).toBe(docB.toVisibleString());
    // 'a' deleted, 'b' inserted after tombstoned 'a' → 'b' still visible
    expect(docA.toVisibleString()).toBe("bc");
  });
});

// ── Three-replica convergence ─────────────────────────────────────────────────

describe("Convergence — three replicas", () => {
  test("three replicas exchanging concurrent op sets all converge", () => {
    const docA = new RGADocument("A");
    const docB = new RGADocument("B");
    const docC = new RGADocument("C");

    const aOps = insertString(docA, "aa");
    const bOps = insertString(docB, "bb");
    const cOps = insertString(docC, "cc");

    // Each replica applies the other two sites' ops in different orders.
    for (const op of bOps) docA.applyInsert(op);
    for (const op of cOps) docA.applyInsert(op);

    for (const op of cOps) docB.applyInsert(op);
    for (const op of aOps) docB.applyInsert(op);

    for (const op of aOps) docC.applyInsert(op);
    for (const op of bOps) docC.applyInsert(op);

    const texts = [docA, docB, docC].map(d => d.toVisibleString());
    expect(new Set(texts).size).toBe(1);
    expect(texts[0]).toHaveLength(6);
  });
});

// ── Idempotency ───────────────────────────────────────────────────────────────

describe("Convergence — idempotency", () => {
  test("applying the same insert twice does not duplicate the character", () => {
    const docA = new RGADocument("A");
    const op = docA.localInsert(null, "x", emptyClock);

    const docB = new RGADocument("B");
    docB.applyInsert(op);
    docB.applyInsert(op); // duplicate

    expect(docB.toVisibleString()).toBe("x");
    expect(docB.getVisibleLength()).toBe(1);
  });

  test("applying the same delete twice does not throw or corrupt state", () => {
    const docA = new RGADocument("A");
    const ops = insertString(docA, "a");
    const del = docA.localDelete(ops[0]!.nodeId, emptyClock);

    const docB = new RGADocument("B");
    docB.applyInsert(ops[0]!);
    docB.applyDelete(del);
    expect(() => docB.applyDelete(del)).not.toThrow();
    expect(docB.toVisibleString()).toBe("");
  });
});

// ── Commutativity across larger op sets ──────────────────────────────────────

describe("Convergence — commutativity stress", () => {
  test("5 sites, 3 ops each, multiple interleavings all converge", () => {
    const siteIds = ["A", "B", "C", "D", "E"];
    const docs = siteIds.map(s => new RGADocument(s));
    const siteOps: RGAInsert[][] = docs.map((doc, i) => {
      return insertString(doc, siteIds[i]!.toLowerCase().repeat(3));
    });

    // Apply all foreign ops to each replica — different interleaving per replica
    for (let i = 0; i < docs.length; i++) {
      for (let j = 0; j < siteOps.length; j++) {
        if (i === j) continue;
        for (const op of siteOps[j]!) docs[i]!.applyInsert(op);
      }
    }

    // Two observer replicas with opposite site orderings
    const obs1 = new RGADocument("obs1");
    for (const ops of siteOps) for (const op of ops) obs1.applyInsert(op);

    const obs2 = new RGADocument("obs2");
    for (const ops of [...siteOps].reverse()) for (const op of ops) obs2.applyInsert(op);

    const allTexts = [
      ...docs.map(d => d.toVisibleString()),
      obs1.toVisibleString(),
      obs2.toVisibleString(),
    ];
    expect(new Set(allTexts).size).toBe(1);
    expect(allTexts[0]).toHaveLength(15); // 5 sites × 3 chars each
  });
});