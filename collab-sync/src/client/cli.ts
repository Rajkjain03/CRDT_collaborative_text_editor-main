/**
 * cli.ts — Interactive client REPL for the Phase 2 collab-sync prototype.
 *
 * Start the relay first:
 *   PORT=8787 npm run server
 *
 * Then connect clients (in separate terminals):
 *   npm run client -- --site <owner-site-id> --token <owner-token> --db-dir /tmp/collab-owner
 *   npm run client -- --site bob --token <editor-token> --db-dir /tmp/collab-bob
 *
 * --db-dir is required when running multiple clients on the same machine.
 * Each client needs its own LevelDB directory for node-indexeddb.
 *
 * After the REPL loads, type `help` to see all commands.
 * Type `connect` to join the relay session.
 */
import * as readline from "readline";
import * as fs from "fs";
import * as path from "path";
import WebSocket from "ws";
import { ClientSync } from "./ClientSync";
import type { WebSocketConstructor } from "./ConnectionManager";
import { Role } from "../../shared/roles";
import dotenv from "dotenv";
dotenv.config();
// ── ANSI ──────────────────────────────────────────────────────────────────────

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;

// ── Arg parsing ───────────────────────────────────────────────────────────────

function parseArgs(argv: string[]) {
  const get = (flag: string, def?: string) => {
    const i = argv.indexOf(`--${flag}`);
    return i !== -1 ? argv[i + 1] : def;
  };
  const site = get("site");
  const token = get("token");
  const PORT = process.env.PORT || 8787
  const url = get("url", `ws://localhost:${PORT}`);
  const dbDir = get("db-dir");
  if (!site || !token) {
    console.error(red("usage: client --site <id> --token <token> [--url <ws-url>]"));
    process.exit(2);
  }
  return { site, token, url: url!, dbDir };
}

// ── State ─────────────────────────────────────────────────────────────────────

const cfg = parseArgs(process.argv.slice(2));
let client: ClientSync;
/** siteId → role string for every peer currently connected to the relay. */
const knownPeers = new Map<string, string>();
/** Tokens minted during this session (owner only). */
const mintedTokens: Array<{ siteId: string; role: string; token: string }> = [];

// ── Display ───────────────────────────────────────────────────────────────────

function renderState(label?: string) {
  const bar = dim("─".repeat(60));
  console.log(`\n${bar}`);
  if (label) console.log(`  ${bold(label)}`);

  const state = client.getConnectionState();
  const stateTag =
    state === "connected"
      ? green(`[${state}]`)
      : state === "connecting" || state === "reconnecting"
        ? yellow(`[${state}]`)
        : red(`[${state}]`);

  const role = client.getRole();
  const roleTag = role ? cyan(role) : dim("(no role)");

  const text = client.getText();
  const docStr = text.length === 0 ? dim("(empty)") : `"${cyan(text)}"`;

  const clockStr = Object.entries(client.replica.getClockSnapshot())
    .map(([s, n]) => `${s}:${n}`)
    .join(" ");

  console.log(
    `  ${bold(cfg.site)} ${stateTag} role=${roleTag}  ${docStr}  len=${text.length}`
  );
  console.log(dim(`  clock{${clockStr}}`));

  if (knownPeers.size > 0) {
    const peerList = [...knownPeers.entries()].map(([id, r]) => `${id}(${r})`).join(", ");
    console.log(dim(`  peers: ${peerList}`));
  }

  console.log(bar);
}

// ── Help ──────────────────────────────────────────────────────────────────────

function printHelp() {
  console.log(`
${bold("═══ Phase 2 Client REPL — Commands ═══")}

${bold("Document editing")}
  ${bold("ins <offset> <text>")}     Insert text at offset
                            ${dim("e.g.  ins 0 hello")}
  ${bold("del <offset>")}            Delete character at offset

${bold("Connection")}
  ${bold("connect")}                 Open WebSocket and join session
  ${bold("disconnect")}              Close WebSocket cleanly
  ${bold("offline")}                 Disconnect to simulate network drop
                            ${dim("ops typed after this go to OfflineQueue")}
  ${bold("online")}                  Reconnect (alias for connect)

${bold("LWW metadata")}
  ${bold("meta <field> <value>")}    Set a metadata field

${bold("View")}
  ${bold("state")}                   Print current state (doc, clock, peers)
  ${bold("queue")}                   Print offline queue size
  ${bold("peers")}                   List all currently connected peers
  ${bold("tokens")}                  List tokens minted this session (owner only)
  ${bold("reset")}                   Reset session: clear relay log + all clients' local state
                            ${dim("Owner only — use between demo scenarios")}
  ${bold("help")}                    Show this help

${bold("Access control (Owner only)")}
  ${bold("mint <siteId> <role>")}    Mint a join token for a new site
                            ${dim("role: owner | editor | viewer")}
                            ${dim("e.g.  mint bob editor")}

${bold("Session")}
  ${bold("quit")} / ${bold("exit")}             Stop the REPL
`);
}

