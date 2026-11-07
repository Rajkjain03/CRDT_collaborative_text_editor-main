import type { NodeId, Replica } from "crdt-engine";
import { nodeKey } from "crdt-engine";

export class OffsetMap {
  private replica: Replica;

  constructor(replica: Replica) {
    this.replica = replica;
  }

  getPredecessorIdForVisibleOffset(offset: number): NodeId | null {
    return this.replica.doc.getAfterIdForOffset(offset);
  }

  getNodeIdAtVisibleOffset(offset: number): NodeId | null {
    return this.replica.doc.getNodeIdAtOffset(offset);
  }

  getVisibleOffsetForNodeId(nodeId: NodeId): number | null {
    const index = this.replica.doc.toOffsetIndex();
    const offset = index.get(nodeKey(nodeId));
    return offset !== undefined ? offset : null;
  }
}