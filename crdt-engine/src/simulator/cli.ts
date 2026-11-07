/**
 * cli.ts — Interactive REPL for the Phase 1 crdt-engine prototype.
 *
 * Start:
 *   npx ts-node src/simulator/cli.ts
 *   npx ts-node src/simulator/cli.ts --replicas 4
 */

import * as readline from "readline";
import { Replica } from "./Replica";
import { NetworkSim, DeliveryOrder } from "./NetworkSim";

// ── ANSI ──────────────────────────────────────────────────────────────────────

const bold   = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim    = (s: string) => `\x1b[2m${s}\x1b[0m`;
const green  = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red    = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const cyan   = (s: string) => `\x1b[36m${s}\x1b[0m`;

// ── Arg parsing ───────────────────────────────────────────────────────────────

function parseArgs(argv: string[]) {
  const get = (flag: string, def: string) => {
    const i = argv.indexOf(`--${flag}`);
    return i !== -1 ? (argv[i + 1] ?? def) : def;
  };
  return { replicaCount: parseInt(get("replicas", "3")) };
}

// ── State ─────────────────────────────────────────────────────────────────────

const cfg = parseArgs(process.argv.slice(2));
const sim = new NetworkSim(42);

for (let i = 1; i <= cfg.replicaCount; i++) {
  sim.addReplica(new Replica(`S${i}`));
}

// ── Display ───────────────────────────────────────────────────────────────────

function renderState(label?: string) {
  const bar = dim("─".repeat(60));
  console.log(`\n${bar}`);
  if (label) console.log(`  ${bold(label)}`);

  for (const id of sim.siteIds) {
    const r = sim.getReplica(id)!;
    const offline = sim.isPartitioned(id);

    const statusTag = offline ? red(" [offline]") : green(" [online] ");

    // buf = causal buffer (out-of-order remote ops waiting for dependencies)
    const buf = r.getPendingCount();
    const bufTag = buf > 0 ? yellow(` buf:${buf}`) : dim(` buf:0`);

    // queued = ops held by sim due to partition (outgoing + incoming)
    const queued = sim.queuedForSite(id);
    const queuedTag = offline && queued > 0
      ? red(` queued:${queued}`)
      : offline
        ? dim(` queued:0`)
        : "";

    const text = r.getText();
    const docStr = text.length === 0 ? dim("(empty)") : `"${cyan(text)}"`;

    const clockEntries = Object.entries(r.getClockSnapshot())
      .map(([s, n]) => `${s}:${n}`)
      .join(" ");
    const clockStr = dim(`  clock{${clockEntries}}`);

    console.log(
      `  ${bold(id)}${statusTag}${bufTag}${queuedTag}  ${docStr}  len=${text.length}${clockStr}`
    );
  }

  const converged = sim.assertConverged(); // online replicas only
  const allConverged = sim.assertAllConverged(); // all replicas including offline

  const convTag = allConverged
    ? green("✓ all converged")
    : converged
      ? yellow("✓ online converged (offline sites pending)")
      : yellow("~ pending convergence");

  console.log(`\n  ${convTag}  |  pending buf total: ${sim.totalPending()}`);
  console.log(bar);
}

// ── Help ──────────────────────────────────────────────────────────────────────

