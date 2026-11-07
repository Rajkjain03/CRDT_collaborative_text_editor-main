import { LWWRegister } from '../../src/lww/LWWRegister';

describe('LWWRegister', () => {
  let register: LWWRegister<string>;
  const SITE_A = "site-A";
  const SITE_B = "site-B"; // "site-B" > "site-A" lexicographically

  beforeEach(() => {
    register = new LWWRegister<string>();
  });

  test('should set and get a local value', () => {
    const update = register.set('title', 'Untitled', 1000, SITE_A);
    
    expect(register.get('title')).toBe('Untitled');
    expect(update).toEqual({
      type: "lww_update",
      field: 'title',
      value: 'Untitled',
      timestamp: 1000,
      siteId: SITE_A
    });
  });

  test('should accept a remote state with a newer timestamp', () => {
    register.set('title', 'Old Title', 1000, SITE_A);

    const remoteState = {
      'title': { value: 'New Title', timestamp: 2000, siteId: SITE_B }
    };

    const changes = register.merge(remoteState);

    expect(register.get('title')).toBe('New Title');
    expect(changes.length).toBe(1);
    expect(changes[0].value).toBe('New Title');
  });

  test('should reject a remote state with an older timestamp', () => {
    register.set('title', 'Current Title', 2000, SITE_A);

    const remoteState = {
      'title': { value: 'Stale Title', timestamp: 1000, siteId: SITE_B }
    };

    const changes = register.merge(remoteState);

    expect(register.get('title')).toBe('Current Title');
    expect(changes.length).toBe(0); // No changes should be emitted
  });

  test('TIE-BREAKER: should prefer the lexicographically greater siteId', () => {
    const time = 1500;
    
    // Site A sets the title
    register.set('title', 'Title A', time, SITE_A);

    // Site B sets the title at the EXACT same time
    const remoteStateB = {
      'title': { value: 'Title B', timestamp: time, siteId: SITE_B }
    };

    // Since "site-B" > "site-A", Site B's state should overwrite Site A's
    register.merge(remoteStateB);
    expect(register.get('title')).toBe('Title B');
  });

  test('TIE-BREAKER: should resist overwrites from lower siteIds at the same timestamp', () => {
    const time = 1500;
    
    // We initialize with Site B's data this time
    register.set('title', 'Title B', time, SITE_B);

    // Attempt to merge Site A's data from the exact same time
    const remoteStateA = {
      'title': { value: 'Title A', timestamp: time, siteId: SITE_A }
    };

    // Since "site-B" > "site-A", Site B's data should remain untouched
    register.merge(remoteStateA);
    expect(register.get('title')).toBe('Title B');
  });

  test('COMMUTATIVITY: merge order should not affect the final state', () => {
    const node1 = new LWWRegister<string>();
    const node2 = new LWWRegister<string>();

    const stateA = { 'title': { value: 'Alice', timestamp: 1000, siteId: 'site-A' } };
    const stateB = { 'title': { value: 'Bob', timestamp: 2000, siteId: 'site-B' } };
    const stateC = { 'title': { value: 'Charlie', timestamp: 1500, siteId: 'site-C' } };

    // Node 1 receives A, then B, then C
    node1.merge(stateA);
    node1.merge(stateB);
    node1.merge(stateC);

    // Node 2 receives C, then A, then B
    node2.merge(stateC);
    node2.merge(stateA);
    node2.merge(stateB);

    // Both should naturally converge on Bob (timestamp 2000)
    expect(node1.snapshot()).toEqual(node2.snapshot());
    expect(node1.get('title')).toBe('Bob');
  });
});