import { Replica } from "../../src/simulator/Replica";
import { RGAInsert } from "../../src/types";

// ── Local ops ──────────────────────────────────────────────────────────────

describe("Replica — local insert", () => {
  test("insert at empty doc appends character", () => {
    const r = new Replica("A");
    r.insert(0, "x");
    expect(r.getText()).toBe("x");
  });

  test("sequential inserts build correct string", () => {
    const r = new Replica("A");
    for (const ch of "hello") r.insert(r.getLength(), ch);
    expect(r.getText()).toBe("hello");
  });

  test("insert places op in outbox", () => {
    const r = new Replica("A");
    r.insert(0, "a");
    const ops = r.drainOutbox();
    expect(ops).toHaveLength(1);
    expect(ops[0]!.type).toBe("insert");
  });

  test("drainOutbox clears outbox", () => {
    const r = new Replica("A");
    r.insert(0, "a");
    r.drainOutbox();
    expect(r.drainOutbox()).toHaveLength(0);
  });

  test("clock snapshot attached to op is taken BEFORE increment", () => {
    const r = new Replica("A");
    // First op: clock should be {} (0 for all sites) at snapshot time
    const op = r.insert(0, "x") as RGAInsert;
    // op.clock captured before increment — so A's entry should be 0
    expect(op.clock["A"] ?? 0).toBe(0);
    // After insert, clock is now 1
    expect(r.getClockSnapshot()["A"]).toBe(1);
  });

  test("clock increments once per local op", () => {
    const r = new Replica("A");
    r.insert(0, "a");
    r.insert(1, "b");
    r.insert(2, "c");
    expect(r.getClockSnapshot()["A"]).toBe(3);
  });
});

describe("Replica — local delete", () => {
  test("delete removes character", () => {
    const r = new Replica("A");
    for (const ch of "abc") r.insert(r.getLength(), ch);
    r.delete(1); // delete 'b'
    expect(r.getText()).toBe("ac");
  });

  test("delete returns null for out-of-range offset", () => {
    const r = new Replica("A");
    r.insert(0, "a");
    expect(r.delete(5)).toBeNull();
  });

  test("delete places op in outbox", () => {
    const r = new Replica("A");
    r.insert(0, "a");
    r.drainOutbox();
    r.delete(0);
    const ops = r.drainOutbox();
    expect(ops).toHaveLength(1);
    expect(ops[0]!.type).toBe("delete");
  });

  test("delete increments clock", () => {
    const r = new Replica("A");
    r.insert(0, "a");
    expect(r.getClockSnapshot()["A"]).toBe(1);
    r.delete(0);
    expect(r.getClockSnapshot()["A"]).toBe(2);
  });
});

// ── Remote ops ────────────────────────────────────────────────────────────────

describe("Replica — receive", () => {
  test("receive applies a causally ready insert", () => {
    const sender = new Replica("A");
    const op = sender.insert(0, "x") as RGAInsert;

    const receiver = new Replica("B");
    receiver.receive(op);
    expect(receiver.getText()).toBe("x");
  });

  test("receive buffers op when dependency missing", () => {
    const rA = new Replica("A");
    const op1 = rA.insert(0, "a") as RGAInsert; // clock: {A:0}
    const op2 = rA.insert(1, "b") as RGAInsert; // clock: {A:1}, depends on op1

    const rB = new Replica("B");
    rB.receive(op2); // op2 arrives first — buffered
    expect(rB.getText()).toBe(""); // not yet applied
    expect(rB.getPendingCount()).toBe(1);

    rB.receive(op1); // dependency arrives
    expect(rB.getText()).toBe("ab"); // both applied
    expect(rB.getPendingCount()).toBe(0);
  });

  test("receive returns list of actually applied ops", () => {
    const rA = new Replica("A");
    const op1 = rA.insert(0, "a") as RGAInsert;
    const op2 = rA.insert(1, "b") as RGAInsert;

    const rB = new Replica("B");
    const applied1 = rB.receive(op2); // buffered — nothing applied
    expect(applied1).toHaveLength(0);

    const applied2 = rB.receive(op1); // dependency satisfied — both drain
    expect(applied2).toHaveLength(2);
  });

  test("receiveBatch delivers ops that unblock each other", () => {
    const rA = new Replica("A");
    const ops = [];
    for (const ch of "xyz") ops.push(rA.insert(rA.getLength(), ch));

    const rB = new Replica("B");
    // Deliver in reverse — all buffered, then all released in one batch
    rB.receiveBatch([...ops].reverse() as RGAInsert[]);
    expect(rB.getText()).toBe("xyz");
    expect(rB.getPendingCount()).toBe(0);
  });
});

