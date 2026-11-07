/**
 * integration.test.ts — end-to-end Phase 2 prototype test.
 *
 * Spins up a real RelayServer on a random port, connects two real ClientSync
 * instances over real WebSockets (using the `ws` package), exercises the
 * partition/reconnect scenario from the Day 17 checkpoint.
 *
 * Validates:
 *   - Two clients converge on insert ops sent over a real WebSocket
 *   - Disconnecting one client does not block the other
 *   - Offline ops are queued in IndexedDB and flushed on reconnect
 *   - Role enforcement: viewers cannot insert
 *
 * API expectations (from RelayServer.ts and SessionManager.ts):
 *   - new RelayServer(port, sessionManager)
 *   - server.start(): Promise<void>
 *   - server.stop(): Promise<void>
 *   - new SessionManager()
 *   - sessionManager.initSession(): { ownerSiteId, ownerToken, sessionSecret }
 *   - sessionManager.mintToken(siteId, role): string
 */

import "fake-indexeddb/auto";
import WebSocket from "ws";
import { ClientSync } from "../src/client/ClientSync";
import { RelayServer } from "../src/server/RelayServer";
import { SessionManager } from "../src/server/SessionManager";
import { Role } from "../shared/roles";
import type { WebSocketConstructor } from "../src/client/ConnectionManager";
import type { RGAOperation } from "../../crdt-engine/src/types";

const WSImpl = WebSocket as unknown as WebSocketConstructor;

// ── Wait helpers ──────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 3000,
  intervalMs = 25
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(intervalMs);
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

// ── Per-test setup ────────────────────────────────────────────────────────────

let port: number;
let server: RelayServer;
let sessionManager: SessionManager;

let alice: ClientSync;
let bob: ClientSync;

// Increment for each test to avoid IndexedDB DB-name collisions between tests
let testCounter = 0;

beforeEach(async () => {
  testCounter++;
  // Random ephemeral port — unlikely to collide with other tests
  port = 9000 + Math.floor(Math.random() * 1000);

  sessionManager = new SessionManager();
  // initSession sets up the secret and registers an owner siteId, but we
  // don't use the owner token here — we mint per-test tokens for alice/bob.
  sessionManager.initSession();

  server = new RelayServer(port, sessionManager);
  await server.start();
});

afterEach(async () => {
  if (alice) {
    try { alice.close(); } catch { /* ignore */ }
  }
  if (bob) {
    try { bob.close(); } catch { /* ignore */ }
  }
  await server.stop();
  await sleep(50); // let sockets actually close
});

// ── Utility: connect a client ─────────────────────────────────────────────────

async function makeClient(siteId: string, role: Role): Promise<ClientSync> {
  const token = sessionManager.mintToken(siteId, role);
  const client = new ClientSync(siteId, `ws://localhost:${port}`, token, {
    connection: { WebSocketImpl: WSImpl, initialBackoffMs: 100 },
  });
  await client.connect();
  return client;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Phase 2 integration — basic two-client convergence", () => {
  test("two clients exchange a single insert via the relay", async () => {
    alice = await makeClient(`alice-${testCounter}`, Role.Editor);
    bob = await makeClient(`bob-${testCounter}`, Role.Editor);

    const bobReceived: RGAOperation[] = [];
    bob.onOpsApplied = (ops) => bobReceived.push(...ops);

    alice.insert(0, "h");
    alice.insert(1, "i");

    await waitFor(() => bobReceived.length >= 2);

    expect(bob.getText()).toBe("hi");
    expect(alice.getText()).toBe("hi");
  });

  test("three clients all converge", async () => {
    alice = await makeClient(`alice-${testCounter}`, Role.Editor);
    bob = await makeClient(`bob-${testCounter}`, Role.Editor);
    const charlie = await makeClient(`charlie-${testCounter}`, Role.Editor);

    try {
      alice.insert(0, "A");
      bob.insert(0, "B");
      charlie.insert(0, "C");

      // Each client sees all other clients' ops eventually
      await waitFor(() =>
        alice.getText().length === 3 &&
        bob.getText().length === 3 &&
        charlie.getText().length === 3
      );

      expect(alice.getText()).toBe(bob.getText());
      expect(bob.getText()).toBe(charlie.getText());
    } finally {
      charlie.close();
    }
  });
});

