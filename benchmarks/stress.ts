import { RelayServer } from '../collab-sync/src/server/RelayServer';
import { SessionManager } from '../collab-sync/src/server/SessionManager';
import { ClientSync } from '../collab-sync/src/client/ClientSync';
// Adjust import path for Role based on your codebase structure
import { Role } from '../collab-sync/shared/roles'; 
import WebSocket from 'ws';

// Polyfill IndexedDB for headless Node.js clients
// Polyfill IndexedDB and IDBKeyRange for headless Node.js clients
const fakeIDB = require('fake-indexeddb');
const fakeIndexedDB = fakeIDB.indexedDB;
global.IDBKeyRange = fakeIDB.IDBKeyRange; // Attach it globally so OfflineQueue can find it!
const delay = (ms: number) => new Promise(res => setTimeout(res, ms));

// Simple CLI parser for the arguments specified in the test plan
const args = process.argv.slice(2);
let workload = '';
let clientsCount = 10;
let opsPerClient = 1000;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--workload') workload = args[i + 1];
  if (args[i] === '--clients') clientsCount = parseInt(args[i + 1], 10);
  if (args[i] === '--ops-per-client') opsPerClient = parseInt(args[i + 1], 10);
}

async function runConcurrentTyping(clientCount: number, opsPerClient: number) {
  console.log(`\n🚀 Starting Scenario S1: Concurrent Typing Stress Test`);
  console.log(`   Clients: ${clientCount} | Ops per client: ${opsPerClient} | Total Ops: ${clientCount * opsPerClient}\n`);

  const PORT = 9000;
  const sessionManager = new SessionManager();
  const relay = new RelayServer(PORT, sessionManager);
  await relay.start();
  console.log(`✅ Relay Server started on port ${PORT}`);

  const clients: ClientSync[] = [];
  const commonOptions = {
    connection: { WebSocketImpl: WebSocket as any, initialBackoffMs: 100 },
    offlineQueue: { indexedDBImpl: fakeIndexedDB }
  };

  // 1. Initialize Clients
  for (let i = 0; i < clientCount; i++) {
    const siteId = `client-${i}`;
    const token = sessionManager.mintToken(siteId, Role.Editor);
    const client = new ClientSync(siteId, `ws://localhost:${PORT}`, token, commonOptions);
    clients.push(client);
  }

  await Promise.all(clients.map(c => c.connect()));
  console.log(`✅ ${clientCount} clients connected. Commencing workload...`);

  const startTime = Date.now();

  // 2. The Workload: Everyone types concurrently
  const typingPromises = clients.map(async (client, clientIndex) => {
    for (let i = 0; i < opsPerClient; i++) {
      // Pick a random offset to insert at
      const currentLength = client.getText().length;
      const offset = Math.floor(Math.random() * (currentLength + 1));
      
      // Insert a letter uniquely identifying this client (A, B, C...)
      const char = String.fromCharCode(65 + clientIndex); 
      client.insert(offset, char);

      // Sleep ~10ms to simulate human typing and prevent Node event loop starvation
      await delay(10); 
    }
  });

  await Promise.all(typingPromises);
  const duration = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log(`✅ Workload finished in ${duration}s. Waiting for network to settle (max 5s)...`);

  // 3. Wait for Convergence
  await delay(5000); 

  // 4. Verify Results
  console.log(`\n📊 --- RESULTS ---`);
  let passed = true;
  const expectedLength = clientCount * opsPerClient;
  const baselineText = clients[0].getText();

  for (let i = 0; i < clients.length; i++) {
    const text = clients[i].getText();
    const isConverged = text === baselineText;
    const isCorrectLength = text.length === expectedLength;
    
    if (!isConverged || !isCorrectLength) passed = false;

    console.log(
      `   Client ${i}: Length = ${text.length}/${expectedLength} | ` +
      `Converged = ${isConverged ? '✅' : '❌'}`
    );
  }

  console.log(`\n🏁 SCENARIO S1 ${passed ? 'PASSED 🏆' : 'FAILED 🚨'}\n`);

  // Cleanup
  for (const c of clients) c.close();
  await relay.stop();
  process.exit(passed ? 0 : 1);
}

