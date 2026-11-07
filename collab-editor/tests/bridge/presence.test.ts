import { describe, it, expect, vi } from 'vitest';
import { broadcastPresence } from '../../src/bridge/presence';
import { OffsetMap } from '../../src/bridge/offsetMap';
import { ClientSync } from 'collab-sync';

describe('Presence Bridge', () => {
  it('should broadcast presence metadata', () => {
    const idH = { siteId: 'site-1', counter: 0 };
    
    // Create a dummy replica and spy on the offset map
    const replica = { rga: {} } as any; 
    const offsetMap = new OffsetMap(replica);
    
    // Mock the offset map translation so we don't need real RGA insertions
    vi.spyOn(offsetMap, 'getPredecessorIdForVisibleOffset').mockReturnValue(idH);

    const client = {
      siteId: 'site-1',
      setMeta: vi.fn(),
    } as unknown as ClientSync;

    broadcastPresence(client, offsetMap, 1, 1);

    expect(client.setMeta).toHaveBeenCalledTimes(1);
    expect(client.setMeta).toHaveBeenCalledWith('cursor:site-1', {
      anchor: { nodeId: idH, offsetWithinNode: 1 },
      head: { nodeId: idH, offsetWithinNode: 1 }
    });
  });
});