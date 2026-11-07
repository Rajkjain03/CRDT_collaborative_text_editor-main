import { NetworkSim } from "../../src/simulator/NetworkSim";
import { Replica } from "../../src/simulator/Replica";

function makeNet(n: number, seed = 42): NetworkSim {
  const sim = new NetworkSim(seed);
  for (let i = 0; i < n; i++) sim.addReplica(new Replica(`S${i + 1}`));
  return sim;
}

function typeString(sim: NetworkSim, siteId: string, text: string) {
  const r = sim.getReplica(siteId)!;
  for (const ch of text) r.insert(r.getLength(), ch);
}

// ── addReplica ────────────────────────────────────────────────────────────────

describe("NetworkSim — addReplica", () => {
  test("registers site in all other replicas GC", () => {
    const sim = new NetworkSim();
    sim.addReplica(new Replica("A"));
    sim.addReplica(new Replica("B"));
    sim.addReplica(new Replica("C"));
    expect(sim.getReplica("A")!.gc.getKnownSites().has("B")).toBe(true);
    expect(sim.getReplica("A")!.gc.getKnownSites().has("C")).toBe(true);
  });

  test("new replica gets all existing sites in its GC", () => {
    const sim = new NetworkSim();
    sim.addReplica(new Replica("A"));
    sim.addReplica(new Replica("B"));
    sim.addReplica(new Replica("C"));
    expect(sim.getReplica("C")!.gc.getKnownSites().has("A")).toBe(true);
    expect(sim.getReplica("C")!.gc.getKnownSites().has("B")).toBe(true);
  });
});

// ── step / runAll ─────────────────────────────────────────────────────────────

describe("NetworkSim — step and runAll", () => {
  test("step delivers ops and returns count", () => {
    const sim = makeNet(2);
    typeString(sim, "S1", "hi");
    expect(sim.step()).toBe(2);
  });

  test("runAll converges two replicas", () => {
    const sim = makeNet(2);
    typeString(sim, "S1", "abc");
    typeString(sim, "S2", "xyz");
    sim.runAll();
    expect(sim.assertConverged()).toBe(true);
    expect(sim.getReplica("S1")!.getText()).toHaveLength(6);
  });

  test("runAll converges three replicas", () => {
    const sim = makeNet(3);
    typeString(sim, "S1", "aaa");
    typeString(sim, "S2", "bbb");
    typeString(sim, "S3", "ccc");
    sim.runAll();
    expect(sim.assertConverged()).toBe(true);
    expect(sim.getReplica("S1")!.getLength()).toBe(9);
  });

  test("runAll with random order still converges", () => {
    const sim = makeNet(3, 77);
    typeString(sim, "S1", "hello");
    typeString(sim, "S2", "world");
    typeString(sim, "S3", "crdt");
    sim.runAll("random");
    expect(sim.assertConverged()).toBe(true);
  });

  test("runAll with reverse order still converges", () => {
    const sim = makeNet(2, 11);
    typeString(sim, "S1", "abc");
    typeString(sim, "S2", "xyz");
    sim.runAll("reverse");
    expect(sim.assertConverged()).toBe(true);
  });

  test("runAll with deletes converges", () => {
    const sim = makeNet(2);
    typeString(sim, "S1", "hello");
    sim.runAll();
    sim.getReplica("S1")!.delete(1);
    sim.getReplica("S2")!.delete(3);
    sim.runAll();
    expect(sim.assertConverged()).toBe(true);
  });
});

// ── partition model ───────────────────────────────────────────────────────────

describe("NetworkSim — partition blocks both directions", () => {
  test("partitioned site does NOT receive ops from online sites", () => {
    const sim = makeNet(2);
    sim.partition(["S2"]);
    typeString(sim, "S1", "hello");
    sim.step();
    // S2 is fully isolated — should not have received anything
    expect(sim.getReplica("S2")!.getText()).toBe("");
  });

  test("partitioned site ops are NOT delivered to online sites", () => {
    const sim = makeNet(2);
    sim.partition(["S1"]);
    typeString(sim, "S1", "offline-edit");
    sim.step();
    // S2 should not have received S1's ops
    expect(sim.getReplica("S2")!.getText()).toBe("");
  });

  test("queuedForSite counts both outgoing and incoming ops", () => {
    const sim = makeNet(2);
    sim.partition(["S1"]);

    typeString(sim, "S1", "abc"); // outgoing: 3 ops queued
    typeString(sim, "S2", "xyz"); // will be queued as incoming for S1
    sim.step();

    // S1 has 3 outgoing + 3 incoming = 6 total queued
    expect(sim.queuedForSite("S1")).toBe(6);
    // S2 delivered its ops but S1 didn't receive them
    expect(sim.getReplica("S2")!.getText()).toBe("xyz");
    expect(sim.getReplica("S1")!.getText()).toBe("abc");
  });

  test("online replicas converge while one is partitioned", () => {
    const sim = makeNet(3);
    sim.partition(["S1"]);
    typeString(sim, "S2", "online");
    sim.runAll();
    // S2 and S3 converge; S1 is isolated
    expect(sim.assertConverged()).toBe(true); // online only
    expect(sim.assertAllConverged()).toBe(false); // S1 is behind
    expect(sim.getReplica("S2")!.getText()).toBe(sim.getReplica("S3")!.getText());
    expect(sim.getReplica("S1")!.getText()).toBe("");
  });
});