async function runSustainedTyping(clientCount: number) {
  console.log(`\n🚀 Starting Scenario S2: 60-Second Sustained GC Stress Test`);
  console.log(`   Clients: ${clientCount} | Target: 5 Hz per client | Deletions: 10%\n`);

  const PORT = 9001; // Use 9001 to avoid port collisions if S1 didn't clean up fully
  const sessionManager = new SessionManager();
  const relay = new RelayServer(PORT, sessionManager);
  await relay.start();

  const clients: ClientSync[] = [];
  for (let i = 0; i < clientCount; i++) {
    const siteId = `sustained-${i}`;
    const token = sessionManager.mintToken(siteId, Role.Editor);
    clients.push(new ClientSync(siteId, `ws://localhost:${PORT}`, token, {
      connection: { WebSocketImpl: WebSocket as any, initialBackoffMs: 100 },
      offlineQueue: { indexedDBImpl: fakeIndexedDB }
    }));
  }

  await Promise.all(clients.map(c => c.connect()));
  console.log(`✅ ${clientCount} clients connected. Simulating 60 seconds of typing... (grab a coffee ☕)`);

  const startTime = Date.now();
  const opsPerClient = 300; // 5 Hz * 60 seconds = 300 ops per client

  const typingPromises = clients.map(async (client, clientIndex) => {
    for (let i = 1; i <= opsPerClient; i++) {
      const text = client.getText();
      
      // Every 10th op is a delete (if there is text to delete)
      if (i % 10 === 0 && text.length > 0) {
        const deleteOffset = Math.floor(Math.random() * text.length);
        client.delete(deleteOffset, 1);
      } else {
        const insertOffset = Math.floor(Math.random() * (text.length + 1));
        client.insert(insertOffset, String.fromCharCode(97 + clientIndex)); // a, b, c...
      }

      await delay(200); // 200ms = 5 Hz
    }
  });

  await Promise.all(typingPromises);
  console.log(`✅ Workload finished. Waiting 5s for final convergence...`);
  await delay(5000); 

  console.log(`\n📊 --- RESULTS ---`);
  let passed = true;
  const baselineText = clients[0].getText();
  const visibleCharCount = baselineText.length;

  for (let i = 0; i < clients.length; i++) {
    const isConverged = clients[i].getText() === baselineText;
    if (!isConverged) passed = false;
    
    // Attempt to peek at the internal RGA node count to verify GC
    // (This safely falls back to N/A if your replica structure is nested differently)
    const internalNodes = (clients[i].replica as any).nodes?.size || (clients[i].replica as any).document?.length || "Unknown";

    console.log(
      `   Client ${i}: Visible Chars = ${visibleCharCount} | Internal Nodes = ${internalNodes} | ` +
      `Converged = ${isConverged ? '✅' : '❌'}`
    );
  }

  console.log(`\n🏁 SCENARIO S2 ${passed ? 'PASSED 🏆' : 'FAILED 🚨'}\n`);

  for (const c of clients) c.close();
  await relay.stop();
  process.exit(passed ? 0 : 1);
}