describe("Phase 2 integration — offline editing and reconnect", () => {
  test("ops typed offline are persisted and flushed on reconnect", async () => {
    alice = await makeClient(`alice-${testCounter}`, Role.Editor);
    bob = await makeClient(`bob-${testCounter}`, Role.Editor);

    const bobReceived: RGAOperation[] = [];
    bob.onOpsApplied = (ops) => bobReceived.push(...ops);

    // Establish baseline
    alice.insert(0, "online");
    await waitFor(() => bob.getText() === "online");

    const baselineOpCount = bobReceived.length;

    // Alice goes offline
    alice.disconnect();
    await sleep(100);

    // Type while offline — these go to IndexedDB
    alice.insert(6, "-offline");
    await sleep(150);

    // Bob does NOT see Alice's offline edits yet
    expect(bob.getText()).toBe("online");
    const queueSizeBeforeReconnect = await alice.getOfflineQueueSize();
    expect(queueSizeBeforeReconnect).toBeGreaterThan(0);

    // Diagnostic: log queue size
    // console.log(`Queue before reconnect: ${queueSizeBeforeReconnect}`);

    // Alice reconnects — flushQueue() runs in handleWelcome via void
    await alice.connect();

    // Wait for at least one new op to arrive at Bob
    await waitFor(
      () => bobReceived.length > baselineOpCount,
      8000,
      50
    );

    // Now wait for full convergence
    await waitFor(() => bob.getText() === alice.getText(), 8000, 50);

    expect(bob.getText()).toBe(alice.getText());
    expect(alice.getText()).toContain("online");
    expect(alice.getText()).toContain("offline");

    // Queue should be empty after successful flush
    await waitFor(async () => (await alice.getOfflineQueueSize()) === 0, 2000);
    expect(await alice.getOfflineQueueSize()).toBe(0);
  }, 20000);
});

describe("Phase 2 integration — late joiner receives history via op log", () => {
  test("bob joins after alice's edits and converges via relay replay", async () => {
    alice = await makeClient(`alice-${testCounter}`, Role.Editor);

    // Alice edits before bob joins
    alice.insert(0, "h");
    alice.insert(1, "e");
    alice.insert(2, "l");
    alice.insert(3, "l");
    alice.insert(4, "o");

    // Wait for relay to have processed all ops
    await waitFor(() => server.getLogSize() >= 5, 3000);

    // Bob joins late — relay should replay alice's ops
    bob = await makeClient(`bob-${testCounter}`, Role.Editor);

    await waitFor(() => bob.getText() === "hello", 5000);
    expect(bob.getText()).toBe("hello");
  }, 15000);

  test("late joiner sees history then live ops converge", async () => {
    alice = await makeClient(`alice-${testCounter}`, Role.Editor);

    alice.insert(0, "h");
    alice.insert(1, "i");
    await waitFor(() => server.getLogSize() >= 2, 3000);

    // Bob joins late
    bob = await makeClient(`bob-${testCounter}`, Role.Editor);
    await waitFor(() => bob.getText() === "hi", 5000);

    // Live op after bob joined — should also arrive normally
    alice.insert(2, "!");
    await waitFor(() => bob.getText() === "hi!", 3000);
    expect(bob.getText()).toBe("hi!");
    expect(alice.getText()).toBe("hi!");
  }, 15000);
});

describe("Phase 2 integration — bidirectional offline sync", () => {
  test("alice offline edits flush outbound; relay replays bob's edits inbound on reconnect", async () => {
    alice = await makeClient(`alice-${testCounter}`, Role.Editor);
    bob = await makeClient(`bob-${testCounter}`, Role.Editor);

    // Both start with "hello"
    alice.insert(0, "h");
    alice.insert(1, "e");
    alice.insert(2, "l");
    alice.insert(3, "l");
    alice.insert(4, "o");
    await waitFor(() => bob.getText() === "hello", 5000);

    // Alice goes offline
    alice.disconnect();
    await sleep(100);

    // Alice types while offline — queued locally
    alice.insert(5, "-alice");
    await sleep(100);

    // Bob types while alice is offline — relayed live, alice misses it
    bob.insert(5, "-bob");
    await waitFor(() => bob.getText().includes("-bob"), 3000);

    expect(alice.getText()).toContain("-alice");
    expect(alice.getText()).not.toContain("-bob");

    // Alice reconnects:
    //   outbound: OfflineQueue flushes "-alice" ops to relay → bob receives
    //   inbound:  relay replays "-bob" ops alice missed → alice receives
    await alice.connect();

    await waitFor(() => alice.getText() === bob.getText(), 8000);

    expect(alice.getText()).toBe(bob.getText());
    expect(alice.getText()).toContain("hello");
    expect(alice.getText()).toContain("-alice");
    expect(alice.getText()).toContain("-bob");
  }, 25000);
});

describe("Phase 2 integration — role enforcement", () => {
  test("viewer cannot insert; editor can", async () => {
    alice = await makeClient(`alice-${testCounter}`, Role.Editor);
    bob = await makeClient(`bob-${testCounter}`, Role.Viewer);

    // Track what Alice receives — she should NOT see Bob's rejected op
    const aliceReceived: RGAOperation[] = [];
    alice.onOpsApplied = (ops) => aliceReceived.push(...ops);

    // Bob (viewer) tries to insert — local Replica accepts (CRDT layer
    // doesn't know about roles); relay rejects forwarding.
    bob.insert(0, "X");

    // Give relay time to process and reject
    await sleep(300);

    // Alice should not have seen Bob's op
    expect(alice.getText()).toBe("");
    expect(aliceReceived.length).toBe(0);

    // Now Alice (editor) inserts — should succeed and reach Bob
    alice.insert(0, "ok");

    // Wait for Alice's op to reach Bob (independently of Bob's rejected op)
    await waitFor(() => bob.getText().includes("ok"), 5000);
    expect(bob.getText()).toContain("ok");
  }, 10000);
});