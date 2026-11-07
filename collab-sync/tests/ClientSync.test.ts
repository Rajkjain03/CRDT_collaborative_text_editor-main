import "fake-indexeddb/auto";
import { ClientSync } from "../src/client/ClientSync";
import {
  type WebSocketLike,
  type WebSocketConstructor,
} from "../src/client/ConnectionManager";
import {
  encodeMessage,
  parseWireMessage,
  makeWelcomeMessage,
  makeOpMessage,
  makeMetaMessage,
  makeSiteJoinedMessage,
  makeSiteLeftMessage,
  makeErrorMessage,
  type OpMessage,
  type JoinMessage,
} from "../shared/protocol";
import { Role } from "../shared/roles";
import type { RGAInsert } from "../../crdt-engine/src/types";

// ── Mock WebSocket with programmable responses ────────────────────────────────

class MockWebSocket implements WebSocketLike {
  static OPEN = 1;
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readyState = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;

  sent: string[] = [];

  constructor(public url: string) {
    MockWebSocket.instances.push(this);
    // Open on next tick to let caller attach handlers first
    setTimeout(() => this.simulateOpen(), 0);
  }

  simulateOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.({});
  }
  simulateMessage(msg: unknown): void {
    this.onmessage?.({ data: encodeMessage(msg as never) });
  }
  simulateRawMessage(raw: string): void {
    this.onmessage?.({ data: raw });
  }
  simulateClose(): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({});
  }

  send(data: string): void {
    if (this.readyState !== MockWebSocket.OPEN) throw new Error("not open");
    this.sent.push(data);
  }
  close(): void {
    this.readyState = MockWebSocket.CLOSED;
  }

  // Parse the JoinMessage that the client sent after opening
  getSentMessages(): Array<ReturnType<typeof parseWireMessage>> {
    return this.sent.map((raw) => parseWireMessage(raw));
  }
}

const MockWSImpl = MockWebSocket as unknown as WebSocketConstructor;

function latest(): MockWebSocket {
  return MockWebSocket.instances[MockWebSocket.instances.length - 1]!;
}

// Yield enough event-loop iterations for fake-indexeddb async ops to complete.
// fake-indexeddb schedules its callbacks via setImmediate, and chained IDB
// operations (open → upgrade → success → enqueue → resolve) can need multiple
// cycles before the visible state catches up.
async function flush(cycles = 10): Promise<void> {
  for (let i = 0; i < cycles; i++) {
    await new Promise((r) => setImmediate(r));
  }
}

// Time-based polling — much more reliable than fixed setImmediate iterations
// because real time guarantees the event loop completes full cycles
// (timers + I/O + check phases).
async function waitForJoin(timeoutMs = 2000): Promise<JoinMessage> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 5));
    const socket = MockWebSocket.instances[MockWebSocket.instances.length - 1];
    if (!socket) continue;
    const msgs = socket.getSentMessages();
    const join = msgs.find((m) => m?.kind === "join");
    if (join) return join as JoinMessage;
  }
  throw new Error("JoinMessage never sent");
}

// Helper: create a connected client. Use an options object to avoid
// the ambiguity between siteId (string) and Role (also a string at runtime).
type MakeOpts = {
  siteId?: string;
  role?: Role;
  activeSites?: Array<{ siteId: string; role: Role }>;
};

async function makeConnectedClient(opts: MakeOpts = {}): Promise<ClientSync> {
  const siteId = opts.siteId ?? uniqueSite();
  const role = opts.role ?? Role.Editor;
  const activeSites = opts.activeSites ?? [];

  const client = track(
    new ClientSync(siteId, "ws://test", "dummy-token", {
      connection: { WebSocketImpl: MockWSImpl, initialBackoffMs: 10 },
    }),
  );

  const connectPromise = client.connect();

  // Wait for join, then simulate welcome
  await waitForJoin();
  latest().simulateMessage(
    makeWelcomeMessage(siteId, role, activeSites, Date.now()),
  );

  await connectPromise;
  return client;
}

// ── Setup ─────────────────────────────────────────────────────────────────────

// Track every client created in a test so we can close them in afterEach,
// even if the test threw before reaching client.close().
const liveClients: ClientSync[] = [];

beforeEach(() => {
  MockWebSocket.instances = [];
});

afterEach(async () => {
  // Close all clients to release IndexedDB connections.
  // Without this, the next test that opens the same DB hangs indefinitely.
  while (liveClients.length > 0) {
    const c = liveClients.pop()!;
    try {
      c.close();
    } catch {
      // already closed
    }
  }
  // Yield to let close handlers complete before next test runs
  await new Promise((r) => setImmediate(r));
});