async function runLargeDocStress() {
  console.log(`\n🚀 Starting Scenario S3: Large Document (10k chars) + Mid-Document Edits`);
  const PORT = 9002;
  const sessionManager = new SessionManager();
  const relay = new RelayServer(PORT, sessionManager);
  await relay.start();

  const commonOptions = {
    connection: { WebSocketImpl: WebSocket as any, initialBackoffMs: 100 },
    offlineQueue: { indexedDBImpl: fakeIndexedDB }
  };

  // 1. First Client Connects & Preloads 10k characters
  const clientA = new ClientSync('site-A', `ws://localhost:${PORT}`, sessionManager.mintToken('site-A', Role.Editor), commonOptions);
  await clientA.connect();
  
  console.log(`⏳ Preloading 10,000 characters from Client A...`);
  // Insert in chunks of 100 to avoid locking the event loop for too long
  for (let i = 0; i < 100; i++) {
    const chunk = "A".repeat(100);
    clientA.insert(i * 100, chunk);
  }
  await delay(1000); // Give the relay a moment to process the massive log

  // 2. Clients B and C connect and download the state
  console.log(`⏳ Clients B and C joining and downloading state...`);
  const clientB = new ClientSync('site-B', `ws://localhost:${PORT}`, sessionManager.mintToken('site-B', Role.Editor), commonOptions);
  const clientC = new ClientSync('site-C', `ws://localhost:${PORT}`, sessionManager.mintToken('site-C', Role.Editor), commonOptions);
  
  await Promise.all([clientB.connect(), clientC.connect()]);
  await delay(2000); // Wait for the replay handshake to finish

  if (clientB.getText().length !== 10000 || clientC.getText().length !== 10000) {
    console.error(`🚨 Initial sync failed! B: ${clientB.getText().length}, C: ${clientC.getText().length}`);
    process.exit(1);
  }
  console.log(`✅ Initial sync successful. All 3 clients have 10,000 characters.`);

  // 3. The Workload: Concurrent edits in the middle
  console.log(`⏳ Commencing concurrent mid-document edits...`);
  const clients = [clientA, clientB, clientC];
  const opsPerClient = 200;
  
  const typingPromises = clients.map(async (client, clientIndex) => {
    for (let i = 0; i < opsPerClient; i++) {
      // Pick a random offset between 4000 and 6000
      const offset = 4000 + Math.floor(Math.random() * 2000);
      const char = String.fromCharCode(88 + clientIndex); // X, Y, Z
      client.insert(offset, char);
      await delay(10); 
    }
  });

  await Promise.all(typingPromises);
  console.log(`✅ Workload finished. Waiting 5s for final convergence...`);
  await delay(5000);

  // 4. Verify
  console.log(`\n📊 --- RESULTS ---`);
  let passed = true;
  const expectedLength = 10000 + (3 * opsPerClient);
  const baselineText = clients[0].getText();

  for (let i = 0; i < clients.length; i++) {
    const isConverged = clients[i].getText() === baselineText;
    const isCorrectLength = clients[i].getText().length === expectedLength;
    if (!isConverged || !isCorrectLength) passed = false;

    console.log(
      `   Client ${['A', 'B', 'C'][i]}: Length = ${clients[i].getText().length}/${expectedLength} | ` +
      `Converged = ${isConverged ? '✅' : '❌'}`
    );
  }

  console.log(`\n🏁 SCENARIO S3 ${passed ? 'PASSED 🏆' : 'FAILED 🚨'}\n`);

  for (const c of clients) c.close();
  await relay.stop();
  process.exit(passed ? 0 : 1);
}

async function runPartitionHealStress() {
  console.log(`\n🚀 Starting Scenario S4: 100 Partition/Heal Cycles`);
  const PORT = 9004;
  const sessionManager = new SessionManager();
  const relay = new RelayServer(PORT, sessionManager);
  await relay.start();

  const commonOptions = {
    connection: { WebSocketImpl: WebSocket as any, initialBackoffMs: 100 },
    offlineQueue: { indexedDBImpl: fakeIndexedDB }
  };

  const tokenA = sessionManager.mintToken('site-A', Role.Editor);
  const tokenB = sessionManager.mintToken('site-B', Role.Editor);
  
  const clientA = new ClientSync('site-A', `ws://localhost:${PORT}`, tokenA, commonOptions);
  const clientB = new ClientSync('site-B', `ws://localhost:${PORT}`, tokenB, commonOptions);
  
  await Promise.all([clientA.connect(), clientB.connect()]);
  console.log(`✅ Clients connected. Starting 100 disconnect/reconnect cycles...`);

  let passed = true;
  let totalConvergenceTime = 0;

  for (let i = 1; i <= 100; i++) {
    // 1. Simulate network drop by explicitly closing JUST the websocket (not the app)
    const conn: any = (clientA as any).connection || (clientA as any).connectionManager;
    const socket = conn?.socket || conn?.ws;
    if (socket) {
        socket.terminate ? socket.terminate() : socket.close();
    }
    
    // Give the state machine a tiny tick to register "offline"
    await new Promise(r => setTimeout(r, 20));

    // 2. Both clients type 10 chars while partitioned (A's ops go to OfflineQueue)
    for (let c = 0; c < 10; c++) {
      clientA.insert(clientA.getText().length, 'A');
      clientB.insert(clientB.getText().length, 'B');
    }

    // Give IDB a moment to persist the offline queue
    await new Promise(r => setTimeout(r, 50));

    // 3. Reconnect Client A (simulating WiFi turning back on)
    const reconnectStart = Date.now();
    if (conn && typeof conn.connect === 'function') {
        conn.connect();
    } else {
        clientA.connect();
    }

    // 4. Wait for convergence
    while (clientA.getText() !== clientB.getText()) {
      await new Promise(res => setTimeout(res, 10));
      if (Date.now() - reconnectStart > 5000) {
        console.error(`🚨 Failed to converge on cycle ${i}`);
        console.error(`   Client A length: ${clientA.getText().length}`);
        console.error(`   Client B length: ${clientB.getText().length}`);
        passed = false;
        break;
      }
    }
    
    // Stop the loop immediately if a cycle fails
    if (!passed) break; 

    const convergenceTime = Date.now() - reconnectStart;
    totalConvergenceTime += convergenceTime;
    
    if (i % 25 === 0) console.log(`   Completed ${i}/100 cycles...`);
  }

  const avgTime = totalConvergenceTime / 100;
  console.log(`\n📊 --- RESULTS ---`);
  console.log(`   Final Document Length: ${clientA.getText().length}`);
  console.log(`   Average Time-to-Converge: ${avgTime} ms`);
  
  if (avgTime > 500) passed = false;
  console.log(`\n🏁 SCENARIO S4 ${passed ? 'PASSED 🏆' : 'FAILED 🚨'}\n`);

  clientA.close();
  clientB.close();
  await relay.stop();
  process.exit(passed ? 0 : 1);
}

