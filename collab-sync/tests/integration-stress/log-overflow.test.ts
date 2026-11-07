import { RelayServer } from '../../src/server/RelayServer';
import { SessionManager } from '../../src/server/SessionManager';
import { ClientSync } from '../../src/client/ClientSync';
import { Role } from '../../shared/roles';
import WebSocket from 'ws';

const fakeIndexedDB = require('fake-indexeddb').indexedDB;
const delay = (ms: number) => new Promise(res => setTimeout(res, ms));

describe('Cross-Phase: Log Overflow', () => {
  let relay: RelayServer;
  let sessionManager: SessionManager;
  let clientA: ClientSync;
  let clientB: ClientSync;
  const PORT = 8086; 

  beforeAll(async () => {
    sessionManager = new SessionManager();
    
    // 1. Correctly destructure what initSession ACTUALLY returns based on your file
    const { ownerSiteId, ownerToken } = sessionManager.initSession();
    
    relay = new RelayServer(PORT, sessionManager);
    
    // 2. Inject the limit directly onto the RelayServer, since that is where `appendToLog` lives
    (relay as any).maxLogSize = 10;

    await relay.start();

    const commonOptions = {
      connection: { WebSocketImpl: WebSocket as any, initialBackoffMs: 100 },
      offlineQueue: { indexedDBImpl: fakeIndexedDB }
    };

    clientA = new ClientSync(ownerSiteId, `ws://localhost:${PORT}`, ownerToken, commonOptions);
    const tokenB = sessionManager.mintToken('site-B', Role.Editor);
    clientB = new ClientSync('site-B', `ws://localhost:${PORT}`, tokenB, commonOptions);
  });

  afterAll(async () => {
    if (clientA) clientA.close();
    if (clientB) clientB.close();
    if (relay) await relay.stop();
  });

  it('should not crash when receiving a partial log (exceeding MAX_LOG_SIZE)', async () => {
    await clientA.connect();
    await delay(100);

    for (let i = 0; i < 30; i++) {
      clientA.insert(i, String.fromCharCode(65 + (i % 26))); 
    }
    
    await delay(300);
    expect(clientA.getText().length).toBe(30); // A should have all 30

    await clientB.connect();
    await delay(200);

    const textB = clientB.getText();
    
    // The SERVER should have dropped the old ops. B should receive < 30.
    expect(textB.length).toBeLessThan(30);
  });
});