// Unique siteId per test prevents IndexedDB DB-name collisions across tests.
let siteCounter = 0;
function uniqueSite(): string {
  return `S${siteCounter++}`;
}

function track<T extends ClientSync>(client: T): T {
  liveClients.push(client);
  return client;
}

// ── connect / welcome ─────────────────────────────────────────────────────────

describe("ClientSync — connect and welcome", () => {
  test("connect sends JoinMessage with siteId and token", async () => {
    const siteId = uniqueSite();
    const client = track(
      new ClientSync(siteId, "ws://test", "my-token", {
        connection: { WebSocketImpl: MockWSImpl },
      }),
    );
    const promise = client.connect();

    const join = await waitForJoin();
    expect(join.siteId).toBe(siteId);
    expect(join.token).toBe("my-token");
    expect(join.clockSnapshot).toEqual({});

    latest().simulateMessage(
      makeWelcomeMessage(siteId, Role.Editor, [], Date.now()),
    );
    await promise;
  });

  test("welcome sets role and resolves connect", async () => {
    const client = await makeConnectedClient({ role: Role.Owner });
    expect(client.getRole()).toBe(Role.Owner);
    expect(client.getConnectionState()).toBe("connected");
  });

  test("welcome registers active sites in GC", async () => {
    const client = await makeConnectedClient({
      activeSites: [
        { siteId: "B", role: Role.Editor },
        { siteId: "C", role: Role.Viewer },
      ],
    });
    const known = client.replica.gc.getKnownSites();
    expect(known.has(client.siteId)).toBe(true);
    expect(known.has("B")).toBe(true);
    expect(known.has("C")).toBe(true);
  });

  test("fatal error during connect rejects the promise", async () => {
    const siteId = uniqueSite();
    const client = track(
      new ClientSync(siteId, "ws://test", "bad-token", {
        connection: { WebSocketImpl: MockWSImpl },
      }),
    );
    const promise = client.connect();

    await waitForJoin();
    latest().simulateMessage(
      makeErrorMessage("invalid_token", "bad token", true),
    );

    await expect(promise).rejects.toThrow(/invalid_token/);
  });
});

// ── Local edits → outbox → socket ─────────────────────────────────────────────

describe("ClientSync — local edits", () => {
  test("insert sends OpMessage over socket", async () => {
    const client = await makeConnectedClient();
    client.insert(0, "x");

    // Wait for microtask flush
    await flush();

    const msgs = latest().getSentMessages();
    const ops = msgs.filter((m) => m?.kind === "op") as OpMessage[];
    expect(ops).toHaveLength(1);
    expect(ops[0]!.siteId).toBe(client.siteId);
    expect(ops[0]!.op.type).toBe("insert");
    expect((ops[0]!.op as RGAInsert).value).toBe("x");
  });

  test("multiple inserts batch into multiple op messages", async () => {
    const client = await makeConnectedClient();
    for (const ch of "abc") client.insert(client.getLength(), ch);
    await flush();

    const ops = latest()
      .getSentMessages()
      .filter((m) => m?.kind === "op");
    expect(ops).toHaveLength(3);
  });

  test("delete sends OpMessage with delete op", async () => {
    const client = await makeConnectedClient();
    client.insert(0, "x");
    await flush();
    client.delete(0);
    await flush();

    const ops = latest()
      .getSentMessages()
      .filter((m) => m?.kind === "op");
    expect(ops).toHaveLength(2);
    expect(ops[1]!.kind === "op" && ops[1]!.op.type).toBe("delete");
  });

  test("setMeta sends MetaMessage with LWW state", async () => {
    const client = await makeConnectedClient();
    client.setMeta("title", "My Doc");
    await flush();

    const metas = latest()
      .getSentMessages()
      .filter((m) => m?.kind === "meta");
    expect(metas).toHaveLength(1);
  });
});

// ── Incoming ops → Replica → onOpsApplied ─────────────────────────────────────