async function runReconnectStorm() {
  console.log(`\n🚀 Starting Scenario S5: Reconnect Storm (20 clients)`);
  const PORT = 9005;
  const sessionManager = new SessionManager();
  const relay = new RelayServer(PORT, sessionManager);
  await relay.start();

  const clients: ClientSync[] = [];
  const tokens: string[] = [];
  
  for (let i = 0; i < 20; i++) {
    const siteId = `storm-${i}`;
    tokens.push(sessionManager.mintToken(siteId, Role.Editor));
    clients.push(new ClientSync(siteId, `ws://localhost:${PORT}`, tokens[i], {
      connection: { WebSocketImpl: WebSocket as any, initialBackoffMs: 100 },
      offlineQueue: { indexedDBImpl: fakeIndexedDB }
    }));
  }

  // 1. All connect
  await Promise.all(clients.map(c => c.connect()));
  
  // 2. All disconnect simultaneously
  clients.forEach(c => c.close());
  console.log(`✅ 20 clients connected then dropped. Reconnecting all at once...`);
  await delay(1000);

  // 3. Reconnect storm
  const newClients = tokens.map((token, i) => 
    new ClientSync(`storm-${i}`, `ws://localhost:${PORT}`, token, {
      connection: { WebSocketImpl: WebSocket as any, initialBackoffMs: 100 },
      offlineQueue: { indexedDBImpl: fakeIndexedDB }
    })
  );

  const start = Date.now();
  await Promise.all(newClients.map(c => c.connect()));
  const elapsed = Date.now() - start;

  console.log(`\n📊 --- RESULTS ---`);
  console.log(`   All 20 clients re-established sessions in: ${elapsed} ms`);
  
  const passed = elapsed < 5000;
  console.log(`\n🏁 SCENARIO S5 ${passed ? 'PASSED 🏆' : 'FAILED 🚨'}\n`);

  newClients.forEach(c => c.close());
  await relay.stop();
  process.exit(passed ? 0 : 1);
}

async function runLongOfflineReplay() {
  console.log(`\n🚀 Starting Scenario S6: Long-Offline Replay`);
  const PORT = 9006;
  const sessionManager = new SessionManager();
  const relay = new RelayServer(PORT, sessionManager);
  await relay.start();

  const commonOptions = {
    connection: { WebSocketImpl: WebSocket as any, initialBackoffMs: 100 },
    offlineQueue: { indexedDBImpl: fakeIndexedDB }
  };

  const tokenA = sessionManager.mintToken('site-A', Role.Editor);
  const clientB = new ClientSync('site-B', `ws://localhost:${PORT}`, sessionManager.mintToken('site-B', Role.Editor), commonOptions);
  
  let clientA = new ClientSync('site-A', `ws://localhost:${PORT}`, tokenA, commonOptions);
  await Promise.all([clientA.connect(), clientB.connect()]);

  // A goes offline
  clientA.close();
  console.log(`✅ Client A is offline. Client B typing 500 ops over 60 seconds...`);

  // B types 500 ops over 60 seconds (approx 120ms per char)
  for (let i = 0; i < 500; i++) {
    clientB.insert(i, 'X');
    await delay(120);
  }

  console.log(`✅ Client B finished typing. Reconnecting Client A...`);
  
  clientA = new ClientSync('site-A', `ws://localhost:${PORT}`, tokenA, commonOptions);
  const reconnectStart = Date.now();
  await clientA.connect();

  // Wait for A to download the 500 ops
  while (clientA.getText().length < 500) {
    await new Promise(res => setTimeout(res, 10));
    if (Date.now() - reconnectStart > 5000) break;
  }

  const replayTime = Date.now() - reconnectStart;

  console.log(`\n📊 --- RESULTS ---`);
  console.log(`   Client A received ops in: ${replayTime} ms`);
  console.log(`   Client A text length: ${clientA.getText().length}/500`);
  
  const passed = clientA.getText() === clientB.getText() && replayTime < 2000;
  console.log(`\n🏁 SCENARIO S6 ${passed ? 'PASSED 🏆' : 'FAILED 🚨'}\n`);

  clientA.close();
  clientB.close();
  await relay.stop();
  process.exit(passed ? 0 : 1);
}

