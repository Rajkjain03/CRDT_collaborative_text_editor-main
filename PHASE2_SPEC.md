# Phase 2 — Networking & Sync Layer

## Days 11–18 | Prototype: `collab-sync`

---

## How Phase 2 builds on Phase 1

Phase 1 proved that the CRDT algorithms are correct in isolation. Every component — `RGADocument`, `CausalBuffer`, `VectorClock`, `TombstoneGC`, `LWWRegister`, `Replica` — was tested against an in-memory network simulator that could inject arbitrary delivery orders, partitions, and concurrent edits.

Phase 2 replaces `NetworkSim`'s in-memory delivery with real WebSocket transport. The CRDT layer is untouched. `Replica` remains the central composition point — Phase 2 wraps it with a `ClientSync` class that wires its outbox to a socket and its `receive()` method to incoming socket messages.

The key insight from Phase 1 that Phase 2 depends on:

- `Replica.insert()` and `Replica.delete()` correctly sequence clock snapshot → generate → increment. Phase 2 calls these methods and broadcasts the returned op. The correctness of the broadcast is guaranteed by the invariant already established.
- `Replica.receive(op)` handles all causal buffering internally. Phase 2 just passes incoming WebSocket messages into this method. No causal logic lives in the transport layer.
- `NetworkSim.partition()` simulated offline state by holding queues. Phase 2 replaces this with a real IndexedDB queue that persists across browser sessions. The flush-on-reconnect logic mirrors `NetworkSim.heal()` exactly.

**What Phase 1 provides that Phase 2 consumes directly:**

| Phase 1 export | Phase 2 consumer |
|---|---|
| `Replica` | `ClientSync` wraps it |
| `Replica.insert()` / `delete()` | Called by editor event handlers (Phase 3) |
| `Replica.receive()` | Called by WebSocket message handler |
| `Replica.drainOutbox()` | Called by WebSocket send loop |
| `Replica.getText()` | Called by editor state sync (Phase 3) |
| `LWWRegister.snapshot()` / `merge()` | Relay broadcasts full LWW state periodically |

**What Phase 2 adds:**

