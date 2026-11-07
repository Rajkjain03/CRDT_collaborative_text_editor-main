/**
 * server/server.ts — Entry point for the collab-sync relay server.
 *
 * Starts the relay on a configured port, prints the owner token for
 * distribution to the first client.
 *
 * Usage:
 *   npx ts-node server/server.ts
 *   PORT=9090 npx ts-node server/server.ts
 */
import * as os from "os";
import { SessionManager } from "./SessionManager.ts";
import { RelayServer } from "./RelayServer.ts";
import dotenv from "dotenv";
dotenv.config()
const PORT = parseInt(process.env["PORT"] ?? "8080", 10);
function getLanAddresses(): string[] {
  const interfaces = os.networkInterfaces();
  const addresses: string[] = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] ?? []) {
      // Skip internal (loopback) and IPv6 link-local addresses
      if (iface.family === "IPv4" && !iface.internal) {
        addresses.push(iface.address);
      }
    }
  }
  return addresses;
}
async function main() {
  const sessionManager = new SessionManager();
  const { ownerSiteId, ownerToken } = sessionManager.initSession();

  const relay = new RelayServer(PORT, sessionManager);
  await relay.start();
  const lanIps = getLanAddresses();

  console.log("─────────────────────────────────────────");
  console.log(`  collab-sync relay listening on port ${PORT}`);
  console.log("─────────────────────────────────────────");
  console.log(`  Local:   ws://localhost:${PORT}`);
  for (const ip of lanIps) {
    console.log(`  LAN:     ws://${ip}:${PORT}`);
  }
  console.log("─────────────────────────────────────────");
  console.log(`  Owner Site ID : ${ownerSiteId}`);
  console.log(`  Owner Token   : ${ownerToken}`);
  console.log("─────────────────────────────────────────");
  console.log("  Share the owner token with the first client to connect.");
  console.log("  Use SessionManager.mintToken() to issue editor/viewer tokens.");
  console.log("─────────────────────────────────────────");
  // Graceful shutdown
  process.on("SIGINT", async () => {
    console.log("\nShutting down relay...");
    await relay.stop();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    await relay.stop();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("Failed to start relay:", err);
  process.exit(1);
});
