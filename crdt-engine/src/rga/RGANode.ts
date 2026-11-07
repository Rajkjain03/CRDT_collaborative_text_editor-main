import { NodeId, nodeKey } from "../types";

/**
 * A single node in the RGA linked list, representing one character.
 *
 * Nodes are never removed during normal operation — deleted nodes become
 * tombstones (isDeleted = true) so that the ordering structure is preserved
 * for any future insert that references this node as afterId.
 *
 * Physical removal only happens via TombstoneGC once all sites have
 * acknowledged the deletion.
 */
export class RGANode {
  /** Globally unique identity of this node. Immutable after creation. */
  readonly id: NodeId;

  /** The character this node holds. Single UTF-16 code unit. */
  readonly value: string;

  /**
   * The id of the node this was inserted after.
   * null = this node was inserted at the document head.
   * Immutable after creation — used by conflict resolution when replaying
   * concurrent inserts that share the same predecessor.
   */
  readonly afterId: NodeId | null;

  /** True if this node has been soft-deleted (tombstoned). */
  isDeleted: boolean;

  /** Next node in the linked list. null = this is the tail. */
  next: RGANode | null;

  constructor(id: NodeId, value: string, afterId: NodeId | null) {
    this.id = id;
    this.value = value;
    this.afterId = afterId;
    this.isDeleted = false;
    this.next = null;
  }

  /** Canonical string key. Delegates to the shared helper in types.ts. */
  get key(): string {
    return nodeKey(this.id);
  }

  toString(): string {
    const del = this.isDeleted ? "✗" : "✓";
    return `${this.value}(${del})`;
  }
}