// ── partition / heal ──────────────────────────────────────────────────────────

describe("NetworkSim — heal flushes both queues", () => {
  test("heal delivers partitioned site outgoing ops to online sites", () => {
    const sim = makeNet(2);
    sim.partition(["S1"]);
    typeString(sim, "S1", "was-offline");
    sim.step(); // S1's ops held; nothing delivered

    sim.heal();
    sim.runAll();

    expect(sim.assertAllConverged()).toBe(true);
    expect(sim.getReplica("S2")!.getText()).toBe("was-offline");
  });

  test("heal delivers online ops to formerly partitioned site", () => {
    const sim = makeNet(2);
    sim.partition(["S1"]);
    typeString(sim, "S2", "from-online");
    sim.step(); // S2's ops queued as incoming for S1

    sim.heal();
    sim.runAll();

    expect(sim.assertAllConverged()).toBe(true);
    expect(sim.getReplica("S1")!.getText()).toBe("from-online");
  });

  test("heal delivers both directions and all replicas converge", () => {
    const sim = makeNet(2);
    typeString(sim, "S1", "shared");
    sim.runAll();

    sim.partition(["S1"]);
    typeString(sim, "S1", "-offline");
    typeString(sim, "S2", "-online");
    sim.step();

    // Both have diverged from each other
    expect(sim.assertAllConverged()).toBe(false);

    sim.heal();
    sim.runAll();

    expect(sim.assertAllConverged()).toBe(true);
    // Both edits present in final document
    const text = sim.getReplica("S1")!.getText();
    expect(text).toContain("online");
    expect(text).toContain("offline");
  });

  test("three replicas: one partitioned, heal, all converge", () => {
    const sim = makeNet(3);
    typeString(sim, "S1", "base");
    sim.runAll();

    sim.partition(["S2"]);
    typeString(sim, "S1", "A");
    typeString(sim, "S2", "B");
    typeString(sim, "S3", "C");
    sim.step();

    // S1 and S3 converge; S2 is isolated
    expect(sim.assertConverged()).toBe(true);  // online
    expect(sim.assertAllConverged()).toBe(false);

    sim.heal();
    sim.runAll();

    expect(sim.assertAllConverged()).toBe(true);
    const text = sim.getReplica("S1")!.getText();
    expect(text.length).toBe(7); // "base" + A + B + C
  });

  test("heal with no partition is a no-op", () => {
    const sim = makeNet(2);
    typeString(sim, "S1", "hello");
    sim.runAll();
    sim.heal(); // no partition active
    expect(sim.assertAllConverged()).toBe(true);
  });

  test("queuedForSite returns 0 after heal", () => {
    const sim = makeNet(2);
    sim.partition(["S1"]);
    typeString(sim, "S1", "abc");
    typeString(sim, "S2", "xyz");
    sim.step();

    expect(sim.queuedForSite("S1")).toBeGreaterThan(0);
    sim.heal();
    sim.runAll();
    expect(sim.queuedForSite("S1")).toBe(0);
  });
});

// ── assertConverged ───────────────────────────────────────────────────────────

describe("NetworkSim — convergence assertions", () => {
  test("assertConverged checks online replicas only", () => {
    const sim = makeNet(2);
    sim.partition(["S1"]);
    typeString(sim, "S2", "hello");
    sim.runAll();
    // S2 is online and has content; S1 is offline and empty
    // assertConverged() should return true (only online replicas)
    expect(sim.assertConverged()).toBe(true);
    expect(sim.assertAllConverged()).toBe(false);
  });

  test("assertAllConverged requires all replicas to match", () => {
    const sim = makeNet(2);
    typeString(sim, "S1", "x");
    sim.runAll();
    expect(sim.assertAllConverged()).toBe(true);
  });

  test("expectConverged returns common text of online replicas", () => {
    const sim = makeNet(2);
    typeString(sim, "S1", "same");
    sim.runAll();
    expect(sim.expectConverged()).toBe("same");
  });

  test("expectConverged throws when online replicas diverge", () => {
    const sim = makeNet(2);
    typeString(sim, "S1", "aaa");
    typeString(sim, "S2", "bbb");
    // no step — diverged
    expect(() => sim.expectConverged()).toThrow();
  });
});

