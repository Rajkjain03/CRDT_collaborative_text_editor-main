import { RGAOperation, RGAInsert, RGADelete, NodeId } from "crdt-engine";

export type CompensatingOp = 
  | { type: "undo_insert"; text: string; afterId: NodeId | null }
  | { type: "undo_delete"; targetId: NodeId };

// Returns how to undo an operation
export function compensate(op: RGAOperation): CompensatingOp {
  if (op.type === "insert") {
    // To undo an insert, we must delete the newly inserted node.
    return { type: "undo_delete", targetId: op.nodeId };
  } else {
    // To undo a delete, we must re-insert the same value after its original predecessor.
    // wait, RGA operation doesn't store the deleted character's `value` or `afterId` natively 
    // in Phase 1's RGADelete definition.
    // So to perfectly compensate a delete, the local history stack must record the character
    // string and its predecessor at the time of deletion.
    // For now, we will stub this. 
    return { type: "undo_insert", text: "?", afterId: null }; 
  }
}
