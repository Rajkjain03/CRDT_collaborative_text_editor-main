import { NodeId, SiteId } from "crdt-engine";
import { ClientSync } from "collab-sync";
import { OffsetMap } from "./offsetMap";

export interface CursorPresence {
  nodeId: NodeId;
  offsetWithinNode: 0 | 1; // 0 = before node, 1 = after node
}

export interface SelectionPresence {
  anchor: CursorPresence;
  head: CursorPresence;
}

/**
 * Encodes a local CodeMirror selection into a stable RGA presence object,
 * and writes it to the LWW register under `cursor:<siteId>`.
 */
export function broadcastPresence(
  client: ClientSync,
  offsetMap: OffsetMap,
  visibleAnchor: number,
  visibleHead: number
) {
  // Convert visible offset to NodeId + offset representation
  const headPresence = resolveCursorPresence(offsetMap, visibleHead);
  const anchorPresence = resolveCursorPresence(offsetMap, visibleAnchor);

  if (headPresence && anchorPresence) {
    const payload: SelectionPresence = { anchor: anchorPresence, head: headPresence };
    client.setMeta(`cursor:${client.siteId}`, payload);
  }
}

function resolveCursorPresence(offsetMap: OffsetMap, visibleOffset: number): CursorPresence | null {
  // If offset is 0, we are at the head.
  if (visibleOffset === 0) {
    // Actually, we can represent this as offset 0 of the first node or null node
    // For simplicity, offsetMap.getPredecessorIdForVisibleOffset handles offset 0 by returning null.
    // However, Phase 3 spec says `{ nodeId: NodeId, offsetWithinNode: 0|1 }`.
    // Let's get the predecessor and say we are 'after' it, or the successor and 'before' it.
  }
  
  const predId = offsetMap.getPredecessorIdForVisibleOffset(visibleOffset);
  if (predId) {
    return { nodeId: predId, offsetWithinNode: 1 };
  } else {
    // We are at the very beginning of the doc.
    const firstNode = offsetMap.getNodeIdAtVisibleOffset(0);
    if (firstNode) {
      return { nodeId: firstNode, offsetWithinNode: 0 };
    }
  }
  return null; // Empty document
}
