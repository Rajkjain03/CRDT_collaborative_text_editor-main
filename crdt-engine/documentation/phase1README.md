# crdt-engine — Phase 1

A from-scratch TypeScript implementation of a Conflict-Free Replicated Data Type engine for collaborative text editing. Phase 1 delivers the core data structures, algorithms, and an interactive simulator. No sockets, no browser, no UI — pure algorithmic correctness.

---

## What this is

A collaborative text editor must let multiple users type simultaneously and guarantee that every user ends up with the same document, regardless of network conditions or the order in which edits arrive. This is the convergence problem.

`crdt-engine` solves it using two complementary CRDTs:

**RGA (Replicated Growable Array)** for the document body. Every character is a permanent node in a linked list, tagged with a unique `(siteId, counter)` identifier. Inserts place a new node at a specific position. Deletes mark nodes as tombstones rather than removing them, preserving the ordering structure for future concurrent inserts. When two sites insert at the same position simultaneously, a deterministic priority rule (descending `siteId`, then descending `counter`) breaks the tie the same way on every replica.

**LWW-Register (Last-Write-Wins Register)** for document metadata — title, presence indicators, access roles. Each field is independently versioned by a wall-clock timestamp and a `siteId` tie-breaker. Full state snapshots are periodically exchanged; merge takes the highest-timestamped entry per field.

---

## Distributed systems algorithms

Phase 1 implements four well-defined distributed systems algorithms from scratch. Each maps directly to a class or module in the codebase.

### 1. RGA — Replicated Growable Array

**What it is:** An operation-based sequence CRDT for collaborative text editing. Each character is a node in a linked list tagged with a unique `(siteId, counter)` timestamp pair called an s4vector. Insert and delete operations are broadcast to all replicas; convergence is guaranteed by the commutativity and precedence-transitivity properties of the algorithm.

**Core properties:**
- *Operation commutativity (OC)*: for any two concurrent operations O1 and O2, applying O1 then O2 produces the same state as O2 then O1.
- *Precedence transitivity (PT)*: if O1 happened-before O2, then O1 is always applied before O2 regardless of delivery order.

**Conflict resolution rule (our implementation):** When two concurrent inserts both target the same predecessor node P, scan right from P past any node whose `(siteId, counter)` is lexicographically greater than the incoming node's. Insert at the first position where the next node has lower priority. This gives a total, deterministic order over all possible node pairs.

**Where it lives:** `src/rga/RGADocument.ts` — `applyInsert`, `applyDelete`, `hasPriorityOver`.

**Original paper:** Roh, H.G., Jeon, M., Kim, J.S., Lee, J. (2011). "Replicated abstract data types: Building blocks for collaborative applications." *Journal of Parallel and Distributed Computing*, 71(3), 354–368.
`https://doi.org/10.1016/j.jpdc.2010.12.006`

---

### 2. Vector clocks

**What they are:** A mechanism for tracking causal relationships between events in a distributed system. Each replica maintains a vector `V` where `V[s]` is the number of operations from site `s` that this replica has delivered. An operation carries a snapshot of the sender's vector clock at the time of generation.

**Happens-before rule:** Operation A happened-before B if and only if `A.clock[s] ≤ B.clock[s]` for all sites `s`, and strictly less for at least one. Two operations are concurrent if neither happened-before the other.

**Delivery condition:** An operation O from site S (with clock snapshot C taken before O was generated) is ready to deliver when `local[s] ≥ C[s]` for every site `s`. This ensures all of S's causal predecessors have already been applied.

**Critical invariant (our implementation):** The clock snapshot must be taken *before* incrementing for the local operation. If taken after, `hasDelivered` will require one extra delivery before releasing buffered ops — a systematic off-by-one in causal ordering.

**Where it lives:** `src/clocks/VectorClock.ts` — `increment`, `snapshot`, `hasDelivered`, `happensBefore`.

**Original papers:**
- Lamport, L. (1978). "Time, Clocks, and the Ordering of Events in a Distributed System." *Communications of the ACM*, 21(7), 558–565.
  `https://doi.org/10.1145/359545.359563`
  *(Introduced happens-before and logical clocks. Vector clocks extend this to detect concurrency.)*
- Fidge, C.J. (1988). "Timestamps in Message-Passing Systems That Preserve the Partial Ordering." *Proceedings of the 11th Australian Computer Science Conference*, 10(1), 56–66.
  `https://www.semanticscholar.org/paper/Timestamps-in-Message-Passing-Systems-That-Preserve-Fidge/e706b8ae2952740cb95c0182c4c44b0d11cc54c1`
  *(Named and formalised vector clocks independently of Mattern.)*
