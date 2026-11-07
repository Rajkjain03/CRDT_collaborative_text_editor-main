import { LWWRegister, LWWState } from "../../src/lww/LWWRegister";

describe("LWWRegister — set", () => {
  test("set stores a value and retrieves it", () => {
    const reg = new LWWRegister<string>();
    reg.set("title", "My Doc", 100, "A");
    expect(reg.get("title")).toBe("My Doc");
  });

  test("set returns an LWWUpdate with correct fields", () => {
    const reg = new LWWRegister<number>();
    const update = reg.set("count", 42, 200, "B");
    expect(update.type).toBe("lww_update");
    expect(update.field).toBe("count");
    expect(update.value).toBe(42);
    expect(update.timestamp).toBe(200);
    expect(update.siteId).toBe("B");
  });

  test("later timestamp overwrites earlier", () => {
    const reg = new LWWRegister<string>();
    reg.set("title", "Old", 100, "A");
    reg.set("title", "New", 200, "A");
    expect(reg.get("title")).toBe("New");
  });

  test("earlier timestamp does not overwrite later", () => {
    const reg = new LWWRegister<string>();
    reg.set("title", "Current", 200, "A");
    reg.set("title", "Stale", 100, "A");
    expect(reg.get("title")).toBe("Current");
  });

  test("same timestamp: higher siteId wins", () => {
    const reg = new LWWRegister<string>();
    reg.set("x", "from-A", 100, "A");
    reg.set("x", "from-C", 100, "C");
    expect(reg.get("x")).toBe("from-C"); // C > A lex
  });

  test("same timestamp: lower siteId does not overwrite", () => {
    const reg = new LWWRegister<string>();
    reg.set("x", "from-C", 100, "C");
    reg.set("x", "from-A", 100, "A");
    expect(reg.get("x")).toBe("from-C");
  });

  test("multiple fields are independent", () => {
    const reg = new LWWRegister<string>();
    reg.set("title", "Doc", 100, "A");
    reg.set("status", "active", 200, "B");
    expect(reg.get("title")).toBe("Doc");
    expect(reg.get("status")).toBe("active");
  });

  test("get returns undefined for unset field", () => {
    const reg = new LWWRegister<string>();
    expect(reg.get("unknown")).toBeUndefined();
  });
});

describe("LWWRegister — merge", () => {
  test("merge applies remote field that does not exist locally", () => {
    const local = new LWWRegister<string>();
    const remote: LWWState<string> = {
      title: { value: "Remote Doc", timestamp: 100, siteId: "B" },
    };
    const changed = local.merge(remote);
    expect(local.get("title")).toBe("Remote Doc");
    expect(changed).toHaveLength(1);
    expect(changed[0]!.field).toBe("title");
    expect(changed[0]!.value).toBe("Remote Doc");
  });

  test("merge takes remote value when remote timestamp is higher", () => {
    const local = new LWWRegister<string>();
    local.set("title", "Old", 100, "A");
    const remote: LWWState<string> = {
      title: { value: "New", timestamp: 200, siteId: "B" },
    };
    local.merge(remote);
    expect(local.get("title")).toBe("New");
  });

  test("merge keeps local value when local timestamp is higher", () => {
    const local = new LWWRegister<string>();
    local.set("title", "Current", 300, "A");
    const remote: LWWState<string> = {
      title: { value: "Stale", timestamp: 100, siteId: "B" },
    };
    const changed = local.merge(remote);
    expect(local.get("title")).toBe("Current");
    expect(changed).toHaveLength(0);
  });

  test("merge tie: remote siteId higher → remote wins", () => {
    const local = new LWWRegister<string>();
    local.set("x", "local-A", 100, "A");
    const remote: LWWState<string> = {
      x: { value: "remote-C", timestamp: 100, siteId: "C" },
    };
    local.merge(remote);
    expect(local.get("x")).toBe("remote-C");
  });

  test("merge tie: remote siteId lower → local wins", () => {
    const local = new LWWRegister<string>();
    local.set("x", "local-C", 100, "C");
    const remote: LWWState<string> = {
      x: { value: "remote-A", timestamp: 100, siteId: "A" },
    };
    const changed = local.merge(remote);
    expect(local.get("x")).toBe("local-C");
    expect(changed).toHaveLength(0);
  });

  test("merge returns only changed fields", () => {
    const local = new LWWRegister<string>();
    local.set("a", "v1", 100, "A");
    local.set("b", "v2", 300, "A");
    const remote: LWWState<string> = {
      a: { value: "v1-new", timestamp: 200, siteId: "B" }, // newer → changes
      b: { value: "v2-old", timestamp: 100, siteId: "B" }, // older → no change
    };
    const changed = local.merge(remote);
    expect(changed).toHaveLength(1);
    expect(changed[0]!.field).toBe("a");
  });

  test("merge is idempotent — applying same snapshot twice is no-op", () => {
    const local = new LWWRegister<string>();
    const remote: LWWState<string> = {
      title: { value: "X", timestamp: 100, siteId: "B" },
    };
    local.merge(remote);
    const changed2 = local.merge(remote);
    expect(changed2).toHaveLength(0);
    expect(local.get("title")).toBe("X");
  });
});