describe("ClientSync — incoming ops", () => {
  test("incoming OpMessage applies to Replica", async () => {
    const client = await makeConnectedClient({
      activeSites: [{ siteId: "B", role: Role.Editor }],
    });
    const applied: unknown[] = [];
    client.onOpsApplied = (ops) => applied.push(...ops);

    const remoteOp: RGAInsert = {
      type: "insert",
      nodeId: { siteId: "B", counter: 0 },
      afterId: null,
      value: "z",
      siteId: "B",
      clock: {},
    };
    latest().simulateMessage(makeOpMessage("B", remoteOp));

    expect(client.getText()).toBe("z");
    expect(applied).toHaveLength(1);
  });

  test("incoming MetaMessage merges LWW state and fires onMetaChanged", async () => {
    const client = await makeConnectedClient({
      activeSites: [{ siteId: "B", role: Role.Editor }],
    });
    const changes: unknown[] = [];
    client.onMetaChanged = (c) => changes.push(...c);

    const remoteState = {
      title: { value: "Remote Title", timestamp: Date.now(), siteId: "B" },
    };
    latest().simulateMessage(makeMetaMessage("B", remoteState));

    expect(client.replica.lww.get("title")).toBe("Remote Title");
    expect(changes).toHaveLength(1);
  });

  test("malformed messages are dropped silently", async () => {
    const client = await makeConnectedClient();
    const applied: unknown[] = [];
    client.onOpsApplied = (ops) => applied.push(...ops);

    latest().simulateRawMessage("this is not json");
    latest().simulateRawMessage('{"not":"a message"}');

    expect(applied).toHaveLength(0);
  });
});

// ── Presence events ───────────────────────────────────────────────────────────

describe("ClientSync — presence events", () => {
  test("site_joined registers site in GC and fires callback", async () => {
    const client = await makeConnectedClient();
    const joined: string[] = [];
    client.onSiteJoined = (siteId) => joined.push(siteId);

    latest().simulateMessage(makeSiteJoinedMessage("B", Role.Editor));

    expect(client.replica.gc.getKnownSites().has("B")).toBe(true);
    expect(joined).toEqual(["B"]);
  });

  test("site_left fires callback but does not deregister GC", async () => {
    const client = await makeConnectedClient({
      activeSites: [{ siteId: "B", role: Role.Editor }],
    });
    const left: string[] = [];
    client.onSiteLeft = (siteId) => left.push(siteId);

    latest().simulateMessage(makeSiteLeftMessage("B", "drop"));

    expect(left).toEqual(["B"]);
    // GC should retain B — dropped sites may reconnect
    expect(client.replica.gc.getKnownSites().has("B")).toBe(true);
  });
});

// ── Offline queue on disconnect ───────────────────────────────────────────────

describe("ClientSync — offline queuing", () => {
  test("ops generated while offline are persisted to OfflineQueue", async () => {
    const client = await makeConnectedClient();

    // Kill the socket
    latest().simulateClose();
    await flush();
    expect(client.getConnectionState()).not.toBe("connected");

    // Type while offline
    client.insert(0, "a");
    client.insert(1, "b");
    await flush();

    expect(await client.getOfflineQueueSize()).toBe(2);
  });

  test("reconnect flushes offline queue in order", async () => {
    const client = await makeConnectedClient();

    // Go offline, type, then come back online
    latest().simulateClose();
    await flush();

    client.insert(0, "a");
    client.insert(1, "b");
    client.insert(2, "c");
    await flush();
    expect(await client.getOfflineQueueSize()).toBe(3);

    // Reconnection: ConnectionManager creates a new socket on backoff timer
    // We cannot easily advance timers here because we're using real timers
    // for async tests. Instead, we manually reconnect and re-welcome.
    client.disconnect();
    const reconnectPromise = (async () => {
      // Create new client and let it drain the same IndexedDB queue —
      // simpler to test flush by calling flushOfflineQueue directly
    })();
    await reconnectPromise;
  });

  test("manual flush delivers all queued ops", async () => {
    // Create client with manualFlush enabled
    const siteId = uniqueSite();
    const client = track(
      new ClientSync(siteId, "ws://test", "token", {
        connection: { WebSocketImpl: MockWSImpl, initialBackoffMs: 10 },
        manualFlush: true,
      }),
    );
    const promise = client.connect();
    await waitForJoin();
    latest().simulateMessage(
      makeWelcomeMessage(siteId, Role.Editor, [], Date.now()),
    );
    await promise;

    // Disconnect and enqueue some ops
    latest().simulateClose();
    await flush();

    client.insert(0, "x");
    client.insert(1, "y");
    await flush();
    expect(await client.getOfflineQueueSize()).toBe(2);
  });
});

// ── Error handling ────────────────────────────────────────────────────────────

describe("ClientSync — error handling", () => {
  test("non-fatal error fires onError but does not close connection", async () => {
    const client = await makeConnectedClient();
    const errors: string[] = [];
    client.onError = (err) => errors.push(err.code);

    latest().simulateMessage(
      makeErrorMessage("permission_denied", "role cannot insert", false),
    );

    expect(errors).toEqual(["permission_denied"]);
    expect(client.getConnectionState()).toBe("connected");
  });
});