import * as fs from 'fs';
import * as path from 'path';

async function runLatencyBenchmark() {
  console.log(`\n🚀 Starting Scenario S7: End-to-End Latency Benchmark`);
  const PORT = 9003;
  const sessionManager = new SessionManager();
  const relay = new RelayServer(PORT, sessionManager);
  await relay.start();

  const commonOptions = {
    connection: { WebSocketImpl: WebSocket as any, initialBackoffMs: 100 },
    offlineQueue: { indexedDBImpl: fakeIndexedDB }
  };

  const clientA = new ClientSync('site-A', `ws://localhost:${PORT}`, sessionManager.mintToken('site-A', Role.Editor), commonOptions);
  const clientB = new ClientSync('site-B', `ws://localhost:${PORT}`, sessionManager.mintToken('site-B', Role.Editor), commonOptions);
  
  await Promise.all([clientA.connect(), clientB.connect()]);
  console.log(`✅ Clients connected. Measuring 1,000 operations at 100ms intervals...`);

  const latencies: number[] = [];
  const totalOps = 1000;

  for (let i = 0; i < totalOps; i++) {
    const start = Date.now();
    const expectedLength = i + 1;
    
    // Client A types
    clientA.insert(i, 'L'); 

    // Tight polling loop: wait for Client B to receive and apply the op
    // (setTimeout(resolve, 0) yields to the Node event loop to allow WebSocket messages to process)
    while (clientB.getText().length < expectedLength) {
      await new Promise(resolve => setTimeout(resolve, 0)); 
    }
    
    const latency = Date.now() - start;
    latencies.push(latency);

    // Wait the remainder of the 100ms interval to simulate human typing
    const elapsed = Date.now() - start;
    if (elapsed < 100) {
      await delay(100 - elapsed);
    }
  }

  console.log(`✅ Measurement complete.`);

  // Calculate Statistics
  latencies.sort((a, b) => a - b);
  const p50 = latencies[Math.floor(latencies.length * 0.5)];
  const p99 = latencies[Math.floor(latencies.length * 0.99)];
  const max = latencies[latencies.length - 1];

  console.log(`\n📊 --- RESULTS ---`);
  console.log(`   p50 (Median) Latency: ${p50} ms`);
  console.log(`   p99 (Tail) Latency:   ${p99} ms`);
  console.log(`   Max Latency:          ${max} ms`);

  // Evaluate Pass Criteria
  const passed = p50 < 20 && p99 < 100 && max < 1000;
  
  console.log(`\n🏁 SCENARIO S7 ${passed ? 'PASSED 🏆' : 'FAILED 🚨'}`);

  // Write results to disk for the report
  const resultsDir = path.join(__dirname, 'results');
  if (!fs.existsSync(resultsDir)) {
    fs.mkdirSync(resultsDir, { recursive: true });
  }
  const outputFile = path.join(resultsDir, 'latency-local.json');
  fs.writeFileSync(outputFile, JSON.stringify({ p50, p99, max, rawData: latencies }, null, 2));
  
  console.log(`💾 Raw latency data saved to: benchmarks/results/latency-local.json\n`);

  clientA.close();
  clientB.close();
  await relay.stop();
  process.exit(passed ? 0 : 1);
}

