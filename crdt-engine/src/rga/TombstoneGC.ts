import { NodeId, SiteId, nodeKey } from "../types";
import { RGADocument } from "./RGADocument";

/**
 * TombstoneGC — garbage collector for soft-deleted RGA nodes.
 *
 * RGA uses tombstones (isDeleted = true) instead of physical removal so that
 * concurrent inserts targeting a deleted node as their predecessor still
 * resolve correctly. However, tombstones accumulate unboundedly in long-lived
 * documents. This class tracks acknowledgements and prunes nodes only once
 * every known site has confirmed it has seen the deletion.
 *
 * ── Protocol ────────────────────────────────────────────────────────────────
 * When Site A deletes a node and broadcasts an RGADelete, every receiving
 * site S calls acknowledge(nodeId, S) after successfully applying the delete.
 * Once every registered site appears in the ack set for a given node, the
 * node is safe to prune from the linked list.
 *
 * ── Integration point ───────────────────────────────────────────────────────
 * The sync layer (Phase 2) triggers acknowledge() after delivering an
 * RGADelete to the local RGADocument. collect() is called periodically
 * (e.g. after every N operations, or on a timer) rather than on every op
 * to amortise the O(tombstones) cost.
 */
export class TombstoneGC {
  /**
   * All site IDs that participate in this session.
   * A node is only prunable when every site in this set has acknowledged it.
   */
  private knownSites: Set<SiteId>;

  /**
   * Acknowledgement matrix: nodeKey → set of siteIds that have acked.
   * Entries are created on first ack and removed after pruning.
   */
  private ackMatrix: Map<string, Set<SiteId>>;

  constructor() {
    this.knownSites = new Set();
    this.ackMatrix = new Map();
  }

  // ─── Site management ─────────────────────────────────────────────────────

  /**
   * Register a site as a participant. Must be called for every site
   * (including the local one) before any collect() calls, otherwise nodes
   * will be pruned before all sites have confirmed the deletion.
   *
   * @param siteId  The site to register.
   */
  registerSite(siteId: SiteId): void {
    this.knownSites.add(siteId);
  }

  /**
   * Deregister a site (e.g. on clean disconnect). After deregistration,
   * that site's ack is no longer required for future collect() calls.
   * Note: already-pending ack sets are not retroactively updated; call
   * collect() after deregistering to trigger any newly-eligible pruning.
   *
   * @param siteId  The site to remove.
   */
  deregisterSite(siteId: SiteId): void {
    this.knownSites.delete(siteId);
  }

  /** Returns the current set of registered site IDs. */
  getKnownSites(): ReadonlySet<SiteId> {
    return this.knownSites;
  }

  // ─── Acknowledgement ──────────────────────────────────────────────────────

  /**
   * Record that siteId has successfully applied the deletion of nodeId.
   * Should be called by the sync layer for every site (including local)
   * upon applying an RGADelete.
   *
   * @param nodeId  The deleted node being acknowledged.
   * @param siteId  The site that has acknowledged the deletion.
   */
  acknowledge(nodeId: NodeId, siteId: SiteId): void {
    const key = nodeKey(nodeId);
    if (!this.ackMatrix.has(key)) {
      this.ackMatrix.set(key, new Set());
    }
    this.ackMatrix.get(key)!.add(siteId);
  }

  /**
   * Returns how many sites have acknowledged the deletion of nodeId.
   * Useful for diagnostics and testing.
   */
  ackCount(nodeId: NodeId): number {
    return this.ackMatrix.get(nodeKey(nodeId))?.size ?? 0;
  }

  /**
   * Returns true if nodeId is safe to prune (all known sites have acked).
   */
  isCollectable(nodeId: NodeId): boolean {
    if (this.knownSites.size === 0) return false;
    const acks = this.ackMatrix.get(nodeKey(nodeId));
    if (!acks) return false;
    for (const site of this.knownSites) {
      if (!acks.has(site)) return false;
    }
    return true;
  }

  // ─── Collection ───────────────────────────────────────────────────────────

  /**
   * Physically remove all tombstoned nodes that every known site has
   * acknowledged. Mutates the supplied RGADocument's linked list.
   *
   * Should be called periodically rather than on every operation.
   *
   * @param doc  The RGADocument to prune.
   * @returns    Array of pruned NodeIds (for logging / diagnostics).
   */
  collect(doc: RGADocument): NodeId[] {
    if (this.knownSites.size === 0) return [];

    const pruned: NodeId[] = [];
    const deletedIds = doc.getDeletedNodeIds();

    for (const nodeId of deletedIds) {
      if (this.isCollectable(nodeId)) {
        doc.pruneNode(nodeId);
        this.ackMatrix.delete(nodeKey(nodeId));
        pruned.push(nodeId);
      }
    }

    return pruned;
  }

  // ─── Diagnostics ──────────────────────────────────────────────────────────

  /**
   * Returns the number of nodes currently awaiting full acknowledgement.
   */
  get pendingAckCount(): number {
    return this.ackMatrix.size;
  }

  /** Debug dump of the ack matrix. */
  debugDump(): string {
    const lines: string[] = [`Known sites: [${[...this.knownSites].join(", ")}]`];
    for (const [key, acks] of this.ackMatrix.entries()) {
      lines.push(`  ${key}: acked by [${[...acks].join(", ")}]`);
    }
    return lines.join("\n");
  }
}