- Mattern, F. (1989). "Virtual Time and Global States of Distributed Systems." *Proceedings of the Workshop on Parallel and Distributed Algorithms*, 215–226.
  *(Co-originator of vector clocks, working independently from Fidge.)*

---

### 3. Causal delivery (hold-back queue)

**What it is:** A message delivery protocol that ensures an operation is applied to the local replica only after all operations it causally depends on have already been applied. Operations that arrive before their dependencies are buffered in a hold-back queue until the dependency is satisfied.

**Algorithm (our implementation):**
1. On receiving op O, place it in `CausalBuffer`.
2. Scan the buffer. For each op, check `vectorClock.hasDelivered(op.clock)`.
3. If satisfied, remove from buffer, apply to `RGADocument`, increment `vectorClock[sender]`.
4. Repeat until no further ops can be released in one pass (fixed-point iteration).

**Why it is necessary:** RGA's `applyInsert` looks up the predecessor node by ID. If the insert that created that predecessor hasn't arrived yet, the lookup fails. Causal delivery prevents this by ensuring predecessor ops are always applied first.

**Where it lives:** `src/clocks/CausalBuffer.ts` — `receive`, `drain`.

**Original paper:** Birman, K., Schiper, A., Stephenson, P. (1991). "Lightweight Causal and Atomic Group Multicast." *ACM Transactions on Computer Systems*, 9(3), 272–314.
`https://doi.org/10.1145/128738.128742`
*(Introduced the CBCAST protocol and the hold-back queue pattern for causal delivery.)*

---

### 4. State-based CRDT merge — LWW-Register (CvRDT)

**What it is:** A convergent replicated data type (CvRDT, or state-based CRDT) for key-value metadata. Each field stores a `(value, timestamp, siteId)` triple. The merge function takes the pointwise maximum over all fields: for each field, keep the entry with the highest timestamp, breaking ties by descending `siteId`.

**Convergence proof:** The merge function is commutative (`merge(A, B) = merge(B, A)`), associative (`merge(merge(A, B), C) = merge(A, merge(B, C))`), and idempotent (`merge(A, A) = A`). These three properties are the sufficient condition for a CvRDT to guarantee strong eventual consistency.

**Where it lives:** `src/lww/LWWRegister.ts` — `merge`, `set`, `snapshot`.

**Original paper (unified CRDT framework):** Shapiro, M., Preguiça, N., Baquero, C., Zawirski, M. (2011). "Conflict-free Replicated Data Types." INRIA Research Report RR-7687.
`https://inria.hal.science/inria-00609399`
*(Formalised both state-based (CvRDT) and operation-based (CmRDT) approaches and their sufficient conditions. The LWW-Register is one of the examples studied in this paper.)*

---

## Architecture

```
types.ts
  Shared primitives used by every module.
  NodeId, RGAInsert, RGADelete, VectorClockSnapshot, LWWUpdate.

rga/
  RGANode.ts        — one character: id, value, afterId, isDeleted, next pointer
  RGADocument.ts    — linked list with insert/delete/conflict resolution/GC support
  TombstoneGC.ts    — prunes acknowledged tombstones when all sites have seen them

clocks/
  VectorClock.ts    — per-replica causal clock: increment, snapshot, hasDelivered
  CausalBuffer.ts   — holds out-of-order remote ops until dependencies arrive

lww/
  LWWRegister.ts    — timestamp-based last-write-wins map for metadata

simulator/
  Replica.ts        — composes all components into one node; enforces correct clock sequencing
  NetworkSim.ts     — in-memory network: step/runAll delivery, two-way partition/heal
  cli.ts            — interactive REPL for live exploration
```

---

## Key design decisions

### Why RGA and not LSEQ or Logoot?

RGA's conflict resolution rule — a simple comparison of `(siteId, counter)` tuples — is easier to verify correct than LSEQ's tree-based position allocation. For a from-scratch implementation under a time constraint, the simpler algorithm is the right choice. RGA is also well-studied with published proofs of convergence.

### Why soft-delete (tombstones)?

When a character is deleted, its node stays in the linked list as a tombstone. This is necessary because a concurrent insert may reference that node as its predecessor. If the node were physically removed, the insert would have no anchor and the linked list would be corrupted. Tombstones are only physically removed by `TombstoneGC` once every known site has acknowledged the deletion.