function printHelp() {
  console.log(`
${bold("═══ Phase 1 CRDT Prototype — Commands ═══")}

${bold("Document editing")}
  ${bold("ins <site> <offset> <text>")}   Insert text at offset on a replica
                                ${dim("e.g.  ins S1 0 hello")}
  ${bold("del <site> <offset>")}          Delete character at offset
                                ${dim("e.g.  del S2 3")}

${bold("Network delivery")}
  ${bold("step [order]")}                 Deliver one round of ops (online sites only)
                                ${dim("order: causal (default) | random | reverse")}
  ${bold("sync [order]")}                 Deliver until online replicas converge

${bold("Partition simulation")}
  ${bold("partition <site> [site...]")}   Fully isolate site(s): no send, no receive
                                ${dim("outgoing ops queued; incoming ops also queued")}
  ${bold("heal")}                         Reconnect all sites and flush both queues
                                ${dim("outgoing ops reach all online sites")}
                                ${dim("incoming ops reach the reconnected sites")}

${bold("LWW metadata")}
  ${bold("meta <site> <field> <value>")}  Set metadata field on a replica
  ${bold("syncmeta")}                     Simulate relay broadcasting LWW snapshots

${bold("View")}
  ${bold("state")}                        Print current state of all replicas
  ${bold("log")}                          Show RGA debug dump (nodes + tombstones)
  ${bold("help")}                         Show this help

${bold("Session")}
  ${bold("quit")} / ${bold("exit")}                Stop the REPL

${bold("Partition model")}
  buf:N     = ops in causal buffer (out-of-order, waiting for dependencies)
  queued:N  = ops held by simulator because the site is partitioned
              (includes both outgoing from this site and incoming from others)
`);
}

// ── Commands ──────────────────────────────────────────────────────────────────

function cmdInsert(parts: string[]) {
  if (parts.length < 4) { console.log(red("  usage: ins <site> <offset> <text>")); return; }
  const [, siteId, offsetStr, ...textParts] = parts;
  const offset = parseInt(offsetStr!);
  const text = textParts.join(" ");
  const r = sim.getReplica(siteId!);
  if (!r) { console.log(red(`  unknown site: ${siteId}`)); return; }
  if (isNaN(offset)) { console.log(red("  offset must be a number")); return; }
  for (let i = 0; i < text.length; i++) r.insert(offset + i, text[i]!);
  if (sim.isPartitioned(siteId!)) {
    console.log(yellow(`  [${siteId} is offline] inserted "${text}" locally — not yet visible to others`));
  } else {
    console.log(green(`  inserted "${text}" at offset ${offset} on ${siteId}`));
  }
  renderState(`after: ins ${siteId} ${offset} "${text}"`);
}

function cmdDelete(parts: string[]) {
  if (parts.length < 3) { console.log(red("  usage: del <site> <offset>")); return; }
  const [, siteId, offsetStr] = parts;
  const offset = parseInt(offsetStr!);
  const r = sim.getReplica(siteId!);
  if (!r) { console.log(red(`  unknown site: ${siteId}`)); return; }
  if (isNaN(offset)) { console.log(red("  offset must be a number")); return; }
  const result = r.delete(offset);
  if (result === null) {
    console.log(yellow(`  nothing at offset ${offset} on ${siteId}`));
  } else if (sim.isPartitioned(siteId!)) {
    console.log(yellow(`  [${siteId} is offline] deleted char locally — not yet visible to others`));
  } else {
    console.log(green(`  deleted char at offset ${offset} on ${siteId}`));
  }
  renderState(`after: del ${siteId} ${offset}`);
}

function cmdStep(parts: string[]) {
  const order = (parts[1] ?? "causal") as DeliveryOrder;
  if (!["causal", "random", "reverse"].includes(order)) {
    console.log(red(`  invalid order "${order}": use causal | random | reverse`)); return;
  }
  const count = sim.step(order);
  console.log(green(`  delivered ${count} op(s) [order: ${order}]`));
  renderState(`after: step ${order}`);
}

function cmdSync(parts: string[]) {
  const order = (parts[1] ?? "causal") as DeliveryOrder;
  sim.runAll(order);
  console.log(green(`  synced online replicas [order: ${order}]`));
  renderState("after: sync");
}

function cmdPartition(parts: string[]) {
  const sites = parts.slice(1);
  if (sites.length === 0) { console.log(red("  usage: partition <site> [site...]")); return; }
  const unknown = sites.filter(s => !sim.getReplica(s));
  if (unknown.length > 0) { console.log(red(`  unknown site(s): ${unknown.join(", ")}`)); return; }
  sim.partition(sites);
  console.log(yellow(`  partitioned: [${sites.join(", ")}]`));
  console.log(dim(`  these sites will neither send nor receive until "heal"`));
  renderState("after: partition");
}

