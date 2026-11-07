import { NodeId, SiteId, VectorClockSnapshot, RGAInsert, RGADelete, nodeKey } from "../types";
import { RGANode } from "./RGANode";

/**
 * RGADocument — the Replicated Growable Array.
 *
 * Maintains an ordered linked list of RGANode objects representing the full
 * document history (visible characters + tombstones). Supports:
 *
 *   - Local inserts/deletes: generate an operation and apply it locally.
 *   - Remote inserts/deletes: apply an incoming operation deterministically.
 *   - Convergence guarantee: any set of operations applied in any order
 *     produces the same visible text, provided causal ordering is respected.
 *
 * ── Conflict resolution rule ────────────────────────────────────────────────
 * When two concurrent inserts both target the same predecessor P, they are
 * ordered by descending siteId (lexicographic). The node with the
 * lexicographically greater siteId is placed to the LEFT (earlier in the
 * document). Ties on siteId are broken by descending counter.
 *
 * This gives a total, deterministic order over all possible NodeIds, so every
 * replica independently arrives at the same linked list regardless of
 * operation delivery order.
 */
export class RGADocument {
  /** The first real node in the list. null = document is empty. */
  private head: RGANode | null;

  /**
   * O(1) lookup from nodeKey → RGANode.
   * Every node that has ever been inserted lives here until TombstoneGC prunes it.
   */
  private nodeMap: Map<string, RGANode>;

  /** This replica's site identifier. */
  readonly siteId: SiteId;

  /**
   * Insert-only Lamport counter. Incremented on every local insert.
   * Counts only inserts, NOT deletes — so it diverges from the VectorClock
   * counter after the first delete. Use op.clock[siteId] + 1 to advance a
   * VectorClock; do not use NodeId.counter for that purpose.
   */
  private localCounter: number;

  constructor(siteId: SiteId) {
    this.siteId = siteId;
    this.localCounter = 0;
    this.head = null;
    this.nodeMap = new Map();
  }

  // ─── Priority comparison ──────────────────────────────────────────────────

  /**
   * Returns true if node a should appear to the LEFT of node b in the
   * document when they are concurrent inserts targeting the same predecessor.
   *
   * Rule: higher siteId (lex desc) → left. Tie on siteId → higher counter → left.
   */
  private hasPriorityOver(a: NodeId, b: NodeId): boolean {
    if (a.siteId !== b.siteId) return a.siteId > b.siteId;
    return a.counter > b.counter;  // take the site whose lamport clock is higher
  }

  // ─── Core apply methods ───────────────────────────────────────────────────

  /**
   * Apply a remote (or locally-generated) insert operation.
   *
   * Algorithm:
   *   1. Look up the predecessor node (null if inserting at head).
   *   2. Scan rightward from the predecessor. Skip any node that:
   *      (a) shares the same predecessor (concurrent insert), AND
   *      (b) has higher priority than the incoming node.
   *   3. Insert the new node at the current position.
   *
   * Idempotent: re-applying an already-seen operation is a no-op.
   *
   * Throws if the predecessor is not found — this should never happen if
   * the CausalBuffer delivers operations in causal order.
   *
   * @param op  The RGAInsert to apply.
   */
  applyInsert(op: RGAInsert): void {
    const key = nodeKey(op.nodeId);

    // Idempotency: ignore duplicate operations
    if (this.nodeMap.has(key)) return;

    // Locate predecessor
    let predecessor: RGANode | null = null;
    if (op.afterId !== null) {
      const predKey = nodeKey(op.afterId);
      const found = this.nodeMap.get(predKey);
      if (!found) {
        throw new Error(
          `RGADocument.applyInsert: predecessor ${predKey} not found. ` +
          `This indicates a causal ordering violation — use CausalBuffer.`
        );
      }
      predecessor = found;
    }

    // Scan right to find insertion point
    // current = the node after which we will insert
    let current: RGANode | null = predecessor;

    while (true) {
      // Peek at the node that would follow current
      const next: RGANode | null = (current === null) ? this.head : current.next;
      if (next === null) break; // reached the tail — insert here

      // Scan past ANY node with higher priority, regardless of its afterId.
      // This is the correct RGA rule: a node with higher priority always sits
      // to the left, even if it was inserted at a different position in a
      // concurrent operation. Restricting the check to nodes sharing the same
      // afterId (the previous version) breaks convergence when two sites build
      // independent chains that interleave at the same logical position.
      if (this.hasPriorityOver(next.id, op.nodeId)) {
        current = next;
        continue;
      }
      break;
    }

    // Create the node and splice it in after current
    const newNode = new RGANode(op.nodeId, op.value, op.afterId);
    if (current === null) {
      newNode.next = this.head;
      this.head = newNode;
    } else {
      newNode.next = current.next;
      current.next = newNode;
    }

    this.nodeMap.set(key, newNode);
  }

  /**
   * Apply a remote (or locally-generated) delete operation.
   *
   * Marks the target node as a tombstone. The node stays in the list so
   * that any subsequent insert using it as a predecessor resolves correctly.
   *
   * Idempotent: deleting an already-deleted node is a no-op.
   *
   * Throws if the target node is not found.
   *
   * @param op  The RGADelete to apply.
   */
  applyDelete(op: RGADelete): void {
    const key = nodeKey(op.targetId);
    const node = this.nodeMap.get(key);
    if (!node) {
      throw new Error(
        `RGADocument.applyDelete: target node ${key} not found.`
      );
    }
    node.isDeleted = true; // idempotent assignment
  }

  // ─── Local operation generators ───────────────────────────────────────────