- Real WebSocket connections between browser clients and a Node.js relay
- IndexedDB persistence of the offline op queue (replacing `NetworkSim`'s in-memory hold)
- Session management: site ID generation, token-based role enforcement on the relay
- LAN discovery via manual IP entry (mDNS deferred)

---

## Package structure

```
collab-sync/
├── server/
│   ├── RelayServer.ts          WebSocket relay — forward ops, enforce roles
│   ├── SessionManager.ts       Site ID registry, token mint/validate
│   └── server.ts               Entry point: starts relay on configured port
├── client/
│   ├── ClientSync.ts           Wraps Replica: connects socket, wires send/receive
│   ├── OfflineQueue.ts         IndexedDB-backed op queue for offline editing
│   └── ConnectionManager.ts   Reconnect loop, backoff, online/offline detection
├── shared/
│   ├── protocol.ts             Wire message types (serialisation contract)
│   └── roles.ts                Role enum and permission checks
└── tests/
    ├── relay.test.ts
    ├── causalDelivery.test.ts
    ├── replica.integration.test.ts
    ├── offlineQueue.test.ts
    └── reconnect.test.ts
```

---

## Shared types — `shared/protocol.ts`

All wire messages are typed here. Both server and client import from this file; nothing else defines message shapes.

```typescript
type SiteId = string;  // re-exported from crdt-engine types

// ── Op messages (client → relay → all other clients) ─────────────────────────

type OpMessage = {
  kind: "op";
  siteId: SiteId;
  op: RGAOperation;        // RGAInsert | RGADelete from crdt-engine
};

// ── LWW state broadcast (relay → all clients, periodic) ──────────────────────

type MetaMessage = {
  kind: "meta";
  state: LWWState<unknown>;
  fromSiteId: SiteId;
};

// ── Session handshake (client → relay on connect) ─────────────────────────────

type JoinMessage = {
  kind: "join";
  siteId: SiteId;
  token: string;
  clientClock: VectorClockSnapshot;
};

// ── Session acknowledgement (relay → client after join) ───────────────────────

type WelcomeMessage = {
  kind: "welcome";
  assignedSiteId: SiteId;
  role: Role;
  activeSites: SiteId[];
};

// ── Presence / site events (relay → all clients) ──────────────────────────────

type SiteJoinedMessage = { kind: "site_joined"; siteId: SiteId; role: Role; };
type SiteLeftMessage   = { kind: "site_left";   siteId: SiteId; };

// ── Error (relay → client) ───────────────────────────────────────────────────

type ErrorMessage = {
  kind: "error";
  code: "invalid_token" | "unknown_site" | "permission_denied" | "malformed_message";
  message: string;
};

type WireMessage =
  | OpMessage | MetaMessage | JoinMessage
  | WelcomeMessage | SiteJoinedMessage | SiteLeftMessage | ErrorMessage;
```

**Consumed by:** `RelayServer`, `ClientSync`, `SessionManager`.

---

## Shared types — `shared/roles.ts`

```typescript
enum Role { Owner = "owner", Editor = "editor", Viewer = "viewer" }

function canInsert(role: Role): boolean;
function canDelete(role: Role): boolean;
function canChangeRoles(role: Role): boolean;

// Token format: base64(JSON({ siteId, role, sessionId, expiresAt }))
// Signed with a session secret held only by the relay.
function mintToken(siteId: SiteId, role: Role, sessionSecret: string): string;
function validateToken(token: string, sessionSecret: string): { siteId: SiteId; role: Role } | null;
```

**Consumed by:** `RelayServer` (enforcement), `SessionManager` (mint), `ClientSync` (role display).

---

## Server — `server/RelayServer.ts`

The relay is a dumb forwarder. It receives a `WireMessage` from one client and sends it to all other connected clients. It contains no CRDT logic.

```typescript
class RelayServer {
  private wss: WebSocketServer;
  private sessions: Map<SiteId, ConnectedSession>;
  private sessionManager: SessionManager;

  constructor(port: number, sessionManager: SessionManager);
  start(): void;
  stop(): void;

  private onConnection(ws: WebSocket): void;
  private onMessage(ws: WebSocket, raw: string): void;
  private handleOp(session: ConnectedSession, msg: OpMessage): void;
  private handleMeta(session: ConnectedSession, msg: MetaMessage): void;
  private onDisconnect(session: ConnectedSession): void;
  private broadcast(msg: WireMessage, exclude: SiteId): void;
  getConnectedSites(): SiteId[];
}

type ConnectedSession = {
  siteId: SiteId;
  role: Role;
  ws: WebSocket;
  connectedAt: number;
};
```

**Inputs:** raw WebSocket messages from clients.

**Outputs:** forwarded `WireMessage`s to all other connected clients; `WelcomeMessage` to joining client; `SiteJoined`/`SiteLeft` events to all clients.

**Does NOT:** apply ops, buffer ops, maintain document state, reorder messages.

---

## Server — `server/SessionManager.ts`

Manages site identity and token lifecycle.

```typescript
class SessionManager {
  private sessionSecret: string;
  private knownSites: Map<SiteId, Role>;

  constructor();
  initSession(): { ownerToken: string; sessionSecret: string };
  mintToken(siteId: SiteId, role: Role): string;
  validateToken(token: string): { siteId: SiteId; role: Role } | null;
  registerSite(siteId: SiteId, role: Role): void;
  deregisterSite(siteId: SiteId): void;
  getRole(siteId: SiteId): Role | undefined;
  getActiveSites(): SiteId[];
}
```

**Inputs:** `JoinMessage` tokens from `RelayServer.onConnection`.

**Outputs:** validated `{ siteId, role }` pairs back to `RelayServer`; minted tokens for the owner to share out-of-band.

---

## Client — `client/ClientSync.ts`

Wraps `Replica` from Phase 1, connects to the relay, and wires the outbox and receive loop together.

```typescript
class ClientSync {
  readonly replica: Replica;
  private socket: WebSocket | null;
  private connectionManager: ConnectionManager;
  private offlineQueue: OfflineQueue;
  private role: Role | null;

  // Phase 3 editor subscribes to these
  onOpsApplied: ((ops: RGAOperation[]) => void) | null;
  onMetaChanged: ((changed: LWWUpdate<unknown>[]) => void) | null;
  onSiteJoined: ((siteId: SiteId, role: Role) => void) | null;
  onSiteLeft: ((siteId: SiteId) => void) | null;
  onConnectionChange: ((state: "connecting" | "online" | "offline") => void) | null;

  constructor(siteId: SiteId, serverUrl: string, token: string);

  connect(): Promise<void>;
  disconnect(): void;

  // Called by Phase 3 editor
  insert(offset: number, value: string): RGAInsert;
  delete(offset: number): RGADelete | null;
  setMeta(field: string, value: unknown): void;

  private onSocketOpen(): void;
  private onSocketMessage(raw: string): void;
  private handleOpMessage(msg: OpMessage): void;
  private handleMetaMessage(msg: MetaMessage): void;
  private sendLoop(): void;
  private onOffline(): void;
  private onOnline(): void;
}
```

**Inputs from Phase 1:** `Replica` imported directly from `crdt-engine`.

**Outputs to Phase 3:** `onOpsApplied` fires with newly applied ops after each receive — Phase 3's CM6 bridge subscribes to this to update the editor view.

---

## Client — `client/OfflineQueue.ts`

Persists locally-generated ops to IndexedDB so they survive browser refresh during a disconnect.

```typescript
class OfflineQueue {
  private dbName: string;
  private storeName = "offline_ops";

  constructor(siteId: SiteId);
  open(): Promise<void>;
  enqueue(op: RGAOperation): Promise<void>;
  getAll(): Promise<RGAOperation[]>;
  clearUpTo(seqNo: number): Promise<void>;
  clear(): Promise<void>;
  size(): Promise<number>;
}
```

Ops are enqueued in the order `Replica` generates them, which is already causal order. No reordering needed on flush.

**Inputs:** `RGAOperation` from `ClientSync.sendLoop()`.

**Outputs:** ordered `RGAOperation[]` to `ClientSync.onOnline()` for flush.

---

## Client — `client/ConnectionManager.ts`

Manages WebSocket lifecycle: connect, reconnect backoff, online/offline detection.

```typescript
type ConnectionState = "disconnected" | "connecting" | "connected" | "reconnecting";

class ConnectionManager {
  private url: string;
  private socket: WebSocket | null;
  private state: ConnectionState;
  private backoffMs: number;    // 500ms start, doubles, caps at 30s

  onOpen: (() => void) | null;
  onMessage: ((raw: string) => void) | null;
  onClose: (() => void) | null;

  constructor(url: string);
  connect(): void;
  send(msg: WireMessage): boolean;  // returns false if not connected
  disconnect(): void;
  getState(): ConnectionState;

  private onSocketClose(): void;
  private scheduleReconnect(): void;
}
```

**Inputs:** relay URL.

**Outputs:** `onOpen`/`onMessage`/`onClose` callbacks to `ClientSync`.

---

## Work distribution — Phase 2

Phase 2 splits into three parallel streams that are independent from Days 11–16, converging on Days 17–18 for the `collab-sync` prototype demo.

### Stream A — Relay server (Days 11–18)

Owns everything in `server/`. No dependency on Phase 1 beyond the `WireMessage` types in `shared/protocol.ts`. Can begin Day 11 immediately after protocol types are agreed.

**Days 11–13:** `shared/protocol.ts` wire types and `shared/roles.ts` permission checks. `SessionManager` — token mint, validate, site registry. Unit tests for token roundtrip and permission logic.

**Days 14–16:** `RelayServer` — WebSocket server, join handshake, op broadcast with role check, meta broadcast, disconnect cleanup. Integration test: two mock clients connect, one sends an op, verify the other receives it and the sender does not.

**Days 17–18:** Full session test — owner joins, mints editor token, editor joins, viewer joins, editor sends insert, viewer send rejected, relay forwards correctly. Wire with Stream B's `ClientSync` for the two-client demo.

---

### Stream B — Client sync layer (Days 11–18)

Owns `client/ClientSync.ts` and `client/ConnectionManager.ts`. Core task: wire Phase 1's `Replica` to a real socket without changing `Replica`.

**Days 11–12:** `ConnectionManager` — WebSocket lifecycle, exponential backoff. Unit tests for state machine transitions.

**Days 13–15:** `ClientSync` — connect/disconnect, `onSocketMessage` routing, `handleOpMessage` calling `replica.receive()` and firing `onOpsApplied`, `sendLoop` draining outbox and sending `OpMessage`s. Integration test: two `ClientSync` instances connected to Stream A's relay, one inserts, verify the other's `onOpsApplied` fires correctly.

**Days 16–18:** `JoinMessage` handshake with clock snapshot on reconnect. Register returned `activeSites` in `Replica.gc`. Wire `SiteJoined`/`SiteLeft` to GC registration. Test: client disconnects and reconnects with stale clock, relay sends missed ops, client converges.

---

### Stream C — Offline queue and persistence (Days 11–18)

Owns `client/OfflineQueue.ts` and the reconnect flush logic inside `ClientSync`.

**Days 11–13:** `OfflineQueue` — IndexedDB open, enqueue, getAll, clearUpTo, clear, size. Unit tests using `fake-indexeddb`. Verify ordering preserved across enqueue/getAll.

**Days 14–16:** Wire `OfflineQueue` into `ClientSync.sendLoop` and `onOnline` flush. Test: `ClientSync` goes offline, generates 5 ops, comes back online, verifies all 5 delivered in correct order, `OfflineQueue.size()` returns 0 after flush.

**Days 17–18:** Partial flush resilience — if socket closes mid-flush, remaining ops must still be in queue on next reconnect. Test: flush 10 ops, close socket after 3 sent, reconnect, verify remaining 7 delivered. Coordinate with Stream B to integrate flush into `ClientSync.onSocketOpen`.

---

## Coordination checkpoints

| Day | Sync point |
|---|---|
| 11 | `shared/protocol.ts` wire types agreed — all three streams unblock |
| 13 | A: `SessionManager` tested. B: `ConnectionManager` tested. C: `OfflineQueue` tested. No cross-stream dependencies yet. |
| 15 | B: basic `ClientSync` send/receive working against A's relay. First two-client message exchange. |
| 16 | C wires `OfflineQueue` into `ClientSync`. A adds role rejection tests. |
| 17 | Full integration: two clients, one disconnects, edits offline, reconnects, converges. |
| 18 | Demo: two-client LAN session with partition/rejoin. Hand off `ClientSync` API to Phase 3. |

---

## Test inventory — Phase 2

### `tests/relay.test.ts`
- relay forwards op to all clients except sender
- relay forwards delete op to all clients except sender
- relay rejects join with invalid token
- relay rejects insert from viewer role
- relay rejects delete from viewer role
- relay allows insert from editor role
- relay allows insert from owner role
- relay broadcasts SiteJoined when client connects
- relay broadcasts SiteLeft when client disconnects
- relay handles malformed message without crashing
- relay drops message from unknown siteId

### `tests/causalDelivery.test.ts`
- op with satisfied dependencies applied immediately
- op with missing dependency buffered, released after dependency arrives
- two chained ops delivered out of order, both applied after dependency arrives
- vector clock advances by one after each delivered op
- receiveBatch releases mutually dependent ops in one pass

### `tests/replica.integration.test.ts`
- two ClientSync instances exchange single op and converge
- three ClientSync instances all converge after concurrent edits
- ClientSync fires onOpsApplied with correct ops after receive
- ClientSync fires onMetaChanged after meta broadcast
- ClientSync fires onSiteJoined when new client connects
- ClientSync fires onSiteLeft when client disconnects

### `tests/offlineQueue.test.ts`
- enqueue persists op to IndexedDB
- getAll returns ops in insertion order
- queue size increments on enqueue
- clear empties the queue
- clearUpTo removes ops up to sequence number
- queue survives simulated page reload (re-open same DB)
- ops enqueued offline returned in causal order on getAll

### `tests/reconnect.test.ts`
- ops queued offline delivered to relay on reconnect
- offline queue empty after successful flush
- partial flush: remaining ops still present after mid-flush disconnect
- two clients both offline, both reconnect, all ops converge
- client reconnects with stale clock, receives missed ops, converges
- exponential backoff: reconnect intervals double up to cap