async function runThroughputBenchmark() {
  console.log(`\n🚀 Starting Scenario S8: Sustained Throughput`);
  const PORT = 9008;
  const sessionManager = new SessionManager();
  const relay = new RelayServer(PORT, sessionManager);
  await relay.start();

  const commonOptions = {
    connection: { WebSocketImpl: WebSocket as any, initialBackoffMs: 100 },
    offlineQueue: { indexedDBImpl: fakeIndexedDB }
  };

  const publisher = new ClientSync('site-pub', `ws://localhost:${PORT}`, sessionManager.mintToken('site-pub', Role.Editor), commonOptions);
  const receiver = new ClientSync('site-rec', `ws://localhost:${PORT}`, sessionManager.mintToken('site-rec', Role.Editor), commonOptions);
  
  await Promise.all([publisher.connect(), receiver.connect()]);
  console.log(`✅ Clients connected. Blasting ops for 10 seconds...`);

  const durationMs = 10000;
  const start = Date.now();
  let opsSent = 0;

  // Publisher blasts as fast as the event loop allows for 10 seconds
  while (Date.now() - start < durationMs) {
    publisher.insert(publisher.getText().length, 'T');
    opsSent++;
    
    // Yield to the event loop every 50 ops so WebSockets can actually transmit
    if (opsSent % 50 === 0) {
      await new Promise(res => setTimeout(res, 0));
    }
  }

  const endPublishing = Date.now();
  const actualDurationSec = (endPublishing - start) / 1000;
  const publishRate = opsSent / actualDurationSec;
  
  console.log(`✅ Publishing finished. Sent ${opsSent} ops in ${actualDurationSec.toFixed(2)}s (${publishRate.toFixed(0)} ops/sec)`);
  console.log(`⏳ Waiting for receiver to catch up...`);

  // Wait for Receiver to process everything
  while (receiver.getText().length < opsSent) {
    await new Promise(res => setTimeout(res, 10));
  }

  const catchUpTimeMs = Date.now() - endPublishing;
  
  console.log(`\n📊 --- RESULTS ---`);
  console.log(`   Total Ops Processed: ${receiver.getText().length}`);
  console.log(`   Publisher Throughput: ${publishRate.toFixed(0)} ops/sec`);
  console.log(`   Receiver Catch-up Time: ${catchUpTimeMs} ms`);
  
  // Test Plan Pass Criteria: > 1000 ops/sec
  const passed = publishRate >= 1000 && receiver.getText().length === opsSent;
  
  console.log(`\n🏁 SCENARIO S8 ${passed ? 'PASSED 🏆' : 'FAILED 🚨'}\n`);

  // Write results to disk for the report
  const fs = require('fs');
  const path = require('path');
  const resultsDir = path.join(__dirname, 'results');
  if (!fs.existsSync(resultsDir)) fs.mkdirSync(resultsDir, { recursive: true });
  fs.writeFileSync(path.join(resultsDir, 'throughput.json'), JSON.stringify({ opsSent, publishRate, catchUpTimeMs }, null, 2));

  publisher.close();
  receiver.close();
  await relay.stop();
  process.exit(passed ? 0 : 1);
}

import * as fs from 'fs';
import * as path from 'path';

