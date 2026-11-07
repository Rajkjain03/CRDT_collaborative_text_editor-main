# Real-Time Collaborative Text Editor using CRDT

A fully-distributed, real-time collaborative text editor built on two complementary CRDT approaches — an operation-based **Replicated Growable Array (RGA)** for document text and a state-based **Last-Write-Wins (LWW) Register** for metadata. Multiple users can concurrently edit the same document over a WebSocket relay. The document converges to the same state on every client — even after network partitions, reordered message delivery, and reconnects — with no central coordinator needed for conflict resolution.

---

## Table of Contents

1. [CRDT Approaches](#crdt-approaches)
2. [System Design](#system-design)
3. [Project File Structure](#project-file-structure)
4. [Implementation Details](#implementation-details)
5. [Requirement Verification (Demo Steps)](#requirement-verification-demo-steps)
6. [Quick Start](#quick-start)
7. [Wire Protocol](#wire-protocol)
8. [CLI REPL Commands](#cli-repl-commands)
9. [Testing](#testing)

---

## CRDT Approaches

The system uses **two different CRDT families** for two different concerns, demonstrating the trade-offs between operation-based and state-based designs.

### 1. Operation-Based CRDT — Replicated Growable Array (RGA)

Used for: **document body text**

RGA represents the document as an ordered linked list of nodes. Every character insertion or deletion becomes a small, immutable operation object broadcast to all peers.

**Conflict resolution rule:** When two concurrent inserts target the same predecessor node they are ordered by descending `siteId` (lexicographic), with Lamport counter as tie-breaker. This gives a total, deterministic order over all possible `NodeId` pairs so every replica independently arrives at the same linked list regardless of op delivery order.

```
Insert at position P with afterId = X:
  1. Locate node X in the list.
  2. Scan right past any node whose (siteId, counter) has higher priority than
     the incoming node — these are concurrent inserts that must appear to its left.
  3. Splice the new node in at the current position.

Delete node with key K:
  Mark node K as a tombstone (isDeleted = true). The node stays in the list so
  that future inserts using K as a predecessor resolve correctly. Physical removal
  is deferred to TombstoneGC after every site has acknowledged the deletion.
```

**Scalability characteristics:** Only the delta (the single op) is sent per keystroke — not the full document state. Ops are small, fixed-size JSON objects regardless of document length.

**Causal delivery:** Vector clocks + CausalBuffer ensure an op is applied only after all ops it causally depends on have already been applied. Out-of-order ops are held in the buffer until their dependencies arrive.

**Key source files:**
- `crdt-engine/src/rga/RGADocument.ts` — linked-list RGA, insert/delete, conflict resolution
- `crdt-engine/src/rga/RGANode.ts` — immutable node with tombstone flag
- `crdt-engine/src/clocks/VectorClock.ts` — causal dependency tracking
- `crdt-engine/src/clocks/CausalBuffer.ts` — holds ops until dependencies satisfied
- `crdt-engine/src/gc/TombstoneGC.ts` — deferred physical deletion

---

### 2. State-Based CRDT — Last-Write-Wins (LWW) Register

Used for: **document title, remote cursor positions, peer heartbeats, role assignments**

LWW is a state-based CRDT where each field stores `(value, timestamp, siteId)`. Merging two states is trivial: for each field, keep the entry with the higher timestamp. On timestamp ties the lexicographically greater `siteId` wins — making the merge function commutative, associative, and idempotent (the three laws required for a state-based CRDT).

```
Merge rule for a single field:
  remote.timestamp > local.timestamp  →  take remote value
  remote.timestamp < local.timestamp  →  keep local value
  remote.timestamp == local.timestamp →  take value from larger siteId
```

**Consistency characteristics:** Each `meta` message carries the full LWW snapshot. Any peer that receives a snapshot can merge it and arrive at the same result — even if messages arrive out of order or are duplicated. No vector clock is needed; wall-clock timestamps plus `siteId` provide a total order per field.

**Key source files:**
- `crdt-engine/src/lww/LWWRegister.ts` — per-field LWW map with merge semantics
- `collab-sync/src/client/ClientSync.ts` — `setMeta()` / `mergeMeta()` wiring
- `collab-editor/src/ui/DocumentTitle.tsx` — title field read/write
- `collab-editor/src/bridge/presence.ts` — cursor field encoding/decoding

---

### Comparison

| Property | RGA (operation-based) | LWW Register (state-based) |
|---|---|---|
| What is sent | Single op per change | Full state snapshot |
| Message size | O(1) per keystroke | O(fields) per meta change |
| Ordering requirement | Causal delivery via vector clocks | None — timestamps + siteId suffice |
| Conflict resolution | Priority rule on NodeId | Timestamp + siteId total order |
| Tombstones / GC | Required (soft-delete → pruneNode) | Not needed |
| Suitable for | Ordered sequences (text) | Scalar / map values (metadata) |
| Convergence guarantee | Yes — same ops in any order → same list | Yes — idempotent merge |

---

## System Design

```
┌─────────────────────────────────────────────────────────────────┐
│                        Browser Client A                          │
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────────────┐│
│  │  React UI    │◄──│ CollabBridge │◄──│  Replica (CRDT)      ││
│  │  (CM6 editor)│   │  CM6 ↔ CRDT  │   │  RGA + LWW + Clocks  ││
│  └──────────────┘   └──────┬───────┘   └────────────────────── ││
│                             │ ClientSync                         │
└─────────────────────────────┼───────────────────────────────────┘
                              │ WebSocket
                    ┌─────────▼──────────┐
                    │    RelayServer     │
                    │  ┌──────────────┐  │
                    │  │   Op Log     │  │  ← append-only, bounded at 10 000 ops
                    │  └──────────────┘  │
                    │  SessionManager    │  ← HMAC token auth, role enforcement
                    └─────────┬──────────┘
                              │ WebSocket
┌─────────────────────────────┼───────────────────────────────────┐
│                        Browser Client B                          │
│  (identical structure — each client holds its own Replica)      │
└─────────────────────────────────────────────────────────────────┘
```

**Design principles:**

- The relay is a **dumb forwarder** — it stores the op log for replay but never interprets or merges CRDT state. All convergence logic lives in the client-side `Replica`.
- Each client holds an **independent, complete** `Replica`. There is no master copy.
- `onOpsApplied` is the single callback from `ClientSync` to the editor. It fires after each batch of remote ops has been applied to the local `Replica`, triggering a minimal CM6 view update.
- `LWW` (meta) messages are **not** stored in the relay op log — they are ephemeral state snapshots. A reconnecting client re-receives current LWW state via the `meta` broadcast triggered when any peer joins.

---

## Project File Structure

```
CRDT_collaborative_text_editor/
│
├── crdt-engine/                    Phase 1 — Pure CRDT library (no I/O, no networking)
│   ├── index.ts                    Public API re-exports
│   └── src/
│       ├── types.ts                NodeId, RGAInsert, RGADelete, VectorClockSnapshot, nodeKey()
│       ├── rga/
│       │   ├── RGADocument.ts      Linked-list RGA: applyInsert, applyDelete, toOffsetIndex()
│       │   ├── RGANode.ts          Immutable node (id, value, afterId, isDeleted, next)
│       │   └── TombstoneGC.ts      Two-phase deletion: soft tombstone → pruneNode after all-ack
│       ├── clocks/
│       │   ├── VectorClock.ts      Per-site counters, happensBefore(), hasDelivered()
│       │   └── CausalBuffer.ts     Holds ops until vector clock dependencies satisfied
│       ├── lww/
│       │   └── LWWRegister.ts      State-based CRDT: set(), merge(), snapshot()
│       └── simulator/
│           ├── Replica.ts          Composes RGA + VectorClock + CausalBuffer + GC + LWW
│           └── NetworkSim.ts       In-process multi-replica simulator (used by unit tests)
│
├── collab-sync/                    Phase 2 — Relay server + client sync layer
│   ├── index.ts                    Re-exports ClientSync and types for collab-editor
│   ├── shared/
│   │   ├── protocol.ts             Wire message types + encode/parse/validate helpers
│   │   └── roles.ts                Role enum, canInsert/canDelete, HMAC token mint/validate
│   └── src/
│       ├── server/
│       │   ├── RelayServer.ts      WebSocket relay: auth, broadcast, op log, replay, reset
│       │   └── SessionManager.ts   Session secret, site→role map, token validation
│       └── client/
│           ├── ClientSync.ts       Editor-facing API: insert/delete/setMeta/mintToken/reset
│           ├── ConnectionManager.ts WebSocket with exponential-backoff reconnect
│           ├── OfflineQueue.ts     IndexedDB-backed op queue for offline editing
│           └── cli.ts              Interactive REPL for debugging / manual testing
│
├── collab-editor/                  Phase 3 — React browser editor (CodeMirror 6 + Vite)
│   └── src/
│       ├── fileSystem.ts           File System Access API: open/save/IDB handle persistence
│       ├── bridge/
│       │   ├── CollabBridge.ts     CM6 ↔ ClientSync: local edits → ops, remote ops → CM6
│       │   ├── offsetMap.ts        Translates NodeId ↔ visible CM6 offset via toOffsetIndex()
│       │   └── presence.ts         Encodes cursor positions as stable NodeId references
│       ├── editor/
│       │   ├── EditorView.tsx      CM6 view with forwardRef (exposes setContent handle)
│       │   ├── theme.ts            Editor colour theme
│       │   └── extensions/
│       │       ├── remoteCursors.ts  StateField rendering remote cursors as CM6 decorations
│       │       ├── readOnly.ts       Blocks edits for viewer role
│       │       └── undoRedo.ts       Ctrl+Z keymap hooked to CRDT HistoryStack
│       ├── hooks/
│       │   ├── useCollabClient.ts  Central event hub — owns all client.on* callbacks
│       │   ├── usePresence.ts      Reads cursor LWW fields on metaVersion bump
│       │   └── useOfflineQueue.ts  Polls IndexedDB queue size for offline UI indicator
│       ├── undo/
│       │   ├── HistoryStack.ts     Bounded stack of CompensatingOp entries
│       │   └── compensate.ts       Maps RGAOperation → CompensatingOp for undo
│       └── ui/
│           ├── App.tsx             Top-level: login, editor layout, file mgmt, heartbeat
│           ├── ConnectionStatus.tsx  Connection indicator + queued op count
│           ├── DocumentTitle.tsx   LWW-backed editable document title (debounced)
│           ├── PresenceBar.tsx     Coloured avatar dots for connected peers
│           └── RoleManager.tsx     Peer list with heartbeat dots + owner token minting
│
├── crdt-editor-ui/                 Phase 1 visual simulator — standalone browser demo
│   └── src/
│       ├── SimulatorApp.tsx        Side-by-side replica panels showing real-time convergence
│       └── NetworkApp.tsx          Network partition simulator with delay controls
│
├── benchmarks/                     Performance benchmarks (throughput, latency, comparative)
│   └── stress.ts
│
└── README.md                       This file
```

---

## Implementation Details

### CRDT Engine

**RGADocument** maintains a singly-linked list of `RGANode` objects. Each node carries:
- `id: NodeId` — `{ siteId: string, counter: number }` — globally unique, immutable
- `value: string` — the character
- `afterId: NodeId | null` — the predecessor at insertion time
- `isDeleted: boolean` — tombstone flag, mutable
- `next: RGANode | null` — next pointer, mutable

A parallel `nodeMap: Map<string, RGANode>` (keyed by `siteId:counter`) gives O(1) lookup for incoming ops without traversal.

`Replica` sequences operations correctly:
```
Local insert:
  1. snapshot = vectorClock.snapshot()    // capture BEFORE increment
  2. op = rgaDoc.localInsert(afterId, char, snapshot)
  3. vectorClock.increment(siteId)
  4. outbox.push(op)

Remote receive:
  1. causalBuffer.add(op, senderSiteId)   // hold until deps satisfied
  2. ready = causalBuffer.drain()         // fixed-point drain loop
  3. for each readyOp: rgaDoc.apply*(readyOp)
  4. tombstoneGC.acknowledge(nodeId, senderSiteId)
```

**TombstoneGC** tracks a `Map<nodeKey, Set<siteId>>` of delete acknowledgements. A tombstoned node is physically pruned (`pruneNode`) only after every registered site has confirmed the deletion — preventing dangling `afterId` references.

**LWWRegister** stores `Map<field, { value, timestamp, siteId }>`. `merge()` applies the LWW rule field-by-field and returns only the fields that actually changed locally — this delta list is what `onMetaChanged` delivers to the editor layer.

---

### Relay Server

The relay is intentionally stateless with respect to CRDT state. It stores raw ops in an in-memory append-only log (capped at 10 000 entries) and replays on reconnect using vector clock comparison:

```
replayMissedOps(site, clientClock):
  for each entry in opLog:
    if clientClock[entry.siteId] is undefined
    OR clientClock[entry.siteId] <= entry.clock[entry.siteId]:
      send entry.op to site    // client has not seen this op yet
```

Permission enforcement happens at the relay on every incoming `op` message — not just at token issuance — so role changes take effect immediately without reconnection.

**Session reset** (`clear_log`): owner sends → relay clears op log → broadcasts `log_cleared` → each client replaces its `Replica` with a fresh empty instance and clears its IndexedDB offline queue.

---

### Client Sync

`ClientSync` is the single integration point between the CRDT layer and transport. The editor calls only `insert`, `delete`, `setMeta`, `mintToken`, and `reset`.

`drainOutboxAsync()` batches ops via `queueMicrotask` so a paste of 100 characters produces one WebSocket send, not 100.

**OfflineQueue** persists ops to IndexedDB with an auto-incrementing `seqNo` as the key, preserving causal insertion order across browser restarts. `clearUpTo(seqNo)` removes acked ops one by one so a crash mid-flush leaves no duplicates on the next flush attempt.

---

### Browser Editor

**CollabBridge** is the CM6 ↔ ClientSync adapter:

```
onLocalUpdate (CM6 → CRDT):
  iterChanges from highest offset to lowest (reverse order prevents offset drift)
    delete chars from toA-1 down to fromA
    insert new chars from fromA upward

applyRemoteOps (CRDT → CM6):
  change = minimalChange(oldText, newText)   // common prefix+suffix trimmed
  view.dispatch({
    changes: change,
    annotations: [Transaction.addToHistory.of(false)]  // remote ops never enter undo stack
  })
```

`minimalChange` dispatches only the differing middle range between old and new text. CM6 remaps surviving cursor positions through targeted inserts/deletes instead of resetting them on every remote update — this fixes the cursor-jumping bug that occurs with full-document replacements.

**useCollabClient** is the central event hub — it owns all `client.on*` callbacks. No other hook or component touches `client.on*` directly. It returns `{ client, connectionState, peers, metaVersion }`. The `metaVersion` counter bumps on every `onMetaChanged` call; `usePresence` and `DocumentTitle` use `useEffect([client, metaVersion])` to re-read LWW state without their own callbacks, avoiding the single-callback-slot problem.

**Cursor presence** uses stable `NodeId` references rather than integer offsets so a remote insertion before the cursor does not shift it. Anchor and head are encoded as `{ nodeId: predecessorId, offsetWithinNode: 0|1 }`. On render, `offsetMap.getVisibleOffsetForNodeId(nodeId)` resolves the current integer offset via `replica.doc.toOffsetIndex()`.

**File System Access API** (`fileSystem.ts`): `openFilePicker()` returns a `FileSystemFileHandle` stored in a dedicated IndexedDB object store. On the next page load the stored handle is retrieved, `requestPermission` is called (one browser prompt), and the file loads automatically. `writeToHandle()` writes directly to the file via `createWritable()` — no download dialog. Firefox falls back to `<input type="file">` for open and a blob download for save.

---

## Requirement Verification (Demo Steps)

**Setup:** Start the relay (`cd collab-sync && npm run server`), then open the editor (`cd collab-editor && npm run dev`). Open two tabs — connect as **alice** (owner token) in tab 1. Use the **Role Manager** sidebar to mint an **editor** token for **bob**, then paste it in tab 2 and connect.

---

### R1 — Real-Time Collaborative Editing with CRDTs

1. With both tabs connected, type in tab 1.
2. The text appears in tab 2 in real time (within one round-trip).
3. Type in both tabs simultaneously — both users' characters appear in both tabs with no manual resolution required.

---

### R2 — Two CRDT Approaches

The system uses two CRDTs for two different concerns. Both are observable in the UI:

**Operation-based CRDT (RGA) — document body:**
1. In tab 1, place the cursor at the start of the document and type `AAA`.
2. In tab 2, simultaneously place the cursor at the start and type `BBB`.
3. Both tabs converge to the same merged text (e.g. `AAABBB` or `BBBAAA`) — all characters from both users appear, none are lost. This demonstrates RGA: every insert is an independent operation that is merged with concurrent inserts via a deterministic priority rule.

**State-based CRDT (LWW Register) — document title:**
1. In tab 1, click the document title at the top and change it to `Alice's Title`.
2. Immediately in tab 2, change the title to `Bob's Title`.
3. After both updates propagate, **both tabs show the same title** — whichever update had the later timestamp wins. Unlike RGA, both values cannot coexist; the LWW register picks one winner. This demonstrates state-based CRDT: the full title state is exchanged and the last write wins.

**Key contrast:** RGA merges concurrent edits (all characters survive). LWW picks a single winner (only one title survives). Same system, two CRDT strategies for two different data types.

---

### R3 — Conflict Resolution

This demonstrates that concurrent edits made without network contact resolve automatically using the RGA priority rule.

1. In tab 1, click **Go Offline** (header button). The yellow offline banner appears.
2. In tab 2, click **Go Offline**. Both clients are now isolated.
3. In tab 1, type `AAAA` at the beginning of the document.
4. In tab 2, type `BBBB` at the beginning of the document.
5. In tab 1, click **Reconnect**. In tab 2, click **Reconnect**.
6. After both flush, both tabs show the same merged text (e.g. `AAAABBBB` or `BBBBAAAA`). The order is determined by siteId — no prompt, no data loss.

---

### R4 — Consistency Across Multiple Users

1. Mint a **viewer** token for **carol** and open a third tab; connect as carol.
2. Alice and Bob type several lines simultaneously.
3. Once all ops settle, all three tabs display **identical text**.
4. Carol's tab is read-only (typing does nothing) — demonstrating that the viewer role is enforced while still receiving all updates.

---

### R5 — Synchronous (Real-Time) Editing

1. With both tabs connected, type in tab 1.
2. Each character appears in tab 2 before you finish typing the word.
3. The coloured remote cursor caret in tab 2 tracks alice's cursor position in real time as she types.

---

### R6 — Asynchronous (Offline) Editing

1. In tab 1, click **Go Offline**. The yellow banner appears: _"⚠ Working offline — edits are saved locally and will sync automatically on reconnect."_
2. Type several sentences. The banner updates: _"N edits queued"_ — each keystroke is persisted to IndexedDB.
3. Click **Reconnect**. The queued ops flush to the relay and appear in tab 2 within seconds. The banner disappears.
4. To verify persistence across a page reload: while offline, type some text, then **refresh tab 1**. Reconnect — the relay replays all missed remote ops and the local ops re-sync, restoring the full document.

---

### R7 — Seamless Sync-on-Reconnection

1. With both tabs connected and some content in the document, close tab 2 entirely.
2. In tab 1, type several more paragraphs.
3. Reopen the browser, paste bob's token, and connect. The relay compares bob's vector clock against the op log and replays exactly the ops bob missed — no manual action needed. Tab 2 reaches the same state as tab 1 automatically.

---

### R8 — Undo/Redo

CM6 groups continuous typing into a single history transaction. One Ctrl+Z undoes the entire burst typed without pausing — not one character at a time.

1. In tab 1, type a word (e.g. `hello`) without pausing.
2. Press **Ctrl+Z** once — the entire word is removed in one step.
3. To get finer-grained undo, pause briefly between characters while typing; CM6 creates a new history entry on each pause, so each Ctrl+Z undoes a smaller group.
4. Press **Ctrl+Y** (or **Ctrl+Shift+Z**) — the undone text is restored.
5. The undo/redo changes sync to tab 2 as normal CRDT ops.

---

### R9 — Access Control

1. In the **Role Manager** sidebar (right panel), alice types `carol` in the Site ID field, selects **viewer**, and clicks **Create Token**. Copy the token.
2. Open a third tab, paste carol's token, connect as carol. The editor is read-only — typing is blocked.
3. Back in tab 1, mint a new token for `carol` with role **editor** this time. Copy it.
4. In tab 3, use the **Change token** link in the offline banner (or refresh and log in again) with the new editor token. Carol can now edit.

---

### R10 — Local File Open / Save

1. Click **Open ↑** in the header and select a `.txt` file from your machine. Its content loads into the editor and the filename appears below the toolbar.
2. Edit the document. Press **Ctrl+S** (or click **Save**) — on Chrome/Edge the file is written in place with no download dialog. On Firefox, a download is triggered instead.
3. The toolbar shows **Saved ✓** briefly after each successful save.
4. Refresh the page and reconnect. The browser asks once for file permission; after granting it, the file content loads automatically into the editor.

---

## Quick Start

### Prerequisites

- Node.js ≥ 20, npm ≥ 9

> Node.js 20 is required by Vite 8 (browser editor dev server) and vitest 4 (editor test suite). The relay server alone runs on Node.js 18, but Node.js ≥ 20 is recommended for full compatibility.

### 1. Install dependencies

Each package has its own `node_modules`; there is no root workspace, so you must install in each subdirectory you intend to use.

```bash
# Relay server
cd collab-sync && npm install && cd ..

# Browser editor
cd collab-editor && npm install && cd ..
```

If you want to run the CRDT unit tests in `crdt-engine`:

```bash
cd crdt-engine && npm install && cd ..
```

> **No global tool installation required.** `npm install` in each directory installs all necessary TypeScript tooling locally as devDependencies: the TypeScript compiler (`tsc`), `ts-node` (used to run the relay server and CLI without a build step), `ts-jest` (TypeScript transform for Jest), and `vitest` (test runner for the browser editor). Do not run `npm install -g typescript` or similar — the local versions in each `node_modules` are used automatically via `npm run` scripts.

### 2. Start the relay server

```bash
cd collab-sync
npm run server
```

Output:
```
─────────────────────────────────────────
  collab-sync relay  —  port 8787
─────────────────────────────────────────
  Owner Site ID : alice
  Owner Token   : eyJ...
─────────────────────────────────────────
```

The relay reads its port from `collab-sync/.env` (default: `PORT=8787`).

### 3a. Browser editor

```bash
cd collab-editor
npm run dev              # http://localhost:3000

# Expose on LAN for multi-device testing:
npm run dev -- --host    # http://<your-ip>:3000
```

Open the URL in two tabs. Paste the owner token in tab 1. Use the **Role Manager** panel to mint an editor token for tab 2.

### 3b. CLI REPL

```bash
cd collab-sync
npm run client -- --site alice --token <owner-token>
npm run client -- --site bob   --token <editor-token>   # second terminal
```

Type `help` inside the REPL for all commands.

### 4. Visual CRDT simulator (optional)

```bash
cd crdt-editor-ui
npm install
npm run dev    # http://localhost:5174
```

Shows two side-by-side replicas with real-time convergence and a network partition panel.

---

## Wire Protocol

All messages are JSON over WebSocket.

| Direction | Kind | Key payload fields | Purpose |
|---|---|---|---|
| Client → relay | `join` | `siteId, token, clock` | Authenticate; provide vector clock for replay |
| Relay → client | `welcome` | `role, activeSites[]` | Confirm role; list active peers |
| Client → relay → peers | `op` | `siteId, op` | Single RGA insert or delete |
| Client → relay → peers | `meta` | `fromSiteId, state` | Full LWW snapshot (title, cursors, heartbeats) |
| Relay → client | `site_joined` | `siteId, role` | Peer connected |
| Relay → client | `site_left` | `siteId` | Peer disconnected |
| Client → relay | `mint_token` | `siteId, role` | Owner requests join token for new peer |
| Relay → client | `token_minted` | `siteId, token` | Signed token returned to owner |
| Owner → relay → all | `clear_log` / `log_cleared` | — | Session reset |
| Relay → client | `error` | `code, message, fatal` | Auth failure or permission denied |

`op` messages are stored in the relay's bounded log and replayed to reconnecting clients. `meta` messages are not logged — they are ephemeral; a reconnecting client receives current LWW state via the `meta` broadcast any active peer sends on join.

---

## CLI REPL Commands

```
ins <offset> <text>     Insert text at visible character offset
del <offset>            Delete character at visible offset
connect / online        Open WebSocket, join session, flush offline queue
disconnect / offline    Close WebSocket (simulates network drop)
meta <field> <value>    Set a LWW metadata field  (e.g.  meta title MyDoc)
mint <siteId> <role>    Mint a join token  (role: owner | editor | viewer)
state                   Print document text, vector clock, and peer list
queue                   Print offline queue size (pending op count)
peers                   List currently connected peers with their roles
tokens                  List tokens minted this session (owner only)
reset                   Owner: clear relay op log + wipe all client state
help                    Show all commands
quit / exit             Stop the REPL
```

---

## Testing

Each package must be installed before running its tests (`npm install` in that directory). No global test runner installation is needed — Jest and Vitest are local devDependencies.

```bash
# CRDT engine — unit tests (RGA convergence, clock ordering, LWW merge, GC)
# Uses Jest + ts-jest (configured in crdt-engine/jest.config.js)
cd crdt-engine && npm test

# Relay + client — integration tests (offline sync, reconnect, roles, permissions)
# Uses Jest + ts-jest (configured via package.json "jest" field)
cd collab-sync && npm test

# Browser editor — component and bridge tests
# Uses Vitest (requires Node.js ≥ 20)
cd collab-editor && npm test
```

The `collab-sync` suite uses an in-process `RelayServer` over a mock WebSocket transport — no live server needed. Tests cover concurrent insert convergence with reordered delivery, offline queue persistence and flush ordering, reconnect with op-log replay, role enforcement, and HMAC token validation.