// ── Commands ──────────────────────────────────────────────────────────────────

async function cmdInsert(parts: string[]) {
  if (parts.length < 3) { console.log(red("  usage: ins <offset> <text>")); return; }
  const offset = parseInt(parts[1]!);
  const text = parts.slice(2).join(" ");
  if (isNaN(offset)) { console.log(red("  offset must be a number")); return; }
  for (let i = 0; i < text.length; i++) client.insert(offset + i, text[i]!);
  console.log(green(`  inserted "${text}" at offset ${offset}`));
  renderState();
}

function cmdDelete(parts: string[]) {
  if (parts.length < 2) { console.log(red("  usage: del <offset>")); return; }
  const offset = parseInt(parts[1]!);
  if (isNaN(offset)) { console.log(red("  offset must be a number")); return; }
  const result = client.delete(offset);
  if (result === null) {
    console.log(yellow(`  nothing at offset ${offset}`));
  } else {
    console.log(green(`  deleted char at offset ${offset}`));
  }
  renderState();
}

async function cmdConnect() {
  console.log(dim(`  connecting to ${cfg.url}...`));
  try {
    await client.connect();
    console.log(green(`  connected as ${client.getRole()}`));
    renderState("after: connect");
  } catch (err) {
    console.log(red(`  connect failed: ${(err as Error).message}`));
  }
}

function cmdDisconnect() {
  client.disconnect();
  console.log(yellow("  disconnected"));
  renderState("after: disconnect");
}

function cmdMeta(parts: string[]) {
  if (parts.length < 3) { console.log(red("  usage: meta <field> <value>")); return; }
  const field = parts[1]!;
  const value = parts.slice(2).join(" ").replace(/^"|"$/g, "");
  client.setMeta(field, value);
  console.log(green(`  set ${field} = "${value}"`));
}

async function cmdQueue() {
  const size = await client.getOfflineQueueSize();
  console.log(`  offline queue size: ${size}`);
}

async function cmdReset() {
  try {
    await client.reset();
    console.log(green("  session reset — relay log cleared, local document wiped"));
    console.log(dim("  all connected clients have also been reset"));
    renderState("after: reset");
  } catch (err) {
    console.log(red(`  reset failed: ${(err as Error).message}`));
    console.log(dim("  only the Owner role can reset the session"));
  }
}

async function cmdMint(parts: string[]) {
  if (parts.length < 3) {
    console.log(red("  usage: mint <siteId> <role>  (role: owner | editor | viewer)"));
    return;
  }
  const siteId = parts[1]!;
  const roleStr = parts[2]!.toLowerCase();
  const role =
    roleStr === "owner" ? Role.Owner :
      roleStr === "editor" ? Role.Editor :
        roleStr === "viewer" ? Role.Viewer : null;
  if (!role) {
    console.log(red("  role must be: owner | editor | viewer"));
    return;
  }
  try {
    const token = await client.mintToken(siteId, role);
    mintedTokens.push({ siteId, role, token });
    console.log(green(`  minted token for ${siteId} (${role}):`));
    console.log(`  --site ${siteId} --token ${token}`);
  } catch (err) {
    console.log(red(`  mint failed: ${(err as Error).message}`));
  }
}

function cmdPeers() {
  if (knownPeers.size === 0) {
    console.log(dim("  no other peers connected"));
    return;
  }
  console.log(`\n  ${bold("Connected peers:")}`);
  for (const [id, r] of knownPeers.entries()) {
    console.log(`    ${cyan(id)}  role=${r}`);
  }
}

function cmdTokens() {
  if (mintedTokens.length === 0) {
    console.log(dim("  no tokens minted this session"));
    return;
  }
  console.log(`\n  ${bold("Tokens minted this session:")}`);
  for (const { siteId, role, token } of mintedTokens) {
    console.log(`    ${cyan(siteId)}  role=${role}`);
    console.log(`      --site ${siteId} --token ${token}`);
  }
}

// ── IndexedDB init ────────────────────────────────────────────────────────────

