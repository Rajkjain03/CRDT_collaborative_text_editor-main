import { describe, it, expect, beforeEach, vi } from 'vitest';
import { OffsetMap } from '../../src/bridge/offsetMap';

describe('OffsetMap', () => {
  let replica: any;
  let offsetMap: OffsetMap;
  let siteId: string;

  beforeEach(() => {
    siteId = 'site-1';
    
    // Mock the expected Phase 1 RGA interface (uses .doc)
    replica = {
      doc: {
        getAfterIdForOffset: vi.fn(),
        getNodeIdAtOffset: vi.fn(),
        head: null 
      }
    };
    offsetMap = new OffsetMap(replica);
  });

  it('should map offset 0 to null (head of text)', () => {
    replica.doc.getAfterIdForOffset.mockReturnValue(null);
    expect(offsetMap.getPredecessorIdForVisibleOffset(0)).toBeNull();
  });

  it('should map visible offsets to node IDs accurately', () => {
    const idH = { siteId, counter: 0 };
    const idO = { siteId, counter: 4 };

    // Stub the underlying RGA methods
    replica.doc.getAfterIdForOffset.mockImplementation((offset: number) => {
      if (offset === 1) return idH;
      if (offset === 5) return idO;
      return null;
    });
    
    replica.doc.getNodeIdAtOffset.mockImplementation((offset: number) => {
      if (offset === 0) return idH;
      if (offset === 4) return idO;
      return null;
    });

    expect(offsetMap.getPredecessorIdForVisibleOffset(1)).toEqual(idH);
    expect(offsetMap.getPredecessorIdForVisibleOffset(5)).toEqual(idO);

    expect(offsetMap.getNodeIdAtVisibleOffset(0)).toEqual(idH);
    expect(offsetMap.getNodeIdAtVisibleOffset(4)).toEqual(idO);
  });

  it('should map node IDs to visible offsets, handling deletions correctly', () => {
    const idA = { siteId, counter: 0 };
    const idB = { siteId, counter: 1 };
    const idC = { siteId, counter: 2 };

    // Mock the linked list state for getOffsetVisually
    // 'a' (visible) -> 'b' (deleted) -> 'c' (visible)
    replica.doc.head = {
      key: `${siteId}:0`, isDeleted: false,
      next: {
        key: `${siteId}:1`, isDeleted: true,
        next: {
          key: `${siteId}:2`, isDeleted: false,
          next: null
        }
      }
    };

    expect(offsetMap.getVisibleOffsetForNodeId(idA)).toBe(0);
    expect(offsetMap.getVisibleOffsetForNodeId(idB)).toBe(1); // 'b' is deleted, so visual offset stays at 1
    expect(offsetMap.getVisibleOffsetForNodeId(idC)).toBe(1); // 'c' is the 2nd visible character (index 1)
  });
});