function cmdHeal() {
  const partitioned = sim.siteIds.filter(id => sim.isPartitioned(id));
  if (partitioned.length === 0) { console.log(dim("  no partitions active")); return; }
  console.log(green(`  healing: [${partitioned.join(", ")}]`));
  console.log(dim(`  flushing outgoing queue (their ops → online sites)`));
  console.log(dim(`  flushing incoming queue (online ops → them)`));
  sim.heal();
  renderState("after: heal");
}

function cmdMeta(parts: string[]) {
  if (parts.length < 4) { console.log(red("  usage: meta <site> <field> <value>")); return; }
  const [, siteId, field, ...valueParts] = parts;
  const value = valueParts.join(" ").replace(/^"|"$/g, "");
  const r = sim.getReplica(siteId!);
  if (!r) { console.log(red(`  unknown site: ${siteId}`)); return; }
  r.setMeta(field!, value, Date.now());
  console.log(green(`  set ${siteId}.${field} = "${value}"`));
}

function cmdSyncMeta() {
  const ids = sim.siteIds;
  const snapshots = ids.map(id => ({ id, snap: sim.getReplica(id)!.lww.snapshot() }));
  for (const { id, snap } of snapshots) {
    for (const otherId of ids) {
      if (otherId !== id) sim.getReplica(otherId)!.mergeMeta(snap);
    }
  }
  const allFields = new Set(ids.flatMap(id => sim.getReplica(id)!.lww.fields()));
  if (allFields.size === 0) { console.log(dim("  no metadata set yet")); return; }
  console.log(green("  LWW metadata after sync:"));
  for (const field of allFields) {
    const values = ids.map(id => `${id}:${JSON.stringify(sim.getReplica(id)!.lww.get(field))}`);
    console.log(`    ${bold(field)}: ${values.join("  ")}`);
  }
}

function cmdLog() {
  console.log();
  for (const id of sim.siteIds) {
    const r = sim.getReplica(id)!;
    const offline = sim.isPartitioned(id) ? red(" [offline]") : "";
    console.log(`  ${bold(id)}${offline} RGA dump: ${cyan(r.doc.debugDump())}`);
    console.log(`       total nodes (incl. tombstones): ${r.doc.totalNodeCount}`);
  }
  console.log();
}

// ── REPL ──────────────────────────────────────────────────────────────────────

function startREPL() {
  console.clear();
  console.log(bold(`\n  CRDT Collaborative Editor — Phase 1 Prototype`));
  console.log(dim(`  ${cfg.replicaCount} replicas: ${sim.siteIds.join(", ")}`));
  console.log(dim(`  type "help" for available commands`));
  renderState("initial state");

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `\n${bold("crdt>")} `,
  });

  rl.prompt();

  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) { rl.prompt(); return; }
    const parts = trimmed.split(/\s+/);
    const cmd = parts[0]!.toLowerCase();

    switch (cmd) {
      case "ins": case "insert":      cmdInsert(parts);   break;
      case "del": case "delete":      cmdDelete(parts);   break;
      case "step":                    cmdStep(parts);     break;
      case "sync":                    cmdSync(parts);     break;
      case "partition": case "part":  cmdPartition(parts); break;
      case "heal":                    cmdHeal();          break;
      case "meta":                    cmdMeta(parts);     break;
      case "syncmeta":                cmdSyncMeta();      break;
      case "log":                     cmdLog();           break;
      case "state": case "s":         renderState();      break;
      case "help": case "h": case "?": printHelp();       break;
      case "quit": case "exit": case "q":
        console.log(dim("\n  bye\n"));
        rl.close();
        process.exit(0);
        break;
      default:
        console.log(red(`  unknown command: "${cmd}"  (type "help")`));
    }
    rl.prompt();
  });

  rl.on("close", () => process.exit(0));
}

startREPL();