// ── manual broadcast ──────────────────────────────────────────────────────────

describe("NetworkSim — manual broadcast", () => {
  test("broadcast skips sender", () => {
    const sim = makeNet(2);
    const r = sim.getReplica("S1")!;
    const op = r.insert(0, "z");
    r.drainOutbox();
    sim.broadcast(op, "S1");
    expect(sim.getReplica("S2")!.getText()).toBe("z");
    expect(sim.getReplica("S1")!.getText()).toBe("z");
  });

  test("broadcast to partitioned receiver queues in heldIncoming", () => {
    const sim = makeNet(2);
    sim.partition(["S2"]);
    const r = sim.getReplica("S1")!;
    const op = r.insert(0, "x");
    r.drainOutbox();
    sim.broadcast(op, "S1");
    // S2 is partitioned — should not have received it
    expect(sim.getReplica("S2")!.getText()).toBe("");
    expect(sim.queuedForSite("S2")).toBe(1);
  });
});

// ── diagnostics ───────────────────────────────────────────────────────────────

describe("NetworkSim — diagnostics", () => {
  test("dumpTexts returns text per siteId", () => {
    const sim = makeNet(2);
    typeString(sim, "S1", "hi");
    const dump = sim.dumpTexts();
    expect(dump["S1"]).toBe("hi");
    expect(dump["S2"]).toBe("");
  });

  test("totalPending counts buffered ops on online replicas only", () => {
    const sim = makeNet(2);
    sim.partition(["S2"]);
    const rA = sim.getReplica("S1")!;
    const rB = sim.getReplica("S2")!;

    // Generate two causally chained ops on S1, deliver op2 to S2 before op1
    const op1 = rA.insert(0, "a");
    const op2 = rA.insert(1, "b");
    rA.drainOutbox();

    // Manually deliver op2 to S2 first (bypassing partition for this test)
    rB.receive(op2);
    // op2 is buffered in S2's causal buffer waiting for op1
    // But S2 is partitioned so totalPending() should not count it
    expect(sim.totalPending()).toBe(0);
  });

  test("isPartitioned returns correct state", () => {
    const sim = makeNet(2);
    expect(sim.isPartitioned("S1")).toBe(false);
    sim.partition(["S1"]);
    expect(sim.isPartitioned("S1")).toBe(true);
    sim.heal();
    expect(sim.isPartitioned("S1")).toBe(false);
  });
});

// ── LWW metadata ─────────────────────────────────────────────────────────────

describe("NetworkSim — LWW metadata", () => {
  test("LWW metadata converges when manually merged", () => {
    const sim = makeNet(2);
    sim.getReplica("S1")!.setMeta("title", "Doc 1", 100);
    sim.getReplica("S2")!.setMeta("title", "Doc 2", 200);

    const snap1 = sim.getReplica("S1")!.lww.snapshot();
    const snap2 = sim.getReplica("S2")!.lww.snapshot();
    sim.getReplica("S1")!.mergeMeta(snap2);
    sim.getReplica("S2")!.mergeMeta(snap1);

    expect(sim.assertLWWConverged("title")).toBe(true);
    expect(sim.getReplica("S1")!.lww.get("title")).toBe("Doc 2");
  });
});

// ── stress ────────────────────────────────────────────────────────────────────

describe("NetworkSim — stress", () => {
  test("5 replicas, 20 ops each, random delivery, converge", () => {
    const sim = new NetworkSim(99);
    for (let i = 1; i <= 5; i++) sim.addReplica(new Replica(`S${i}`));
    const chars = "abcde";
    for (let i = 1; i <= 5; i++) typeString(sim, `S${i}`, chars[i - 1]!.repeat(20));
    sim.runAll("random");
    expect(sim.assertAllConverged()).toBe(true);
    expect(sim.getReplica("S1")!.getLength()).toBe(100);
  }, 10000);

  test("partition half, let others sync, heal, all converge", () => {
    const sim = new NetworkSim(7);
    for (let i = 1; i <= 4; i++) sim.addReplica(new Replica(`S${i}`));

    typeString(sim, "S1", "base");
    sim.runAll();

    sim.partition(["S3", "S4"]);
    typeString(sim, "S1", "A");
    typeString(sim, "S2", "B");
    typeString(sim, "S3", "C");
    typeString(sim, "S4", "D");
    sim.runAll();

    expect(sim.assertConverged()).toBe(true);   // S1+S2 online
    expect(sim.assertAllConverged()).toBe(false); // S3+S4 behind

    sim.heal();
    sim.runAll();
    expect(sim.assertAllConverged()).toBe(true);
  }, 10000);
});