# Phase 1 Prototype Guide

## CRDT Collaborative Text Editor — `crdt-engine`

This document covers how to run the interactive CLI and all tests for the Phase 1 prototype. Phase 1 delivers the `crdt-engine` package: a fully in-memory implementation of the RGA document CRDT, LWW metadata CRDT, vector clocks, causal buffering, tombstone GC, and a network simulator — no sockets, no browser, no UI.

---

## Project structure

```
crdt-engine/
├── src/
│   ├── types.ts                   Shared primitives (NodeId, RGAInsert, RGADelete, etc.)
│   ├── rga/
│   │   ├── RGANode.ts             Single character node in the linked list
│   │   ├── RGADocument.ts         Core RGA linked list (insert, delete, convergence)
│   │   └── TombstoneGC.ts         Garbage collector for soft-deleted nodes
│   ├── clocks/
│   │   ├── VectorClock.ts         Per-replica causal clock
│   │   └── CausalBuffer.ts        Holds out-of-order ops until dependencies arrive
│   ├── lww/
│   │   └── LWWRegister.ts         Last-Write-Wins register for metadata
│   └── simulator/
│       ├── Replica.ts             Composes all components into one node
│       ├── NetworkSim.ts          In-memory network with partition/heal support
│       └── cli.ts                 Interactive REPL
└── tests/
    ├── rga/
    │   ├── RGADocument.test.ts
    │   ├── TombstoneGC.test.ts
    │   └── convergence.test.ts
    ├── clocks/
    │   └── VectorClock.test.ts
    │   └── CausalBuffer.test.ts  (if present)
    ├── lww/
    │   └── LWWRegister.test.ts
    └── simulator/
        ├── Replica.test.ts
        └── NetworkSim.test.ts
```

---

## Setup

```bash
cd crdt-engine
npm install
```

If `ts-node` is missing:

```bash
npm install --save-dev ts-node
```

---

## Running the CLI

```bash
npm run cli                                          # 3 replicas (default)
npm run cli:4                                        # 4 replicas
npx ts-node src/simulator/cli.ts --replicas 5       # any count
```

The REPL starts immediately with all replicas in an empty, converged state and waits at the `crdt>` prompt.

### Reading the state display

Every command prints a live state block before returning to the prompt:

```
────────────────────────────────────────────────────────────
  S1 [online]  buf:0  "hello"  len=5  clock{S1:5}
  S2 [offline] buf:0 queued:7  "hello"  len=5  clock{S1:5}
  S3 [online]  buf:0  "helloworld"  len=10  clock{S1:5 S2:5}

  ✓ online converged (offline sites pending)  |  pending buf total: 0
────────────────────────────────────────────────────────────
```

| Field | Meaning |
|---|---|
| `[online]` / `[offline]` | Whether the site is currently partitioned |
| `buf:N` | Ops sitting in the causal buffer — received but dependencies not yet arrived |
| `queued:N` | Ops held by the simulator due to partition (outgoing + incoming combined) |
| `"..."` | Current visible document text |
| `len=N` | Visible character count (excludes tombstones) |
| `clock{...}` | Vector clock snapshot — how many ops from each site have been delivered |
| `✓ all converged` | Every replica (including offline) has identical text |
| `✓ online converged` | Online replicas match; offline sites are behind |
| `~ pending convergence` | Online replicas have not yet exchanged all ops |

---

## Command reference

### Document editing

#### `ins <site> <offset> <text>`

Insert text at a character offset on the given replica. The text is inserted character by character, each as a separate RGA operation. The ops sit in that replica's outbox until `step` or `sync` is called.

Offset 0 inserts before the first character. Offset equal to the current length appends to the end.

```
crdt> ins S1 0 hello        # inserts "hello" starting at position 0
crdt> ins S1 5 world        # appends "world" after "hello" → "helloworld"
crdt> ins S2 3 XYZ          # inserts "XYZ" at position 3 on S2 (not yet synced)
```

If the site is offline, the insert is applied locally and the ops go into the partition outgoing queue. The message will say `[S1 is offline] inserted "..." locally — not yet visible to others`.

#### `del <site> <offset>`

Soft-delete the character at the given visible offset. The node is tombstoned in the RGA list — it stays in memory to preserve ordering for concurrent inserts, but is excluded from the visible string. The op sits in the outbox until delivered.

```
crdt> del S1 0              # delete first character
crdt> del S2 4              # delete character at index 4 on S2
```

Deleting at an out-of-range offset prints a warning and does nothing.

---

### Network delivery

#### `step [order]`

Collect all outbox ops from every online replica and deliver them to all other online replicas in one round. Ops from or to partitioned replicas are held in the partition queues, not delivered.

`order` controls delivery sequence:

- `causal` (default) — ops delivered in the order they were generated
- `random` — ops shuffled before delivery (deterministic seed per session)
- `reverse` — ops delivered in reverse generation order

```
crdt> step                  # one round, causal order
crdt> step random           # one round, random order
crdt> step reverse          # one round, reverse order
```

A single `step` may not achieve full convergence if ops span multiple rounds (e.g. if S1 generates ops in response to receiving S2's ops). Use `sync` for full convergence.

#### `sync [order]`

Repeatedly calls `step` until no online replica has pending ops or a buffered causal queue. Equivalent to running `step` in a loop until nothing moves.

```
crdt> sync                  # full convergence, causal order
crdt> sync random           # full convergence, random delivery order
crdt> sync reverse          # full convergence, reverse delivery order
```

---

### Partition simulation

#### `partition <site> [site...]`

Fully isolates the named sites. A partitioned site:

- Does **not** send ops to other sites (its outbox ops go to `heldOutgoing`)
- Does **not** receive ops from other sites (incoming ops go to `heldIncoming`)

This models a real network disconnect where the relay cannot reach the client in either direction.

```
crdt> partition S1          # isolate S1
crdt> partition S2 S3       # isolate S2 and S3 simultaneously
```

After partitioning, editing a partitioned site applies changes locally and increments its clock, but no other site sees those changes until `heal`.

#### `heal`

Reconnects all currently partitioned sites and flushes both queues:

1. **Outgoing flush** — each partitioned site's queued ops are delivered to all online sites
2. **Incoming flush** — ops that online sites generated while the partition was active are delivered to the reconnected sites

After `heal`, a `sync` may still be needed if the flushed ops trigger further exchanges (e.g. if a reconnected site generates new ops in response).

```
crdt> heal
```

---

### LWW metadata

#### `meta <site> <field> <value>`

Set a metadata field on a replica using the LWW register. The value is timestamped with the current wall clock time. Fields are independent — setting `title` does not affect `status`.

```
crdt> meta S1 title Chapter One
crdt> meta S2 status draft
crdt> meta S1 author Alice
```

#### `syncmeta`

Simulate the relay broadcasting full LWW state snapshots. Each replica's snapshot is sent to all others and merged. The LWW rule applies: for each field, the entry with the higher timestamp wins. Ties are broken by descending siteId (lexicographic).

```
crdt> syncmeta
```

After `syncmeta`, the output shows every field and each replica's current value for it.

**Important:** because timestamps are wall-clock milliseconds, running `meta S1 title X` then immediately `meta S2 title Y` may give either entry the higher timestamp depending on how fast the commands execute. Run them a moment apart or re-run until you see the expected winner if you are testing the tie-breaking logic. The tie-breaker (siteId) only activates when both commands run within the same millisecond.

---

### View commands

#### `state`

Print the current live state of all replicas without performing any operation.

#### `log`

Print the raw RGA linked list for each replica, showing every node including tombstones. Useful for verifying that deleted characters remain as tombstones until GC, and that the ordering of concurrent inserts is as expected.

```
  S1 RGA dump: [h(✓), e(✓), l(✗), l(✓), o(✓)]
       total nodes (incl. tombstones): 5
```

`(✓)` = visible, `(✗)` = tombstoned. The count includes tombstones — it decreases after GC runs (which happens automatically after each `step`/`sync`/`heal`).

#### `help`

Print the full command reference.

---

### Session

#### `quit` / `exit` / `q`

Stop the REPL.

---

## Annotated walkthroughs

### 1. Basic convergence

```
crdt> ins S1 0 hello
crdt> ins S2 0 world
crdt> state                     # S1="hello", S2="world", S3="" — not yet exchanged
crdt> step                      # one round: all outbox ops delivered
crdt> state                     # all three show "worldhello" — S2>S1 lex priority
```

"world" appears before "hello" because S2 > S1 lexicographically. The RGA priority rule places higher-siteId nodes to the left when concurrent inserts target the same predecessor.

### 2. Concurrent insert tie-breaking

```
crdt> ins S1 0 aaa
crdt> ins S2 0 bbb
crdt> ins S3 0 ccc
crdt> sync random               # random delivery order — still converges
crdt> state                     # all show "cccbbbaaa" — S3>S2>S1
```

Run `sync random` several times on fresh sessions. The result is always `"cccbbbaaa"` because tie-breaking is deterministic on siteId, not delivery order.

### 3. Tombstone and GC

```
crdt> ins S1 0 hello
crdt> sync
crdt> del S1 2                  # delete 'l' at offset 2
crdt> log                       # S1: [h(✓),e(✓),l(✗),l(✓),o(✓)] — tombstone visible
crdt> sync
crdt> log                       # tombstone pruned after GC, total nodes drops to 4
```

The first `log` shows 5 nodes with `l(✗)` on S1 only — S2 and S3 still show 5 visible nodes because the delete op hasn't reached them yet. After `sync`, the delete propagates, all sites ack it, GC runs, and the node is physically removed from all linked lists.

### 4. Two-way partition and heal

```
crdt> ins S1 0 shared
crdt> sync
crdt> partition S1
crdt> ins S1 6 -offline         # S1 offline: queued locally
crdt> ins S2 6 -online          # S2 online: delivered to S3, queued as incoming for S1
crdt> step
crdt> state                     # S1="shared-offline", S2=S3="shared-online", queued:N on S1
crdt> heal                      # flushes both queues
crdt> state                     # all three converge — both edits present
```

After `partition`, S1 neither sends nor receives. `queued:N` on S1 shows the total of both queues combined. After `heal`, convergence happens immediately because both queues flush in one call.

### 5. Causal buffer in action

```
crdt> ins S1 0 a                # op1: clock {S1:0}
crdt> ins S1 1 b                # op2: clock {S1:1} — depends on op1
```

Deliver op2 to S2 before op1 (requires manual `broadcast` or using `NetworkSim` directly in tests — not directly observable in the CLI since `step` always collects both ops together). In tests, this is verified by the `receive buffers op when dependency missing` test case in `Replica.test.ts`.

### 6. LWW metadata

```
crdt> meta S1 title Chapter One
crdt> meta S2 title Draft
crdt> syncmeta                  # "Draft" wins if S2's timestamp is higher
```

To see S1 win:

```
crdt> meta S2 title Draft
crdt> meta S1 title Chapter One    # wait a moment — higher timestamp
crdt> syncmeta                     # "Chapter One" wins
```

---

## Running tests

### All tests

```bash
npm test
```

### By module

```bash
npm run test:rga        # RGA document, tombstone GC, convergence
npm run test:lww        # LWW register
npm run test:sim        # Replica and NetworkSim
```

### Single file

```bash
npx jest tests/rga/RGADocument.test.ts --verbose
npx jest tests/rga/convergence.test.ts --verbose
npx jest tests/simulator/NetworkSim.test.ts --verbose
```

### Watch mode (re-runs on file save)

```bash
npm run test:watch
```

### Coverage report

```bash
npm run test:coverage
```

Opens a coverage summary in the terminal. HTML report is written to `coverage/lcov-report/index.html`.

---

## Test inventory

### `tests/rga/RGADocument.test.ts`

Tests the RGA linked list in complete isolation. No network, no clocks — just insert, delete, and read operations on a single document.

**Basic insert**
- insert at empty doc appends character
- sequential inserts build correct string
- insert in the middle
- insert at head (offset 0)

**Delete / tombstone**
- delete first character
- delete middle character
- delete last character
- delete all characters leaves empty string
- delete is idempotent (double delete same node)
- node count includes tombstones

**applyInsert remote**
- applying same insert twice is idempotent
- throws if predecessor is missing
- throws if delete target is missing

**Concurrent insert conflict resolution**
- all 6 permutations of 3 concurrent head inserts produce same result
- concurrent inserts after same node converge in both delivery orders
- insert after a tombstoned node still positions correctly
- two replicas with same operations in different interleaving order converge

**Offset / NodeId translation**
- getNodeIdAtOffset returns correct ids
- getAfterIdForOffset returns null at offset 0
- getAfterIdForOffset returns last char id at length
- toOffsetIndex maps node keys to correct offsets
- toOffsetIndex excludes tombstones and shifts offsets
- getNodeIdAtOffset is stable after remote inserts

**debugDump**
- shows tombstone markers

**pruneNode (GC prerequisite)**
- pruned tombstone is removed from node count
- pruning a non-deleted node is a no-op
- pruning head node updates head pointer

---

### `tests/rga/TombstoneGC.test.ts`

Tests the garbage collector independently of any network layer.

**Site management**
- registers and tracks known sites
- deregisterSite removes a site

**Acknowledgement**
- ackCount starts at zero
- ackCount increments per site
- duplicate ack from same site does not increment count

**isCollectable**
- not collectable when no sites registered
- not collectable when not all sites have acked
- collectable when all registered sites have acked
- becomes collectable after deregistering missing site

**collect**
- collect returns empty when nothing is collectable
- collect prunes node when all sites have acked
- collect prunes multiple nodes in one pass
- pendingAckCount decreases after collect
- collect with no registered sites returns nothing

**Full integration with RGADocument**
- document remains consistent after GC across two replicas

---

### `tests/rga/convergence.test.ts`

Property-based convergence tests. All tests hold causal order within each site's own chain — only interleaving between sites varies.

**Concurrent insert ordering**
- all 6 permutations of 3 concurrent head inserts produce the same result
- concurrent inserts after same node converge in both delivery orders
- tie-breaking is stable: same site, higher counter wins

**Two replicas**
- ops from two sites converge across all valid interleavings
- concurrent deletes of the same node are idempotent and converge
- insert after a node that is concurrently deleted converges

**Three replicas**
- three replicas exchanging concurrent op sets all converge

**Idempotency**
- applying the same insert twice does not duplicate the character
- applying the same delete twice does not throw or corrupt state

**Commutativity stress**
- 5 sites, 3 ops each, multiple interleavings all converge

---

### `tests/lww/LWWRegister.test.ts`

Tests the LWW register in isolation with injected timestamps for deterministic results.

**set**
- set stores a value and retrieves it
- set returns an LWWUpdate with correct fields
- later timestamp overwrites earlier
- earlier timestamp does not overwrite later
- same timestamp: higher siteId wins
- same timestamp: lower siteId does not overwrite
- multiple fields are independent
- get returns undefined for unset field

**merge**
- merge applies remote field that does not exist locally
- merge takes remote value when remote timestamp is higher
- merge keeps local value when local timestamp is higher
- merge tie: remote siteId higher → remote wins
- merge tie: remote siteId lower → local wins
- merge returns only changed fields
- merge is idempotent — applying same snapshot twice is no-op

**Convergence**
- two registers merging each other converge to same state
- three-way merge converges regardless of merge order

**Snapshot and fields**
- snapshot returns copy of all entries
- fields() returns all tracked field names
- constructor with initial state pre-populates register

---

### `tests/simulator/Replica.test.ts`

Tests the composed `Replica` class which encapsulates the correct clock sequencing.

**Local insert**
- insert at empty doc appends character
- sequential inserts build correct string
- insert places op in outbox
- drainOutbox clears outbox
- clock snapshot attached to op is taken BEFORE increment
- clock increments once per local op

**Local delete**
- delete removes character
- delete returns null for out-of-range offset
- delete places op in outbox
- delete increments clock

**Receive**
- receive applies a causally ready insert
- receive buffers op when dependency missing
- receive returns list of actually applied ops
- receiveBatch delivers ops that unblock each other

**Two-replica convergence**
- two replicas exchange outbox ops and converge
- concurrent insert and delete converge

**LWW metadata**
- setMeta stores and retrieves a value
- mergeMeta applies remote state
- two replicas converge on metadata after cross-merge

---

### `tests/simulator/NetworkSim.test.ts`

Tests the full in-memory network simulator including the two-way partition model.

**addReplica**
- registers site in all other replicas GC
- new replica gets all existing sites in its GC

**step and runAll**
- step delivers ops and returns count
- runAll converges two replicas
- runAll converges three replicas
- runAll with random order still converges
- runAll with reverse order still converges
- runAll with deletes converges

**Partition blocks both directions**
- partitioned site does NOT receive ops from online sites
- partitioned site ops are NOT delivered to online sites
- queuedForSite counts both outgoing and incoming ops
- online replicas converge while one is partitioned

**Heal flushes both queues**
- heal delivers partitioned site outgoing ops to online sites
- heal delivers online ops to formerly partitioned site
- heal delivers both directions and all replicas converge
- three replicas: one partitioned, heal, all converge
- heal with no partition is a no-op
- queuedForSite returns 0 after heal

**Convergence assertions**
- assertConverged checks online replicas only
- assertAllConverged requires all replicas to match
- expectConverged returns common text of online replicas
- expectConverged throws when online replicas diverge

**Manual broadcast**
- broadcast skips sender
- broadcast to partitioned receiver queues in heldIncoming

**Diagnostics**
- dumpTexts returns text per siteId
- totalPending counts buffered ops on online replicas only
- isPartitioned returns correct state

**LWW metadata**
- LWW metadata converges when manually merged

**Stress**
- 5 replicas, 20 ops each, random delivery, converge
- partition half, let others sync, heal, all converge

---

## Known scope boundaries

The following are intentionally out of scope for Phase 1 and are covered in later phases:

| Feature | Phase |
|---|---|
| WebSocket relay server | Phase 2 |
| IndexedDB offline queue | Phase 2 |
| CodeMirror 6 integration | Phase 3 |
| Remote cursor presence | Phase 3 |
| Local undo/redo | Phase 3 |
| Role-based access control | Phase 3 |
| Causal buffer with real network reordering | Phase 2 |

Tests intentionally do not shuffle ops within a single site's causal chain. Each site's ops form a chain where `op[i].afterId = op[i-1].nodeId`. Delivering `op[i]` before `op[i-1]` is a causal ordering violation — `RGADocument` correctly throws in that case. `CausalBuffer` (Phase 2) prevents this from reaching `RGADocument` in the real system.