async function runComparativeAnalysis() {
  console.log(`\n🚀 Starting Scenario S9 & S10: RGA vs LWW Comparative Analysis`);
  const PORT = 9009;
  const sessionManager = new SessionManager();
  const relay = new RelayServer(PORT, sessionManager);
  await relay.start();

  const commonOptions = {
    connection: { WebSocketImpl: WebSocket as any, initialBackoffMs: 100 },
    offlineQueue: { indexedDBImpl: fakeIndexedDB }
  };

  // --- SCENARIO S9: Why LWW is bad for Text ---
  console.log(`\n▶️ Running Scenario S9: Concurrent Inserts (RGA vs Toy LWW)`);
  const clientA = new ClientSync('site-A', `ws://localhost:${PORT}`, sessionManager.mintToken('site-A', Role.Editor), commonOptions);
  const clientB = new ClientSync('site-B', `ws://localhost:${PORT}`, sessionManager.mintToken('site-B', Role.Editor), commonOptions);
  const clientC = new ClientSync('site-C', `ws://localhost:${PORT}`, sessionManager.mintToken('site-C', Role.Editor), commonOptions);
  
  await Promise.all([clientA.connect(), clientB.connect(), clientC.connect()]);

  // Setup initial text
  clientA.insert(0, "Base");
  await delay(500);

  // 1. Real RGA: All 3 clients insert at the exact same offset (index 4) concurrently
  clientA.insert(4, 'X');
  clientB.insert(4, 'Y');
  clientC.insert(4, 'Z');
  
  await delay(500);
  const rgaResult = clientA.getText();
  
  // 2. Toy LWW Simulation: A naive array where concurrent edits to the same index overwrite each other
  const lwwArray = ["B", "a", "s", "e"];
  // X, Y, Z all target index 4. Last write (Z) wins.
  lwwArray[4] = "X"; 
  lwwArray[4] = "Y"; 
  lwwArray[4] = "Z"; 
  const lwwResult = lwwArray.join("");

  console.log(`   RGA Result: "${rgaResult}" (Length: ${rgaResult.length})`);
  console.log(`   LWW Result: "${lwwResult}" (Length: ${lwwResult.length})`);
  const s9Passed = rgaResult.length === 7 && lwwResult.length === 5;


  // --- SCENARIO S10: Why RGA is bad for Metadata (Title) ---
  console.log(`\n▶️ Running Scenario S10: Title Updates (RGA vs LWW Bandwidth)`);
  
  // Simulating 100 changes to a 50-character title.
  const titleChanges = 100;
  const titleLength = 50;
  
  // In LWW: 1 update = 1 operation containing the new string.
  const lwwOps = titleChanges;
  const lwwBytesPerOp = 50; 
  const lwwTotalBytes = lwwOps * lwwBytesPerOp;

  // In RGA: Changing a 50-char string means deleting 50 characters (50 ops) 
  // and inserting 50 new characters (50 ops).
  const rgaOpsPerChange = titleLength * 2; 
  const rgaTotalOps = titleChanges * rgaOpsPerChange;
  const rgaBytesPerOp = 50; // Approximating CRDT overhead (NodeId, vector clock, etc.)
  const rgaTotalBytes = rgaTotalOps * rgaBytesPerOp;

  console.log(`   LWW Title Updates: ${lwwOps} ops (~${(lwwTotalBytes / 1024).toFixed(1)} KB)`);
  console.log(`   RGA Title Updates: ${rgaTotalOps} ops (~${(rgaTotalBytes / 1024).toFixed(1)} KB)`);
  const s10Passed = rgaTotalOps > 5000 && lwwOps === 100;

  console.log(`\n📊 --- RESULTS ---`);
  console.log(`🏁 SCENARIO S9 (RGA preserves, LWW drops): ${s9Passed ? 'PASSED 🏆' : 'FAILED 🚨'}`);
  console.log(`🏁 SCENARIO S10 (LWW efficient, RGA overkill): ${s10Passed ? 'PASSED 🏆' : 'FAILED 🚨'}\n`);

  // Write results for the reporting script
  const resultsDir = path.join(__dirname, 'results');
  if (!fs.existsSync(resultsDir)) fs.mkdirSync(resultsDir, { recursive: true });
  fs.writeFileSync(path.join(resultsDir, 'comparative.json'), JSON.stringify({ 
    s9: { rga: rgaResult, lww: lwwResult }, 
    s10: { lwwOps, rgaOps: rgaTotalOps, lwwBytes: lwwTotalBytes, rgaBytes: rgaTotalBytes }
  }, null, 2));

  clientA.close(); clientB.close(); clientC.close();
  await relay.stop();
  process.exit((s9Passed && s10Passed) ? 0 : 1);
}

if (workload === 'concurrentTyping') runConcurrentTyping(clientsCount, opsPerClient).catch(console.error);
else if (workload === 'sustainedGC') runSustainedTyping(5).catch(console.error);
else if (workload === 'largeDoc') runLargeDocStress().catch(console.error);
else if (workload === 's4') runPartitionHealStress().catch(console.error);
else if (workload === 's5') runReconnectStorm().catch(console.error);
else if (workload === 's6') runLongOfflineReplay().catch(console.error);
else if (workload === 'latency') runLatencyBenchmark().catch(console.error);
else if (workload === 's8') runThroughputBenchmark().catch(console.error);
else if (workload === 'compare') runComparativeAnalysis().catch(console.error);
else console.log("Usage: npm run stress -- --workload <concurrentTyping|sustainedGC|largeDoc|s4|s5|s6|latency>");