async function initIndexedDB(): Promise<void> {
  // Each client needs its own LevelDB directory; node-indexeddb uses process.cwd()
  // at first import. Chdir before importing so concurrent clients don't collide.
  if (cfg.dbDir) {
    const resolved = path.resolve(cfg.dbDir);
    fs.mkdirSync(resolved, { recursive: true });
    process.chdir(resolved);
  }
  const dbManager = (await import("node-indexeddb/dbManager")).default;
  await dbManager.loadCache();
  await import("node-indexeddb/auto");
}

// ── REPL ──────────────────────────────────────────────────────────────────────

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: `${bold(`${cfg.site}>`)} `,
});

// True while handleLine is awaiting a command. Async callbacks skip rl.prompt()
// during this window to avoid printing the prompt mid-command output.
let commandPending = false;

// Lines that arrive before client is ready are queued and replayed after init.
const pendingLines: string[] = [];
let clientReady = false;
let stdinClosed = false; // true once readline emits 'close' (piped EOF or rl.close())

async function handleLine(line: string): Promise<void> {
  commandPending = true;
  const parts = line.trim().split(/\s+/);
  const cmd = parts[0] ?? "";
  try {

    switch (cmd) {
      case "ins":
        await cmdInsert(parts);
        break;
      case "del":
        cmdDelete(parts);
        break;
      case "connect":
      case "online":
        await cmdConnect();
        break;
      case "disconnect":
      case "offline":
        cmdDisconnect();
        break;
      case "meta":
        cmdMeta(parts);
        break;
      case "state":
        renderState();
        break;
      case "queue":
        await cmdQueue();
        break;
      case "reset":
        await cmdReset();
        break;
      case "mint":
        await cmdMint(parts);
        break;
      case "peers":
        cmdPeers();
        break;
      case "tokens":
        cmdTokens();
        break;
      case "help":
        printHelp();
        break;
      case "quit":
      case "exit":
        client.close();
        rl.close();
        process.exit(0);
        break;
      case "":
        break;
      default:
        console.log(red(`  unknown command: ${cmd}  (type 'help')`));
    }
  } finally {
    commandPending = false;
  }
}

// Registered at module scope so piped stdin is captured before initIndexedDB completes.
rl.on("line", (line) => {
  if (clientReady) {
    void handleLine(line).then(() => rl.prompt());
  } else {
    pendingLines.push(line);
  }
});

rl.on("close", () => {
  stdinClosed = true;
  // If already interactive (clientReady), exit immediately.
  // If still initializing, let main() exit after draining pendingLines.
  if (clientReady) {
    if (client) client.close();
    process.exit(0);
  }
});

async function main() {
  await initIndexedDB();

  client = new ClientSync(cfg.site, cfg.url, cfg.token, {
    connection: {
      WebSocketImpl: WebSocket as unknown as WebSocketConstructor,
      initialBackoffMs: 500,
    },
  });

  // Wire callbacks
  client.onOpsApplied = (ops) => {
    process.stdout.write("\n");
    console.log(dim(`  ← received ${ops.length} op(s) from peer`));
    renderState("after: incoming ops");
    if (!commandPending) rl.prompt();
  };

  client.onMetaChanged = (changed) => {
    process.stdout.write("\n");
    console.log(dim(`  ← metadata updated: ${changed.map((c) => c.field).join(", ")}`));
    if (!commandPending) rl.prompt();
  };

  client.onWelcome = (activeSites) => {
    for (const { siteId, role } of activeSites) {
      knownPeers.set(siteId, role);
    }
  };

  client.onSiteJoined = (siteId, role) => {
    knownPeers.set(siteId, role);
    process.stdout.write("\n");
    console.log(green(`  ✓ ${siteId} joined as ${role}`));
    if (!commandPending) rl.prompt();
  };

  client.onSiteLeft = (siteId) => {
    knownPeers.delete(siteId);
    process.stdout.write("\n");
    console.log(yellow(`  ✗ ${siteId} left`));
    if (!commandPending) rl.prompt();
  };

  client.onConnectionChange = (state) => {
    if (state === "reconnecting") {
      process.stdout.write("\n");
      console.log(yellow(`  ↻ connection lost — reconnecting...`));
      if (!commandPending) rl.prompt();
    }
  };

  client.onError = (err) => {
    process.stdout.write("\n");
    console.log(red(`  ✗ ${err.code}: ${err.message}`));
    if (!commandPending) rl.prompt();
  };

  // Mark ready and drain any lines that arrived during init.
  clientReady = true;
  printHelp();
  for (const line of pendingLines.splice(0)) {
    await handleLine(line);
    rl.prompt();
  }
  // If stdin already closed (piped input exhausted and no quit command ran), exit now.
  if (stdinClosed) {
    client.close();
    process.exit(0);
  }
  rl.prompt();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
