import { RelayServer } from '../../src/server/RelayServer';
import { SessionManager } from '../../src/server/SessionManager';
import { ClientSync } from '../../src/client/ClientSync';
import { Role } from '../../shared/roles';
import WebSocket from 'ws';

// Require the fake-indexeddb implementation for Node.js
const fakeIndexedDB = require('fake-indexeddb').indexedDB;

// Helper to wait a few milliseconds for async network ops to settle
const delay = (ms: number) => new Promise(res => setTimeout(res, ms));

describe('Cross-Phase: Replay with Causal Buffer', () => {
  let relay: RelayServer;
  let sessionManager: SessionManager;
  let clientA: ClientSync;
  let clientB: ClientSync;
  let clientC: ClientSync;
  const PORT = 8085; // Use a dedicated test port

  beforeAll(async () => {
    sessionManager = new SessionManager();
    const { ownerSiteId, ownerToken } = sessionManager.initSession();
    relay = new RelayServer(PORT, sessionManager);
    await relay.start();

    // Define the options with both the WebSocket and IndexedDB polyfills
    const commonOptions = {
      connection: { WebSocketImpl: WebSocket as any, initialBackoffMs: 100 },
      offlineQueue: { indexedDBImpl: fakeIndexedDB }
    };

    // Setup A (Owner)
    clientA = new ClientSync(ownerSiteId, `ws://localhost:${PORT}`, ownerToken, commonOptions);

    // Setup B (Editor)
    const tokenB = sessionManager.mintToken('site-B', Role.Editor);
    clientB = new ClientSync('site-B', `ws://localhost:${PORT}`, tokenB, commonOptions);

    // Setup C (Editor)
    const tokenC = sessionManager.mintToken('site-C', Role.Editor);
    clientC = new ClientSync('site-C', `ws://localhost:${PORT}`, tokenC, commonOptions);
  });

  afterAll(async () => {
    // Added safety checks in case instantiation fails again
    if (clientA) clientA.close();
    if (clientB) clientB.close();
    if (clientC) clientC.close();
    await relay.stop();
  });

  it('should converge when a client drops, others type concurrently, and it reconnects', async () => {
    // 1. All three connect
    await Promise.all([clientA.connect(), clientB.connect(), clientC.connect()]);
    await delay(100);

    // 2. Initial state established
    clientA.insert(0, 'A');
    await delay(100);
    expect(clientC.getText()).toBe('A');

    // 3. Client C disconnects
    clientC.disconnect();
    await delay(50);

    // 4. A and B type concurrently while C is offline
    clientA.insert(1, 'A');
    clientB.insert(1, 'B'); // Concurrent insert at same offset
    
    await delay(100);
    const convergedText = clientA.getText();
    expect(clientB.getText()).toBe(convergedText); // A and B should agree

    // C should still have the old text
    expect(clientC.getText()).toBe('A');

    // 5. C reconnects and receives the replay barrage
    await clientC.connect();
    await delay(200);

    // 6. Assert C converges perfectly with A and B via the Causal Buffer
    expect(clientC.getText()).toBe(convergedText);
  });
});