describe("LWWRegister — convergence", () => {
  test("two registers merging each other converge to same state", () => {
    const regA = new LWWRegister<string>();
    const regB = new LWWRegister<string>();

    regA.set("title", "Doc from A", 100, "A");
    regB.set("title", "Doc from B", 200, "B");
    regA.set("status", "draft", 150, "A");
    regB.set("status", "review", 50, "B");

    // Cross-merge
    regA.merge(regB.snapshot());
    regB.merge(regA.snapshot());

    expect(regA.get("title")).toBe(regB.get("title"));
    expect(regA.get("status")).toBe(regB.get("status"));
    expect(regA.get("title")).toBe("Doc from B");   // B's ts higher
    expect(regA.get("status")).toBe("draft");        // A's ts higher
  });

  test("three-way merge converges regardless of merge order", () => {
    const rA = new LWWRegister<number>();
    const rB = new LWWRegister<number>();
    const rC = new LWWRegister<number>();

    rA.set("score", 10, 100, "A");
    rB.set("score", 20, 200, "B");
    rC.set("score", 15, 150, "C");

    // Merge all pairs
    rA.merge(rB.snapshot()); rA.merge(rC.snapshot());
    rB.merge(rA.snapshot()); rB.merge(rC.snapshot());
    rC.merge(rA.snapshot()); rC.merge(rB.snapshot());

    // All should agree: B's score (timestamp 200 is highest)
    expect(rA.get("score")).toBe(20);
    expect(rB.get("score")).toBe(20);
    expect(rC.get("score")).toBe(20);
  });
});

describe("LWWRegister — snapshot and fields", () => {
  test("snapshot returns copy of all entries", () => {
    const reg = new LWWRegister<string>();
    reg.set("a", "1", 100, "A");
    reg.set("b", "2", 200, "B");
    const snap = reg.snapshot();
    expect(Object.keys(snap)).toHaveLength(2);
    expect(snap["a"]!.value).toBe("1");
    expect(snap["b"]!.value).toBe("2");
  });

  test("fields() returns all tracked field names", () => {
    const reg = new LWWRegister<string>();
    reg.set("x", "1", 100, "A");
    reg.set("y", "2", 100, "A");
    expect(reg.fields().sort()).toEqual(["x", "y"]);
  });

  test("constructor with initial state pre-populates register", () => {
    const initial: LWWState<string> = {
      title: { value: "Preloaded", timestamp: 500, siteId: "Z" },
    };
    const reg = new LWWRegister<string>(initial);
    expect(reg.get("title")).toBe("Preloaded");
  });
});
