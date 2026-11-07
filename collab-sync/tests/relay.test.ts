/**
 * tests/relay.test.ts — Integration tests for the RelayServer.
 *
 * Tests use real WebSocket connections to verify the relay's behaviour:
 * join handshake, op forwarding, role enforcement, presence events.
 */

import { WebSocket, type Data as WsData } from "ws";
import { RelayServer } from "../src/server/RelayServer.ts";
import { SessionManager } from "../src/server/SessionManager.ts";
import { Role } from "../shared/roles.ts";
import {
  serializeWireMessage,
  parseWireMessage,
} from "../shared/protocol.ts";
import type {
  WireMessage,
  JoinMessage,
  WelcomeMessage,
  OpMessage,
  MetaMessage,
  SiteJoinedMessage,
  SiteLeftMessage,
  ErrorMessage,
  RGAOperation,
  VectorClockSnapshot,
} from "../shared/protocol.ts";

// ── Test helpers ─────────────────────────────────────────────────────────────

const TEST_PORT = 19876; // high port to avoid conflicts
let relay: RelayServer;
let sm: SessionManager;

/**
 * Connect a WebSocket client, send a JoinMessage, and wait for the WelcomeMessage.
 * Returns the connected ws and the WelcomeMessage.
 */
async function connectClient(
  siteId: string,
  token: string,
  clock: VectorClockSnapshot = {}
): Promise<{ ws: WebSocket; welcome: WelcomeMessage }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${TEST_PORT}`);

    ws.on("open", () => {
      const joinMsg: JoinMessage = {
        kind: "join",
        siteId,
        token,
        clockSnapshot: clock,
      };
      ws.send(serializeWireMessage(joinMsg));
    });

    ws.on("message", (data) => {
      const msg = parseWireMessage(data.toString());
      if (msg && msg.kind === "welcome") {
        resolve({ ws, welcome: msg as WelcomeMessage });
      } else if (msg && msg.kind === "error") {
        reject(new Error((msg as ErrorMessage).message));
      }
    });

    ws.on("error", reject);

    // Timeout
    setTimeout(() => reject(new Error("Connect timeout")), 5000);
  });
}

/**
 * Wait for a specific message kind from a WebSocket.
 */
function waitForMessage(
  ws: WebSocket,
  kind: string,
  timeoutMs = 3000
): Promise<WireMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timeout waiting for "${kind}" message`)),
      timeoutMs
    );

    const handler = (data: WsData) => {
      const msg = parseWireMessage(data.toString());
      if (msg && msg.kind === kind) {
        clearTimeout(timer);
        ws.off("message", handler);
        resolve(msg);
      }
    };

    ws.on("message", handler);
  });
}

/**
 * Collect all messages received by a WebSocket within a time window.
 */
function collectMessages(ws: WebSocket, durationMs = 500): Promise<WireMessage[]> {
  return new Promise((resolve) => {
    const messages: WireMessage[] = [];
    const handler = (data: WsData) => {
      const msg = parseWireMessage(data.toString());
      if (msg) messages.push(msg);
    };
    ws.on("message", handler);
    setTimeout(() => {
      ws.off("message", handler);
      resolve(messages);
    }, durationMs);
  });
}

/** Create a dummy RGAInsert op for testing. */
function makeInsertOp(siteId: string, counter: number, value: string): RGAOperation {
  return {
    type: "insert",
    nodeId: { siteId, counter },
    afterId: null,
    value,
    clock: { [siteId]: counter - 1 },
  };
}

/** Create a dummy RGADelete op for testing. */
function makeDeleteOp(siteId: string, targetSiteId: string, targetCounter: number): RGAOperation {
  return {
    type: "delete",
    targetId: { siteId: targetSiteId, counter: targetCounter },
    clock: { [siteId]: 1 },
  };
}

