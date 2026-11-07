import { CausalBuffer } from '../../src/clocks/CausalBuffer';
import { VectorClock } from '../../src/clocks/VectorClock';
import { RGAOperation } from '../../src/types';

describe('CausalBuffer', () => {
  let clock: VectorClock;
  let buffer: CausalBuffer;
  const SITE_A = 'site-A';
  const SITE_B = 'site-B';

  beforeEach(() => {
    clock = new VectorClock();
    buffer = new CausalBuffer(clock);
  });

  // Helper function to mock an insert operation
  const mockInsert = (siteId: string, counter: number, depClock: Record<string, number>): RGAOperation => ({
    type: 'insert',
    nodeId: { siteId, counter },
    afterId: null,
    value: 'x',
    clock: depClock
  });

  test('should immediately drain an operation with no unmet dependencies', () => {
    const op = mockInsert(SITE_A, 1, {}); // Depends on nothing
    buffer.receive(op);

    const drained = buffer.drain();
    expect(drained.length).toBe(1);
    expect(drained[0]).toBe(op);
    expect(buffer.pendingCount()).toBe(0);
    
    // Clock should be automatically updated to reflect we processed A:1
    expect(clock.snapshot()).toEqual({ [SITE_A]: 1 });
  });

  test('should hold an operation if dependencies are not met', () => {
    // Op requires A:1 to exist, but our clock is empty
    const op = mockInsert(SITE_B, 1, { [SITE_A]: 1 }); 
    buffer.receive(op);

    const drained = buffer.drain();
    expect(drained.length).toBe(0);
    expect(buffer.pendingCount()).toBe(1);
  });

  test('should perform a cascading release when a missing dependency arrives', () => {
    // We receive operations out of order: Edit 3, then 2, then 1.
    const edit3 = mockInsert(SITE_A, 3, { [SITE_A]: 2 });
    const edit2 = mockInsert(SITE_A, 2, { [SITE_A]: 1 });
    const edit1 = mockInsert(SITE_A, 1, {});

    // Receive 3 and 2. Neither can be applied yet.
    buffer.receive(edit3);
    buffer.receive(edit2);
    expect(buffer.drain().length).toBe(0);
    expect(buffer.pendingCount()).toBe(2);

    // Receive 1. This should trigger a cascade releasing 1, then 2, then 3.
    buffer.receive(edit1);
    const drained = buffer.drain();
    
    expect(drained.length).toBe(3);
    expect(drained[0]).toBe(edit1);
    expect(drained[1]).toBe(edit2);
    expect(drained[2]).toBe(edit3);
    expect(buffer.pendingCount()).toBe(0);
    expect(clock.snapshot()).toEqual({ [SITE_A]: 3 });
  });
});