### Why vector clocks and not Lamport clocks?

A Lamport clock gives a total order but cannot detect concurrent events — it cannot determine whether two events are causally related or truly independent. Vector clocks let `CausalBuffer` determine whether an incoming op's dependencies have already been delivered locally, which is required for correct causal ordering of RGA inserts. Lamport clocks are insufficient for this.

### Why separate the clock from RGADocument?

`RGADocument` owns the `localCounter` for generating unique `NodeId`s. `VectorClock` tracks causal delivery for the network layer. Mixing them would couple the data structure to the transport protocol. The `Replica` class composes both and enforces the correct sequencing: snapshot the clock before generating an op, increment it after.

### Why star topology (relay) and not peer-to-peer?

True P2P requires each client to maintain connections to every other client, handle discovery, and route messages — significant complexity with no algorithmic benefit at this stage. A relay server forwards ops without understanding them. The CRDT convergence guarantee is independent of the relay; the relay is just a message bus.

### Why LWW for metadata and not RGA?

Metadata fields like document title change infrequently and are written by one user at a time. RGA's per-character operation model is overkill — it would generate O(N) ops for an N-character title update. LWW exchanges full field values as atomic units, which is correct and bandwidth-efficient for this use case.

---

## Data flow

```
User keystroke
    │
    ▼
Replica.insert(offset, char)
    │  1. clock.snapshot()    → attach to op
    │  2. doc.localInsert()   → apply locally, get RGAInsert
    │  3. clock.increment()   → advance clock
    │
    ▼
op placed in Replica.outbox
    │
    ▼
NetworkSim.step() drains outbox
    │
    ▼
For each remote replica:
    Replica.receive(op)
        │  1. CausalBuffer.receive(op)
        │  2. CausalBuffer.drain()  → satisfied ops in causal order
        │  3. RGADocument.applyInsert/applyDelete
        │  4. clock.increment(sender)
        │
        ▼
    RGADocument state updated
    TombstoneGC.collect() runs after each delivery round
```

---

## Convergence guarantee

The RGA algorithm guarantees that any two replicas that have received the same set of operations will have identical document state, regardless of the order in which those operations were applied — as long as causal order within each site's chain is preserved.

This is verified by the convergence test suite which:

- Applies all permutations of concurrent ops across multiple replicas and asserts identical results
- Tests idempotency (applying the same op twice produces no change)
- Tests concurrent deletes (two sites delete the same node — idempotent, correct)
- Tests insert-after-tombstone (inserting after a deleted node still positions correctly)
- Runs 5-site stress tests with random delivery order

---

## The clock sequencing invariant

This is the most important correctness invariant in the codebase and the one most likely to be broken by a caller:

```
WRONG:  clock.increment()  →  clock.snapshot()  →  op.clock = snapshot
RIGHT:  clock.snapshot()   →  op.clock = snapshot  →  clock.increment()
```

The snapshot must be taken before incrementing. The op's clock field records the causal state of the world at the moment the op was generated — not after. `CausalBuffer.hasDelivered(op.clock)` uses this to check whether all ops that causally precede this one have been delivered. If the snapshot is taken after incrementing, the buffer will require one extra delivery before releasing the op, causing a systematic off-by-one in causal ordering.

`Replica.insert()` and `Replica.delete()` enforce this sequence internally so no caller can get it wrong.

---

## Interactive CLI

```bash
npm install
npm run cli               # 3 replicas
npm run cli:4             # 4 replicas
```

Commands at the `crdt>` prompt:

| Command | Effect |
|---|---|
| `ins S1 0 hello` | Insert "hello" at offset 0 on S1 |
| `del S2 3` | Delete character at offset 3 on S2 |
| `step` | Deliver one round of ops (causal order) |
| `step random` | Deliver one round in random order |
| `sync` | Deliver until online replicas converge |
| `partition S1` | Fully isolate S1 (no send, no receive) |
| `heal` | Reconnect all partitioned sites, flush both queues |
| `meta S1 title Doc` | Set LWW metadata field on S1 |
| `syncmeta` | Merge all replicas' LWW snapshots |
| `log` | Show raw RGA node list including tombstones |
| `state` | Print live state of all replicas |

See `PHASE1_GUIDE.md` for full command reference and annotated walkthroughs.

---

## Running tests

```bash
npm test                    # all tests
npm run test:rga            # RGA document, GC, convergence
npm run test:lww            # LWW register
npm run test:sim            # Replica and NetworkSim
npm run test:coverage       # coverage report
```