// ── Two-replica convergence via Replica API ───────────────────────────────────

describe("Replica — two-replica convergence", () => {
  test("two replicas exchange outbox ops and converge", () => {
    const rA = new Replica("A");
    const rB = new Replica("B");

    for (const ch of "abc") rA.insert(rA.getLength(), ch);
    for (const ch of "xyz") rB.insert(rB.getLength(), ch);

    const aOps = rA.drainOutbox();
    const bOps = rB.drainOutbox();

    for (const op of bOps) rA.receive(op);
    for (const op of aOps) rB.receive(op);

    expect(rA.getText()).toBe(rB.getText());
    expect(rA.getLength()).toBe(6);
  });

  test("concurrent insert and delete converge", () => {
    // Setup: both replicas have "hello"
    const rA = new Replica("A");
    const rB = new Replica("B");
    const setupOps = [];
    for (const ch of "hello") setupOps.push(rA.insert(rA.getLength(), ch));
    for (const op of setupOps) rB.receive(op as RGAInsert);
    rA.drainOutbox(); rB.drainOutbox();

    // A inserts 'X' at position 2; B deletes at position 1
    const insOp = rA.insert(2, "X");
    const delOp = rB.delete(1);

    // Cross-apply
    rA.receive(delOp!);
    rB.receive(insOp);

    expect(rA.getText()).toBe(rB.getText());
  });
});

// ── Delete propagation (CausalBuffer clock fix) ───────────────────────────────

describe("Replica — delete propagation across replicas", () => {
  test("all ops including deletes are delivered in order when senderSiteId provided", () => {
    const alice = new Replica("alice");
    const bob   = new Replica("bob");

    // alice types "hello"
    const insOps = [];
    for (const ch of "hello") insOps.push(alice.insert(alice.getLength(), ch));

    // alice deletes all chars (offset 4 down to 0)
    const delOps = [];
    for (let i = 4; i >= 0; i--) delOps.push(alice.delete(i));

    // alice types "fresh"
    const freshOps = [];
    for (const ch of "fresh") freshOps.push(alice.insert(alice.getLength(), ch));

    // bob receives every op with senderSiteId — no ops should remain buffered
    for (const op of [...insOps, ...delOps, ...freshOps]) {
      bob.receive(op!, "alice");
    }

    expect(bob.getText()).toBe("fresh");
    expect(bob.getPendingCount()).toBe(0);
  });

  test("delete ops without senderSiteId still deliver when not causally blocked", () => {
    const alice = new Replica("alice");
    const bob   = new Replica("bob");

    const insOp = alice.insert(0, "x");
    const delOp = alice.delete(0); // deletes "x"

    // bob gets insert first, then delete — no causal blocking
    bob.receive(insOp);
    bob.receive(delOp!); // no senderSiteId (old API path)

    expect(bob.getText()).toBe("");
    expect(bob.getPendingCount()).toBe(0);
  });
});

// ── LWW metadata ─────────────────────────────────────────────────────────────

describe("Replica — LWW metadata", () => {
  test("setMeta stores and retrieves a value", () => {
    const r = new Replica("A");
    r.setMeta("title", "My Document", 100);
    expect(r.lww.get("title")).toBe("My Document");
  });

  test("mergeMeta applies remote state", () => {
    const rA = new Replica("A");
    const rB = new Replica("B");
    rB.setMeta("status", "active", 200);

    rA.mergeMeta(rB.lww.snapshot());
    expect(rA.lww.get("status")).toBe("active");
  });

  test("two replicas converge on metadata after cross-merge", () => {
    const rA = new Replica("A");
    const rB = new Replica("B");
    rA.setMeta("title", "Doc A", 100);
    rB.setMeta("title", "Doc B", 200);

    rA.mergeMeta(rB.lww.snapshot());
    rB.mergeMeta(rA.lww.snapshot());

    expect(rA.lww.get("title")).toBe(rB.lww.get("title"));
    expect(rA.lww.get("title")).toBe("Doc B"); // higher timestamp wins
  });
});
