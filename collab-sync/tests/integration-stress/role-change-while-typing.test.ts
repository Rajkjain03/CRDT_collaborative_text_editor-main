import { RelayServer } from '../../src/server/RelayServer';
import { SessionManager } from '../../src/server/SessionManager';
import { ClientSync } from '../../src/client/ClientSync';
import { Role } from '../../shared/roles';
import WebSocket from 'ws';

const fakeIndexedDB = require('fake-indexeddb').indexedDB;
const delay = (ms: number) => new Promise(res => setTimeout(res, ms));

describe('Cross-Phase: Role Change While Typing', () => {
  let relay: RelayServer;
  let sessionManager: SessionManager;
  let clientA: ClientSync; // Owner
  let clientB: ClientSync; // Bob
  const PORT = 8087; // Different port to ensure a clean run

  beforeAll(async () => {
    sessionManager = new SessionManager();
    const { ownerSiteId, ownerToken } = sessionManager.initSession();

    relay = new RelayServer(PORT, sessionManager);
    await relay.start();

    const commonOptions = {
      connection: { WebSocketImpl: WebSocket as any, initialBackoffMs: 100 },
      offlineQueue: { indexedDBImpl: fakeIndexedDB }
    };

    clientA = new ClientSync(ownerSiteId, `ws://localhost:${PORT}`, ownerToken, commonOptions);
    
    // Mint Bob an Editor token to start
    const tokenB = sessionManager.mintToken('site-B', Role.Editor);
    clientB = new ClientSync('site-B', `ws://localhost:${PORT}`, tokenB, commonOptions);
  });

  afterAll(async () => {
    if (clientA) clientA.close();
    if (clientB) clientB.close();
    if (relay) await relay.stop();
  });

  it('should process in-flight ops but reject ops after role demotion', async () => {
    await Promise.all([clientA.connect(), clientB.connect()]);
    await delay(100);

    // 1. Bob is an Editor. He types "A". This is his "in-flight" operation.
    clientB.insert(0, 'A');
    
    // Wait for the server to process it
    await delay(100);
    
    // Assert the Owner received the 'A'
    expect(clientA.getText()).toBe('A'); 

    // 2. DEMOTION: The Owner changes Bob's role to Viewer
    // (In a real app this is a WS message, but we can update the registry directly for the test)
    sessionManager.registerSite('site-B', Role.Viewer);

    // 3. Bob attempts to type "B" while his UI hasn't caught up to the demotion yet
    clientB.insert(1, 'B');
    
    // Wait to give the server time to process (or reject) it
    await delay(100);
    
    // 4. Assert the Owner did NOT receive the 'B'. 
    // The server should have dropped the operation because Bob is now a Viewer!
    expect(clientA.getText()).toBe('A'); 
  });
});