Test count by module:

| File | Tests |
|---|---|
| `RGADocument.test.ts` | 25 |
| `TombstoneGC.test.ts` | 14 |
| `convergence.test.ts` | 12 |
| `LWWRegister.test.ts` | 22 |
| `Replica.test.ts` | 24 |
| `NetworkSim.test.ts` | 34 |
| **Total** | **131** |

---

## What Phase 1 does not include

Phase 1 is intentionally bounded to algorithmic correctness. The following are explicitly deferred:

- **WebSocket relay** — ops are delivered in-memory by `NetworkSim`, not over a real network
- **IndexedDB persistence** — the offline queue is simulated by `NetworkSim.partition()`; nothing is written to disk
- **Browser / editor UI** — no CodeMirror, no React, no DOM
- **Cursor presence** — cursors require a translation layer from RGA node references to editor offsets (Phase 3)
- **Undo/redo** — requires compensating operations built on top of a stable CRDT layer (Phase 3)
- **Access control** — role tokens require a relay server to enforce (Phase 2/3)
- **mDNS discovery** — not needed until real network transport exists (Phase 2)

---

## Prototype deliverable

The Phase 1 prototype is `crdt-engine` — a standalone TypeScript package with a simulator CLI. It can be imported directly by Phase 2's networking layer and Phase 3's editor integration without modification. The `Replica` class is the integration point: Phase 2 replaces `NetworkSim`'s in-memory delivery with real WebSocket transport while keeping `Replica` unchanged.

---

## References

All algorithmic content in this codebase derives from the following peer-reviewed sources.

**RGA algorithm**
- Roh, H.G., Jeon, M., Kim, J.S., Lee, J. (2011). "Replicated abstract data types: Building blocks for collaborative applications." *Journal of Parallel and Distributed Computing*, 71(3), 354–368.
  `https://doi.org/10.1016/j.jpdc.2010.12.006`
  *(The primary reference for the RGA data structure, tombstone model, and s4vector conflict resolution.)*

**CRDT framework (state-based and operation-based)**
- Shapiro, M., Preguiça, N., Baquero, C., Zawirski, M. (2011). "Conflict-free Replicated Data Types." INRIA Research Report RR-7687.
  `https://inria.hal.science/inria-00609399`
  *(Unified framework formalising CvRDTs and CmRDTs; source for the LWW-Register definition and merge rules.)*

**Logical clocks and happens-before**
- Lamport, L. (1978). "Time, Clocks, and the Ordering of Events in a Distributed System." *Communications of the ACM*, 21(7), 558–565.
  `https://doi.org/10.1145/359545.359563`
  *(Foundational paper introducing the happens-before relation and logical clocks.)*

**Vector clocks**
- Fidge, C.J. (1988). "Timestamps in Message-Passing Systems That Preserve the Partial Ordering." *Proceedings of the 11th Australian Computer Science Conference*, 10(1), 56–66.
  `https://www.semanticscholar.org/paper/Timestamps-in-Message-Passing-Systems-That-Preserve-Fidge/e706b8ae2952740cb95c0182c4c44b0d11cc54c1`
  *(One of two independent originators of vector clocks; named and formalised their mathematical properties.)*
- Mattern, F. (1989). "Virtual Time and Global States of Distributed Systems." *Parallel and Distributed Algorithms*, North-Holland, 215–226.
  *(Co-originator of vector clocks, working independently from Fidge; the two papers are jointly cited as the canonical vector clock reference.)*

**Causal delivery**
- Birman, K., Schiper, A., Stephenson, P. (1991). "Lightweight Causal and Atomic Group Multicast." *ACM Transactions on Computer Systems*, 9(3), 272–314.
  `https://doi.org/10.1145/128738.128742`
  *(Introduced the CBCAST protocol and the hold-back queue pattern that `CausalBuffer` implements.)*

**Supplementary reading**
- Wikipedia: Vector clock. `https://en.wikipedia.org/wiki/Vector_clock`
  *(Accessible summary of vector clock properties and historical context.)*
- Shapiro, M., Preguiça, N., Baquero, C., Zawirski, M. (2011). "A Comprehensive Study of Convergent and Commutative Replicated Data Types." INRIA Research Report RR-7506.
  `https://inria.hal.science/inria-00555588`
  *(Extended technical report; more detailed treatment of CvRDT/CmRDT conditions and examples than the conference version above.)*
