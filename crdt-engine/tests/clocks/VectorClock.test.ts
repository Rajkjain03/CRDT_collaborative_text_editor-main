import { VectorClock } from '../../src/clocks/VectorClock';

describe('VectorClock', () => {
  const SITE_A = 'site-A';
  const SITE_B = 'site-B';
  const SITE_C = 'site-C';

  test('should initialize empty or with a snapshot', () => {
    const emptyClock = new VectorClock();
    expect(emptyClock.snapshot()).toEqual({});

    const seededClock = new VectorClock({ [SITE_A]: 5, [SITE_B]: 2 });
    expect(seededClock.snapshot()).toEqual({ [SITE_A]: 5, [SITE_B]: 2 });
  });

  test('should increment only the specified site', () => {
    const clock = new VectorClock();
    clock.increment(SITE_A);
    clock.increment(SITE_A);
    clock.increment(SITE_B);

    expect(clock.snapshot()).toEqual({ [SITE_A]: 2, [SITE_B]: 1 });
  });

  test('update() should take the pointwise maximum WITHOUT adding +1', () => {
    const localClock = new VectorClock({ [SITE_A]: 2, [SITE_B]: 1 });
    const remoteClock = { [SITE_A]: 1, [SITE_B]: 3, [SITE_C]: 1 };

    localClock.update(remoteClock);

    // Site A stays 2 (local was higher)
    // Site B becomes 3 (remote was higher)
    // Site C becomes 1 (remote had it, local didn't)
    expect(localClock.snapshot()).toEqual({ [SITE_A]: 2, [SITE_B]: 3, [SITE_C]: 1 });
  });

  test('happensBefore() should correctly identify causal history', () => {
    const clock1 = new VectorClock({ [SITE_A]: 1, [SITE_B]: 1 });
    
    // clock2 has seen everything clock1 has, plus one more edit from B
    const clock2 = { [SITE_A]: 1, [SITE_B]: 2 };
    
    // clock3 is missing an edit from A that clock1 has
    const clock3 = { [SITE_A]: 0, [SITE_B]: 5 };

    expect(clock1.happensBefore(clock2)).toBe(true); // clock1 happened before clock2
    expect(clock1.happensBefore(clock1.snapshot())).toBe(false); // identical clocks don't happen before each other
    expect(clock1.happensBefore(clock3)).toBe(false); // clock3 is missing A:1, so clock1 didn't happen before it
  });

  test('isConcurrent() should identify diverging histories', () => {
    // Alice typed 1 character
    const aliceClock = new VectorClock({ [SITE_A]: 1, [SITE_B]: 0 });
    
    // Bob typed 1 character at the exact same time without seeing Alice's edit
    const bobClock = { [SITE_A]: 0, [SITE_B]: 1 };

    expect(aliceClock.isConcurrent(bobClock)).toBe(true);
  });

  test('hasDelivered() should act as a strict gatekeeper for the Causal Buffer', () => {
    const localClock = new VectorClock({ [SITE_A]: 5, [SITE_B]: 2 });

    // Dependency requires A to be at least 4 and B to be at least 2
    const readyDep = { [SITE_A]: 4, [SITE_B]: 2 };
    expect(localClock.hasDelivered(readyDep)).toBe(true);

    // Dependency requires an edit from B (B:3) that we haven't seen yet
    const futureDep = { [SITE_A]: 5, [SITE_B]: 3 };
    expect(localClock.hasDelivered(futureDep)).toBe(false);

    // Dependency requires an edit from a completely unknown site C
    const unknownSiteDep = { [SITE_A]: 5, [SITE_C]: 1 };
    expect(localClock.hasDelivered(unknownSiteDep)).toBe(false);
  });
});