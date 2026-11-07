import { describe, it, expect, vi } from 'vitest';
import { CollabBridge } from '../../src/bridge/CollabBridge';
import { ClientSync } from 'collab-sync';

describe('CollabBridge', () => {
  it('should create and attach the bridge', () => {
    // Mock a client that has a dummy replica inside it
    const client = {
      siteId: 'site-1',
      replica: { rga: {} },
      insert: vi.fn(),
      delete: vi.fn(),
      onOpsApplied: vi.fn()
    } as unknown as ClientSync;

    // CollabBridge only takes client as a parameter
    const bridge = new CollabBridge(client);
    expect(bridge).toBeDefined();
  });
});