/** Small delay */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Connect, send a JoinMessage, and collect ALL messages (welcome + any
 * replayed ops) that arrive up to `collectMs` after the socket opens.
 * Registering the collector before sending the join avoids the race where
 * replayed ops arrive in the same TCP burst as the WelcomeMessage and are
 * emitted before connectClient's caller has a chance to register a listener.
 */
async function connectAndCollect(
  siteId: string,
  token: string,
  clock: VectorClockSnapshot = {},
  collectMs = 400
): Promise<{ ws: WebSocket; welcome: WelcomeMessage; ops: OpMessage[] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${TEST_PORT}`);
    const allMessages: WireMessage[] = [];
    let welcomed = false;

    ws.on("message", (data) => {
      const msg = parseWireMessage(data.toString());
      if (!msg) return;
      allMessages.push(msg);
      if (!welcomed && msg.kind === "welcome") {
        welcomed = true;
        // Wait collectMs after welcome to catch any ops arriving in later bursts
        setTimeout(() => {
          const ops = allMessages.filter((m) => m.kind === "op") as OpMessage[];
          resolve({ ws, welcome: msg as WelcomeMessage, ops });
        }, collectMs);
      } else if (msg.kind === "error") {
        reject(new Error((msg as ErrorMessage).message));
      }
    });

    ws.on("open", () => {
      ws.send(
        serializeWireMessage({
          kind: "join",
          siteId,
          token,
          clockSnapshot: clock,
        })
      );
    });

    ws.on("error", reject);
    setTimeout(() => reject(new Error("Connect+collect timeout")), 5000);
  });
}

// ── Test suite ───────────────────────────────────────────────────────────────

describe("RelayServer", () => {
  beforeEach(async () => {
    sm = new SessionManager();
    relay = new RelayServer(TEST_PORT, sm);
    await relay.start();
  });

  afterEach(async () => {
    await relay.stop();
    // Small delay to ensure port is released
    await delay(100);
  });

  // ── Join handshake ───────────────────────────────────────────────────────

  test("client receives WelcomeMessage on valid join", async () => {
    const siteId = "site-owner";
    const token = sm.mintToken(siteId, Role.Owner);
    const { ws, welcome } = await connectClient(siteId, token);

    expect(welcome.kind).toBe("welcome");
    expect(welcome.assignedSiteId).toBe(siteId);
    expect(welcome.role).toBe(Role.Owner);
    expect(welcome.activeSites.map((s: { siteId: string }) => s.siteId)).toContain(siteId);

    ws.close();
  });

  test("relay rejects join with invalid token", async () => {
    const ws = new WebSocket(`ws://localhost:${TEST_PORT}`);

    const errorPromise = new Promise<ErrorMessage>((resolve, reject) => {
      ws.on("open", () => {
        ws.send(
          serializeWireMessage({
            kind: "join",
            siteId: "hacker",
            token: "fake.token",
            clockSnapshot: {},
          })
        );
      });
      ws.on("message", (data) => {
        const msg = parseWireMessage(data.toString());
        if (msg && msg.kind === "error") resolve(msg as ErrorMessage);
      });
      ws.on("error", reject);
      setTimeout(() => reject(new Error("Timeout")), 3000);
    });

    const err = await errorPromise;
    expect(err.code).toBe("invalid_token");

    ws.close();
  });

  // ── Op forwarding ────────────────────────────────────────────────────────

  test("relay forwards insert op to all clients except sender", async () => {
    const ownerSiteId = "site-owner";
    const editorSiteId = "site-editor";
    const ownerToken = sm.mintToken(ownerSiteId, Role.Owner);
    const editorToken = sm.mintToken(editorSiteId, Role.Editor);

    const { ws: ownerWs } = await connectClient(ownerSiteId, ownerToken);

    // Wait for owner's SiteJoined notification for editor
    const editorJoinedPromise = waitForMessage(ownerWs, "site_joined");
    const { ws: editorWs } = await connectClient(editorSiteId, editorToken);
    await editorJoinedPromise;

    // Editor sends an insert op
    const insertOp = makeInsertOp(editorSiteId, 1, "A");
    const opMsg: OpMessage = {
      kind: "op",
      siteId: editorSiteId,
      op: insertOp,
    };

    // Owner should receive the op
    const opReceivedPromise = waitForMessage(ownerWs, "op");
    editorWs.send(serializeWireMessage(opMsg));
    const received = (await opReceivedPromise) as OpMessage;

    expect(received.kind).toBe("op");
    expect(received.siteId).toBe(editorSiteId);
    expect(received.op.type).toBe("insert");

    // Verify sender does NOT receive their own op
    const senderMessages = await collectMessages(editorWs, 300);
    const opsToSender = senderMessages.filter((m) => m.kind === "op");
    expect(opsToSender.length).toBe(0);

    ownerWs.close();
    editorWs.close();
  });

  test("relay forwards delete op to all clients except sender", async () => {
    const siteA = "site-a";
    const siteB = "site-b";
    const tokenA = sm.mintToken(siteA, Role.Owner);
    const tokenB = sm.mintToken(siteB, Role.Editor);

    const { ws: wsA } = await connectClient(siteA, tokenA);
    const joinPromise = waitForMessage(wsA, "site_joined");
    const { ws: wsB } = await connectClient(siteB, tokenB);
    await joinPromise;

    const deleteOp = makeDeleteOp(siteA, siteB, 1);
    const opMsg: OpMessage = {
      kind: "op",
      siteId: siteA,
      op: deleteOp,
    };

    const opReceivedPromise = waitForMessage(wsB, "op");
    wsA.send(serializeWireMessage(opMsg));
    const received = (await opReceivedPromise) as OpMessage;

    expect(received.op.type).toBe("delete");

    wsA.close();
    wsB.close();
  });

  // ── Role enforcement ─────────────────────────────────────────────────────

  test("relay rejects insert from viewer role", async () => {
    const viewerId = "site-viewer";
    const viewerToken = sm.mintToken(viewerId, Role.Viewer);
    const { ws: viewerWs } = await connectClient(viewerId, viewerToken);

    const insertOp = makeInsertOp(viewerId, 1, "X");
    const opMsg: OpMessage = {
      kind: "op",
      siteId: viewerId,
      op: insertOp,
    };

    const errorPromise = waitForMessage(viewerWs, "error");
    viewerWs.send(serializeWireMessage(opMsg));
    const err = (await errorPromise) as ErrorMessage;

    expect(err.code).toBe("permission_denied");

    viewerWs.close();
  });

  test("relay rejects delete from viewer role", async () => {
    const viewerId = "site-viewer";
    const viewerToken = sm.mintToken(viewerId, Role.Viewer);
    const { ws: viewerWs } = await connectClient(viewerId, viewerToken);

    const deleteOp = makeDeleteOp(viewerId, "some-site", 1);
    const opMsg: OpMessage = {
      kind: "op",
      siteId: viewerId,
      op: deleteOp,
    };

    const errorPromise = waitForMessage(viewerWs, "error");
    viewerWs.send(serializeWireMessage(opMsg));
    const err = (await errorPromise) as ErrorMessage;

    expect(err.code).toBe("permission_denied");

    viewerWs.close();
  });

  test("relay allows insert from editor role", async () => {
    const ownerId = "site-owner";
    const editorId = "site-editor";
    const ownerToken = sm.mintToken(ownerId, Role.Owner);
    const editorToken = sm.mintToken(editorId, Role.Editor);

    const { ws: ownerWs } = await connectClient(ownerId, ownerToken);
    const joinPromise = waitForMessage(ownerWs, "site_joined");
    const { ws: editorWs } = await connectClient(editorId, editorToken);
    await joinPromise;

    const insertOp = makeInsertOp(editorId, 1, "E");
    const opMsg: OpMessage = {
      kind: "op",
      siteId: editorId,
      op: insertOp,
    };

    const opReceivedPromise = waitForMessage(ownerWs, "op");
    editorWs.send(serializeWireMessage(opMsg));
    const received = (await opReceivedPromise) as OpMessage;

    expect(received.kind).toBe("op");
    expect(received.op.type).toBe("insert");

    ownerWs.close();
    editorWs.close();
  });

  test("relay allows insert from owner role", async () => {
    const ownerId = "site-owner";
    const editorId = "site-editor";
    const ownerToken = sm.mintToken(ownerId, Role.Owner);
    const editorToken = sm.mintToken(editorId, Role.Editor);

    const { ws: ownerWs } = await connectClient(ownerId, ownerToken);
    const joinPromise = waitForMessage(ownerWs, "site_joined");
    const { ws: editorWs } = await connectClient(editorId, editorToken);
    await joinPromise;

    const insertOp = makeInsertOp(ownerId, 1, "O");
    const opMsg: OpMessage = {
      kind: "op",
      siteId: ownerId,
      op: insertOp,
    };

    const opReceivedPromise = waitForMessage(editorWs, "op");
    ownerWs.send(serializeWireMessage(opMsg));
    const received = (await opReceivedPromise) as OpMessage;

    expect(received.kind).toBe("op");
    expect(received.op.type).toBe("insert");

    ownerWs.close();
    editorWs.close();
  });

  // ── Meta forwarding ─────────────────────────────────────────────────────

  test("relay forwards meta message to all clients except sender", async () => {
    const siteA = "site-a";
    const siteB = "site-b";
    const tokenA = sm.mintToken(siteA, Role.Owner);
    const tokenB = sm.mintToken(siteB, Role.Editor);

    const { ws: wsA } = await connectClient(siteA, tokenA);
    const joinPromise = waitForMessage(wsA, "site_joined");
    const { ws: wsB } = await connectClient(siteB, tokenB);
    await joinPromise;

    const metaMsg: MetaMessage = {
      kind: "meta",
      state: { title: { value: "My Document", timestamp: Date.now(), siteId: siteA } },
      fromSiteId: siteA,
    };

    const metaReceivedPromise = waitForMessage(wsB, "meta");
    wsA.send(serializeWireMessage(metaMsg));
    const received = (await metaReceivedPromise) as MetaMessage;

    expect(received.kind).toBe("meta");
    expect(received.fromSiteId).toBe(siteA);

    wsA.close();
    wsB.close();
  });

  // ── Presence events ──────────────────────────────────────────────────────

  test("relay broadcasts SiteJoined when client connects", async () => {
    const ownerId = "site-owner";
    const editorId = "site-editor";
    const ownerToken = sm.mintToken(ownerId, Role.Owner);
    const editorToken = sm.mintToken(editorId, Role.Editor);

    const { ws: ownerWs } = await connectClient(ownerId, ownerToken);

    // Listen for site_joined on the owner's socket
    const joinedPromise = waitForMessage(ownerWs, "site_joined");
    const { ws: editorWs } = await connectClient(editorId, editorToken);
    const joined = (await joinedPromise) as SiteJoinedMessage;

    expect(joined.kind).toBe("site_joined");
    expect(joined.siteId).toBe(editorId);
    expect(joined.role).toBe(Role.Editor);

    ownerWs.close();
    editorWs.close();
  });

  test("relay broadcasts SiteLeft when client disconnects", async () => {
    const ownerId = "site-owner";
    const editorId = "site-editor";
    const ownerToken = sm.mintToken(ownerId, Role.Owner);
    const editorToken = sm.mintToken(editorId, Role.Editor);

    const { ws: ownerWs } = await connectClient(ownerId, ownerToken);
    const joinPromise = waitForMessage(ownerWs, "site_joined");
    const { ws: editorWs } = await connectClient(editorId, editorToken);
    await joinPromise;

    // Listen for site_left, then close the editor
    const leftPromise = waitForMessage(ownerWs, "site_left");
    editorWs.close();
    const left = (await leftPromise) as SiteLeftMessage;

    expect(left.kind).toBe("site_left");
    expect(left.siteId).toBe(editorId);

    ownerWs.close();
  });

  // ── Malformed messages ───────────────────────────────────────────────────

  test("relay handles malformed message without crashing", async () => {
    const siteId = "site-owner";
    const token = sm.mintToken(siteId, Role.Owner);
    const { ws } = await connectClient(siteId, token);

    // Send garbage
    const errorPromise = waitForMessage(ws, "error");
    ws.send("this is not valid JSON {{{");
    const err = (await errorPromise) as ErrorMessage;

    expect(err.code).toBe("malformed_message");

    // Relay should still be functional after the bad message
    expect(relay.getConnectedSites()).toContain(siteId);

    ws.close();
  });

  // ── Edge cases ───────────────────────────────────────────────────────────

  test("relay drops message from unjoined socket (no session)", async () => {
    // Connect but never send a JoinMessage, then try to send an op
    const ws = new WebSocket(`ws://localhost:${TEST_PORT}`);

    await new Promise<void>((resolve) => ws.on("open", resolve));

    // Send a non-join message before joining
    const errorPromise = new Promise<ErrorMessage>((resolve, reject) => {
      ws.on("message", (data) => {
        const msg = parseWireMessage(data.toString());
        if (msg && msg.kind === "error") resolve(msg as ErrorMessage);
      });
      setTimeout(() => reject(new Error("Timeout")), 3000);
    });

    ws.send(
      serializeWireMessage({
        kind: "op",
        siteId: "nobody",
        op: makeInsertOp("nobody", 1, "X"),
      })
    );

    const err = await errorPromise;
    expect(err.code).toBe("malformed_message");

    ws.close();
  });

  test("three clients: op sent by one received by the other two", async () => {
    const siteA = "site-a";
    const siteB = "site-b";
    const siteC = "site-c";
    const tokenA = sm.mintToken(siteA, Role.Owner);
    const tokenB = sm.mintToken(siteB, Role.Editor);
    const tokenC = sm.mintToken(siteC, Role.Editor);

    const { ws: wsA } = await connectClient(siteA, tokenA);
    const joinBPromise = waitForMessage(wsA, "site_joined");
    const { ws: wsB } = await connectClient(siteB, tokenB);
    await joinBPromise;

    const joinCPromiseA = waitForMessage(wsA, "site_joined");
    const joinCPromiseB = waitForMessage(wsB, "site_joined");
    const { ws: wsC } = await connectClient(siteC, tokenC);
    await joinCPromiseA;
    await joinCPromiseB;

    // Site A sends an op
    const insertOp = makeInsertOp(siteA, 1, "H");
    const opMsg: OpMessage = { kind: "op", siteId: siteA, op: insertOp };

    const opPromiseB = waitForMessage(wsB, "op");
    const opPromiseC = waitForMessage(wsC, "op");
    wsA.send(serializeWireMessage(opMsg));

    const receivedB = (await opPromiseB) as OpMessage;
    const receivedC = (await opPromiseC) as OpMessage;

    expect(receivedB.siteId).toBe(siteA);
    expect(receivedC.siteId).toBe(siteA);
    expect(receivedB.op.type).toBe("insert");
    expect(receivedC.op.type).toBe("insert");

    wsA.close();
    wsB.close();
    wsC.close();
  });

  test("getConnectedSites reflects current connections", async () => {
    expect(relay.getConnectedSites().length).toBe(0);

    const siteA = "site-a";
    const tokenA = sm.mintToken(siteA, Role.Owner);
    const { ws: wsA } = await connectClient(siteA, tokenA);

    expect(relay.getConnectedSites()).toContain(siteA);
    expect(relay.getConnectedSites().length).toBe(1);

    wsA.close();
    await delay(200);

    expect(relay.getConnectedSites().length).toBe(0);
  });

  // ── Op log and replay ────────────────────────────────────────────────────

  test("op log grows when ops are forwarded", async () => {
    const siteA = "site-a";
    const siteB = "site-b";
    const tokenA = sm.mintToken(siteA, Role.Owner);
    const tokenB = sm.mintToken(siteB, Role.Editor);

    const { ws: wsA } = await connectClient(siteA, tokenA);
    const joinPromise = waitForMessage(wsA, "site_joined");
    const { ws: wsB } = await connectClient(siteB, tokenB);
    await joinPromise;

    expect(relay.getLogSize()).toBe(0);

    const opMsg: OpMessage = { kind: "op", siteId: siteA, op: makeInsertOp(siteA, 1, "X") };
    const opReceivedPromise = waitForMessage(wsB, "op");
    wsA.send(serializeWireMessage(opMsg));
    await opReceivedPromise;

    expect(relay.getLogSize()).toBe(1);

    wsA.close();
    wsB.close();
  });

  test("late joiner receives missed ops from the log", async () => {
    const siteA = "site-a";
    const siteB = "site-b";
    const tokenA = sm.mintToken(siteA, Role.Owner);
    const tokenB = sm.mintToken(siteB, Role.Editor);

    // A connects and sends two ops before B joins
    const { ws: wsA } = await connectClient(siteA, tokenA);

    const op1: OpMessage = { kind: "op", siteId: siteA, op: makeInsertOp(siteA, 1, "h") };
    const op2: OpMessage = { kind: "op", siteId: siteA, op: makeInsertOp(siteA, 2, "i") };
    wsA.send(serializeWireMessage(op1));
    wsA.send(serializeWireMessage(op2));

    await delay(100);
    expect(relay.getLogSize()).toBe(2);

    // B joins with an empty clock — collector registered before join to avoid
    // the race where replay ops arrive in the same TCP burst as WelcomeMessage
    const { ws: wsB, ops } = await connectAndCollect(siteB, tokenB, {});

    expect(ops.length).toBe(2);
    expect(ops[0]!.siteId).toBe(siteA);
    expect(ops[1]!.siteId).toBe(siteA);

    wsA.close();
    wsB.close();
  }, 8000);

  test("rejoining client with up-to-date clock receives no replay", async () => {
    const siteA = "site-a";
    const siteB = "site-b";
    const tokenA = sm.mintToken(siteA, Role.Owner);
    const tokenB = sm.mintToken(siteB, Role.Editor);

    const { ws: wsA } = await connectClient(siteA, tokenA);
    const joinPromise = waitForMessage(wsA, "site_joined");
    const { ws: wsB } = await connectClient(siteB, tokenB);
    await joinPromise;

    // A sends an op; B receives it (clock now {siteA: 1})
    const opMsg: OpMessage = { kind: "op", siteId: siteA, op: makeInsertOp(siteA, 1, "X") };
    const opReceivedPromise = waitForMessage(wsB, "op");
    wsA.send(serializeWireMessage(opMsg));
    await opReceivedPromise;

    // B disconnects and rejoins with clock {siteA: 1} (already seen the op)
    wsB.close();
    await delay(200);

    const { ws: wsBNew } = await connectClient(siteB, tokenB, { [siteA]: 1 });
    const messagesAfterRejoin = await collectMessages(wsBNew, 300);
    const replayedOps = messagesAfterRejoin.filter((m) => m.kind === "op");

    expect(replayedOps.length).toBe(0);

    wsA.close();
    wsBNew.close();
  });

  test("rejoining client with partial clock receives only unseen ops", async () => {
    const siteA = "site-a";
    const siteB = "site-b";
    const tokenA = sm.mintToken(siteA, Role.Owner);
    const tokenB = sm.mintToken(siteB, Role.Editor);

    const { ws: wsA } = await connectClient(siteA, tokenA);
    const joinPromise = waitForMessage(wsA, "site_joined");
    const { ws: wsB } = await connectClient(siteB, tokenB);
    await joinPromise;

    // A sends 3 ops: clocks {siteA:0}, {siteA:1}, {siteA:2}
    for (let i = 1; i <= 3; i++) {
      wsA.send(serializeWireMessage({
        kind: "op", siteId: siteA, op: makeInsertOp(siteA, i, String(i)),
      }));
    }
    await delay(200);
    expect(relay.getLogSize()).toBe(3);

    wsB.close();
    await delay(200);

    // Rejoin with clock {siteA: 1}: B has seen op1 (clock={siteA:0} → counter 1)
    // Relay skips op1 (clientClock[siteA]=1 > op1.clock[siteA]=0), replays op2+op3
    const { ws: wsBNew, ops } = await connectAndCollect(siteB, tokenB, { [siteA]: 1 });

    expect(ops.length).toBe(2);

    wsA.close();
    wsBNew.close();
  }, 8000);

  test("client does not receive replay of its own ops", async () => {
    const siteA = "site-a";
    const siteB = "site-b";
    const tokenA = sm.mintToken(siteA, Role.Owner);
    const tokenB = sm.mintToken(siteB, Role.Editor);

    const { ws: wsA } = await connectClient(siteA, tokenA);
    const joinPromise = waitForMessage(wsA, "site_joined");
    const { ws: wsB } = await connectClient(siteB, tokenB);
    await joinPromise;

    // B sends an op (goes into log)
    wsB.send(serializeWireMessage({
      kind: "op", siteId: siteB, op: makeInsertOp(siteB, 1, "Z"),
    }));
    await delay(100);

    // A disconnects and rejoins with empty clock
    wsA.close();
    await delay(200);

    const { ws: wsANew, ops } = await connectAndCollect(siteA, tokenA, {});

    const fromB = ops.filter((m) => m.siteId === siteB);
    const fromA = ops.filter((m) => m.siteId === siteA);

    expect(fromB.length).toBe(1);  // B's op replayed to A
    expect(fromA.length).toBe(0);  // A's own ops not echoed back

    wsB.close();
    wsANew.close();
  }, 8000);

  test("fresh-restart client (empty clock) receives its own previous ops via replay", async () => {
    const siteA = "site-a";
    const siteB = "site-b";
    const tokenA = sm.mintToken(siteA, Role.Owner);
    const tokenB = sm.mintToken(siteB, Role.Editor);

    const { ws: wsA } = await connectClient(siteA, tokenA);
    const joinPromise = waitForMessage(wsA, "site_joined");
    const { ws: wsB } = await connectClient(siteB, tokenB);
    await joinPromise;

    // A sends 2 ops (they go into the relay log)
    const op1: OpMessage = { kind: "op", siteId: siteA, op: makeInsertOp(siteA, 1, "x") };
    const op2: OpMessage = { kind: "op", siteId: siteA, op: makeInsertOp(siteA, 2, "y") };
    const bGotOp1 = waitForMessage(wsB, "op");
    wsA.send(serializeWireMessage(op1));
    wsA.send(serializeWireMessage(op2));
    await bGotOp1;
    await delay(100);

    expect(relay.getLogSize()).toBe(2);

    // A "restarts" — fresh empty clock, as if the process was restarted
    wsA.close();
    await delay(200);

    // A rejoins with an empty clock {} — should receive its own 2 ops for replay
    const { ws: wsANew, ops } = await connectAndCollect(siteA, tokenA, {});

    const fromA = ops.filter((m) => m.siteId === siteA);
    expect(fromA.length).toBe(2);

    wsB.close();
    wsANew.close();
  }, 8000);

  test("relay evicts stale session when same siteId reconnects", async () => {
    const siteA = "site-a";
    const tokenA = sm.mintToken(siteA, Role.Owner);

    const { ws: wsOld } = await connectClient(siteA, tokenA);
    expect(relay.getConnectedSites()).toContain(siteA);

    // Reconnect with same siteId — old socket should be evicted
    const { ws: wsNew } = await connectClient(siteA, tokenA);

    await delay(200);
    // Still exactly one session for this siteId
    expect(relay.getConnectedSites().filter((s) => s === siteA).length).toBe(1);

    wsOld.close();
    wsNew.close();
  });
});