  /**
   * Generate and immediately apply a local insert operation.
   *
   * @param afterId  NodeId of the predecessor character, or null to insert
   *                 at the document head. Use getAfterIdForOffset() to
   *                 convert a cursor offset to a NodeId.
   * @param value    Single character to insert.
   * @param clock    Current vector clock snapshot (from VectorClock.snapshot()
   *                 BEFORE incrementing for this operation).
   * @returns        The RGAInsert to broadcast to all other replicas.
   */
  localInsert(
    afterId: NodeId | null,
    value: string,
    clock: VectorClockSnapshot
  ): RGAInsert {
    this.localCounter += 1;
    const nodeId: NodeId = { siteId: this.siteId, counter: this.localCounter };
    const op: RGAInsert = { type: "insert", nodeId, afterId, value, clock };
    this.applyInsert(op);
    return op;
  }

  /**
   * Generate and immediately apply a local delete operation.
   *
   * @param nodeId   The NodeId of the character to delete. Use
   *                 getNodeIdAtOffset() to find it from a cursor position.
   * @param clock    Current vector clock snapshot.
   * @returns        The RGADelete to broadcast.
   */
  localDelete(nodeId: NodeId, clock: VectorClockSnapshot): RGADelete {
    const op: RGADelete = { type: "delete", targetId: nodeId, clock };
    this.applyDelete(op);
    return op;
  }

  // ─── Document reads ───────────────────────────────────────────────────────

  /**
   * Returns the current visible text of the document.
   * Tombstoned nodes are skipped.
   * O(n) where n = total node count (including tombstones).
   */
  toVisibleString(): string {
    let chars = "";
    let current = this.head;
    while (current !== null) {
      if (!current.isDeleted) chars += current.value
      current = current.next;
    }
    return chars;
  }

  /**
   * Returns a map from nodeKey → 0-based visible character offset.
   * Only visible (non-tombstoned) nodes appear in the map.
   *
   * Used by Phase 3 to translate a remote cursor NodeId reference into the
   * character offset the editor needs for rendering.
   *
   * O(n).
   */
  toOffsetIndex(): Map<string, number> {
    const index = new Map<string, number>();
    let offset = 0;
    let current = this.head;
    while (current !== null) {
      if (!current.isDeleted) {
        index.set(current.key, offset);
        offset++;
      }
      current = current.next;
    }
    return index;
  }

  /**
   * Returns the NodeId of the visible character at the given 0-based offset.
   * Returns null if offset is out of range.
   *
   * Used to record a cursor position as a stable NodeId reference that
   * survives concurrent remote edits.
   *
   * O(n).
   */
  getNodeIdAtOffset(offset: number): NodeId | null {
    let count = 0;
    let current = this.head;
    while (current !== null) {
      if (!current.isDeleted) {
        if (count === offset) return current.id;
        count++;
      }
      current = current.next;
    }
    return null;
  }

  /**
   * Returns the NodeId to use as afterId when inserting at a given cursor
   * offset. Offset 0 = insert at head (returns null). Offset N = insert
   * after the Nth visible character.
   *
   * Example: document "hello", offset 3 → returns NodeId of 'l' (index 2).
   *          localInsert(getAfterIdForOffset(3), 'X', clock) → "helXlo".
   *
   * O(n).
   */
  getAfterIdForOffset(offset: number): NodeId | null {
    if (offset === 0) return null;
    return this.getNodeIdAtOffset(offset - 1);
  }

  /**
   * Returns the number of visible (non-tombstoned) characters.
   * O(n).
   */
  getVisibleLength(): number {
    let count = 0;
    let current = this.head;
    while (current !== null) {
      if (!current.isDeleted) count++;
      current = current.next;
    }
    return count;
  }

  // ─── GC support ───────────────────────────────────────────────────────────

  /**
   * Returns all NodeIds currently in the list (visible + tombstones).
   * Used by TombstoneGC to track which nodes exist.
   */
  getAllNodeIds(): NodeId[] {
    const ids: NodeId[] = [];
    let current = this.head;
    while (current !== null) {
      ids.push(current.id);
      current = current.next;
    }
    return ids;
  }

  /**
   * Returns NodeIds of all tombstoned (soft-deleted) nodes.
   * Used by TombstoneGC to identify candidates for physical removal.
   */
  getDeletedNodeIds(): NodeId[] {
    const ids: NodeId[] = [];
    let current = this.head;
    while (current !== null) {
      if (current.isDeleted) ids.push(current.id);
      current = current.next;
    }
    return ids;
  }

  /**
   * Physically unlinks a tombstoned node from the list and removes it from
   * nodeMap. Only called by TombstoneGC after all sites have acknowledged
   * the deletion.
   *
   * Silently ignores calls on non-existent or non-deleted nodes.
   *
   * O(n) due to linked-list traversal.
   */
  pruneNode(nodeId: NodeId): void {
    const key = nodeKey(nodeId);
    const node = this.nodeMap.get(key);
    if (!node || !node.isDeleted) return;

    if (this.head === node) {
      this.head = node.next;
    } else {
      let prev = this.head;
      while (prev !== null && prev.next !== node) {
        prev = prev.next;
      }
      if (prev) prev.next = node.next;
    }
    node.next = null; // help GC
    this.nodeMap.delete(key);
  }

  // ─── Diagnostics ──────────────────────────────────────────────────────────

  /**
   * Returns a debug representation showing all nodes including tombstones.
   * Example: "[a(✓), b(✗), c(✓)]"  where ✗ = deleted, ✓ = visible.
   */
  debugDump(): string {
    const parts: string[] = [];
    let current = this.head;
    while (current !== null) {
      parts.push(current.toString());
      current = current.next;
    }
    return `[${parts.join(", ")}]`;
  }

  /** Total node count including tombstones. */
  get totalNodeCount(): number {
    return this.nodeMap.size;
  }
}