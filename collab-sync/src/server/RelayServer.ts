/**
 * server/RelayServer.ts — WebSocket relay server.
 *
 * The relay forwards WireMessages between connected clients and maintains
 * an append-only op log so clients that join (or rejoin after a disconnect)
 * can be brought up to date.
 *
 * Responsibilities:
 *   1. Accept WebSocket connections and perform the join handshake
 *   2. Validate tokens and enforce role-based permissions
 *   3. Forward op/meta messages to all other connected clients
 *   4. Append every forwarded op to an in-memory log
 *   5. On join (and rejoin), replay the ops the client has not yet seen
 *      based on the vector clock snapshot it sent in JoinMessage
 *   6. Broadcast site_joined/site_left presence events
 *   7. On clear_log (Owner only), wipe the op log and broadcast log_cleared
 *      so all connected clients can reset their local state
 *
 * ── Op log and replay ───────────────────────────────────────────────────────
 *
 * Every OpMessage that passes role validation is appended to `opLog`. Each
 * entry records the sender's siteId, the op, and the op's clock snapshot
 * (taken from the op itself — Replica.insert/delete attaches it before
 * incrementing the local clock).
 *
 * On JoinMessage, the client sends its current vector clock. The relay
 * walks the log; for each entry it checks whether the client has already
 * seen that op by comparing the client's counter for the sender against
 * the sender's counter at the time the op was generated. Unseen ops are
 * sent in log order. CausalBuffer on the client tolerates duplicates and
 * out-of-order arrival.
 *
 * The relay does NOT skip a rejoining client's own ops unconditionally.
 * After a process restart, a client's Replica has clock {} and needs its
 * own previous ops replayed to reconstruct the document. The clock-based
 * check handles both cases: a fresh Replica (clock {}) receives its own
 * ops; a reconnecting Replica (clock advanced) skips them correctly.
 *
 * Bounded retention: the log is capped at MAX_LOG_SIZE entries. When the
 * cap is reached, the oldest entries are dropped. A client offline for
 * longer than MAX_LOG_SIZE ops worth of activity may miss some ops. For
 * the typical demo and course project, MAX_LOG_SIZE is high enough that
 * this is not a concern.
 *
 * ── Session reset ────────────────────────────────────────────────────────────
 *
 * An Owner client may send ClearLogRequest to wipe the op log and reset
 * all connected clients to an empty document, without restarting the relay
 * (which would invalidate all tokens). The relay clears the log, resets
 * nextSeqNo, and broadcasts LogClearedMessage to every session including
 * the requester. Each client creates a fresh Replica and clears its
 * IndexedDB offline queue on receipt.
 */

import { WebSocketServer, WebSocket } from "ws";
import type {
  SiteId,
  RGAOperation,
  VectorClockSnapshot,
} from "crdt-engine";
import {
  parseWireMessage,
  serializeWireMessage,
} from "../../shared/protocol.ts";
import type {
  WireMessage,
  OpMessage,
  MetaMessage,
  JoinMessage,
  MintTokenRequest,
  ClearLogRequest,
} from "../../shared/protocol.ts";
import { Role, canInsert, canDelete, canChangeRoles } from "../../shared/roles.ts";
import { SessionManager } from "./SessionManager.ts";

// ── Connected session type ───────────────────────────────────────────────────

export type ConnectedSession = {
  siteId: SiteId;
  role: Role;
  ws: WebSocket;
  connectedAt: number;
};

// ── Op log entry ────────────────────────────────────────────────────────────

type LogEntry = {
  sender: SiteId;
  op: RGAOperation;
  clock: VectorClockSnapshot;
  seqNo: number;
};

// ── RelayServer ──────────────────────────────────────────────────────────────

/**
 * Maximum number of ops retained in the in-memory log. When the log
 * grows past this size, the oldest entries are dropped.
 *
 * 10,000 ops at ~50 bytes each ≈ 500KB memory. A typing user generates
 * ~10 ops/sec under heavy load, so 10k ops covers ~15 minutes of constant
 * typing — far longer than typical offline windows.
 */
const MAX_LOG_SIZE = 10_000;

export class RelayServer {
  private wss: WebSocketServer | null = null;
  private sessions: Map<SiteId, ConnectedSession> = new Map();
  private sessionManager: SessionManager;
  private port: number;

  /** Append-only log of every forwarded op. Bounded by MAX_LOG_SIZE. */
  private opLog: LogEntry[] = [];
  private nextSeqNo = 0;

  /**
   * Sockets that have connected but not yet completed the join handshake.
   * If a socket sends anything other than a JoinMessage first, or sends
   * an invalid token, it is closed.
   */
  private pendingConnections: Set<WebSocket> = new Set();

  constructor(port: number, sessionManager: SessionManager) {
    this.port = port;
    this.sessionManager = sessionManager;
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────────

  /** Start the WebSocket server. Resolves when the port is bound. */
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.wss = new WebSocketServer({ port: this.port });
      this.wss.on("listening", () => resolve());
      this.wss.on("error", (err) => reject(err));
      this.wss.on("connection", (ws: WebSocket) => this.onConnection(ws));
    });
  }

  /** Close all sessions and stop the server. Resolves when the port is released. */
  stop(): Promise<void> {
    return new Promise((resolve) => {
      for (const session of this.sessions.values()) session.ws.close();
      this.sessions.clear();
      for (const ws of this.pendingConnections) ws.close();
      this.pendingConnections.clear();
      if (this.wss) {
        this.wss.close(() => {
          this.wss = null;
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  /** Returns the siteIds of all currently-connected sessions. */
  getConnectedSites(): SiteId[] {
    return [...this.sessions.keys()];
  }

  /** Number of ops currently retained in the log. Used by tests/diagnostics. */
  getLogSize(): number {
    return this.opLog.length;
  }

  // ─── Connection handling ─────────────────────────────────────────────────

  private onConnection(ws: WebSocket): void {
    this.pendingConnections.add(ws);

    const joinTimeout = setTimeout(() => {
      if (this.pendingConnections.has(ws)) {
        this.sendToSocket(ws, {
          kind: "error",
          code: "invalid_token",
          message: "Join timeout — no JoinMessage received within 10 seconds",
          fatal: true,
        });
        ws.close();
        this.pendingConnections.delete(ws);
      }
    }, 10_000);

    ws.on("message", (data: Buffer | string) => {
      const raw = typeof data === "string" ? data : data.toString("utf-8");
      if (this.pendingConnections.has(ws)) {
        clearTimeout(joinTimeout);
        this.handleJoin(ws, raw);
      } else {
        this.onMessage(ws, raw);
      }
    });

    ws.on("close", () => {
      clearTimeout(joinTimeout);
      if (this.pendingConnections.has(ws)) {
        this.pendingConnections.delete(ws);
      } else {
        for (const [, session] of this.sessions.entries()) {
          if (session.ws === ws) {
            this.onDisconnect(session);
            break;
          }
        }
      }
    });

    ws.on("error", () => {
      // Errors surface via close — nothing extra needed
    });
  }

  // ─── Join handshake ──────────────────────────────────────────────────────

  private handleJoin(ws: WebSocket, raw: string): void {
    const msg = parseWireMessage(raw);

    if (!msg || msg.kind !== "join") {
      this.sendToSocket(ws, {
        kind: "error",
        code: "malformed_message",
        message: "First message must be a valid JoinMessage",
        fatal: true,
      });
      ws.close();
      this.pendingConnections.delete(ws);
      return;
    }

    const joinMsg = msg as JoinMessage;
    const validated = this.sessionManager.validateToken(joinMsg.token);

    if (!validated) {
      this.sendToSocket(ws, {
        kind: "error",
        code: "invalid_token",
        message: "Token validation failed",
        fatal: true,
      });
      ws.close();
      this.pendingConnections.delete(ws);
      return;
    }

    if (validated.siteId !== joinMsg.siteId) {
      this.sendToSocket(ws, {
        kind: "error",
        code: "invalid_token",
        message: "Token siteId does not match JoinMessage siteId",
        fatal: true,
      });
      ws.close();
      this.pendingConnections.delete(ws);
      return;
    }

    // If the same siteId is already connected, evict the older session.
    // This handles reconnects where the relay has not yet noticed the
    // old socket died.
    const existing = this.sessions.get(validated.siteId);
    if (existing) {
      try { existing.ws.close(); } catch { /* ignore */ }
      this.sessions.delete(validated.siteId);
    }

    this.pendingConnections.delete(ws);
    const session: ConnectedSession = {
      siteId: validated.siteId,
      role: validated.role,
      ws,
      connectedAt: Date.now(),
    };
    this.sessions.set(validated.siteId, session);
    this.sessionManager.registerSite(validated.siteId, validated.role);

    this.sendToSocket(ws, {
      kind: "welcome",
      assignedSiteId: validated.siteId,
      role: validated.role,
      activeSites: [...this.sessions.values()].map((s) => ({
        siteId: s.siteId,
        role: s.role,
      })),
    });

    // Replay missed ops BEFORE broadcasting site_joined to others, so
    // the joining client receives history before any new live ops.
    this.replayMissedOps(session, joinMsg.clockSnapshot ?? {});

    this.broadcast(
      {
        kind: "site_joined",
        siteId: validated.siteId,
        role: validated.role,
      },
      validated.siteId
    );
  }

  /**
   * Replay log entries the joining client has not yet seen.
   *
   * For each log entry, the client has seen the op iff
   *   clientClock[entry.sender] >= entry.clock[entry.sender] + 1
   * because the op's clock is the snapshot taken BEFORE the sender
   * incremented. Equivalently: skip if `clientClock[sender] > senderCounterAtOp`.
   *
   * Delivery is in log order, which preserves the order the relay forwarded
   * ops. The client's CausalBuffer holds anything whose dependencies are
   * not yet satisfied.
   */
  private replayMissedOps(
    session: ConnectedSession,
    clientClock: VectorClockSnapshot
  ): void {
    let replayed = 0;
    for (const entry of this.opLog) {
      // Use only the clock check — do NOT unconditionally skip the client's
      // own ops. After a process restart the client has a fresh Replica with
      // clock {} and needs its own previous ops replayed so it can reconstruct
      // the document. For a normal reconnect (same Replica, clock advanced)
      // the clock check already skips ops the client has already applied.
      const senderCounterAtOp = entry.clock[entry.sender] ?? 0;
      const clientCounterForSender = clientClock[entry.sender] ?? 0;

      if (clientCounterForSender > senderCounterAtOp) continue;

      this.sendToSocket(session.ws, {
        kind: "op",
        siteId: entry.sender,
        op: entry.op,
      });
      replayed++;
    }
    if (replayed > 0) {
      // eslint-disable-next-line no-console
      console.log(`[relay] replayed ${replayed} ops to ${session.siteId} on join`);
    }
  }

  // ─── Message routing ─────────────────────────────────────────────────────

  private onMessage(ws: WebSocket, raw: string): void {
    const msg = parseWireMessage(raw);

    if (!msg) {
      this.sendToSocket(ws, {
        kind: "error",
        code: "malformed_message",
        message: "Could not parse message",
      });
      return;
    }

    let session: ConnectedSession | undefined;
    for (const s of this.sessions.values()) {
      if (s.ws === ws) { session = s; break; }
    }

    if (!session) {
      this.sendToSocket(ws, {
        kind: "error",
        code: "unknown_site",
        message: "No active session for this connection",
      });
      return;
    }

    switch (msg.kind) {
      case "op":         this.handleOp(session, msg as OpMessage); break;
      case "meta":       this.handleMeta(session, msg as MetaMessage); break;
      case "mint_token": this.handleMintToken(session, msg as MintTokenRequest); break;
      case "clear_log":  this.handleClearLog(session, msg as ClearLogRequest); break;
      default: break;
    }
  }

  // ─── Op handling ─────────────────────────────────────────────────────────

  private handleOp(session: ConnectedSession, msg: OpMessage): void {
    const opType = msg.op.type;
    
    // Always fetch the latest role from the authoritative SessionManager
    const currentRole = this.sessionManager.getRole(session.siteId) ?? session.role;

    if (opType === "insert" && !canInsert(currentRole)) {
      this.sendToSocket(session.ws, {
        kind: "error",
        code: "permission_denied",
        message: `Role "${currentRole}" cannot insert`,
      });
      return;
    }

    if (opType === "delete" && !canDelete(currentRole)) {
      this.sendToSocket(session.ws, {
        kind: "error",
        code: "permission_denied",
        message: `Role "${currentRole}" cannot delete`,
      });
      return;
    }

    // Append BEFORE broadcasting — if a client joins mid-broadcast, the
    // op must already be visible to replayMissedOps.
    this.appendToLog(session.siteId, msg.op);

    this.broadcast(msg, session.siteId);
  }

  private appendToLog(sender: SiteId, op: RGAOperation): void {
    this.opLog.push({
      sender,
      op,
      clock: op.clock,
      seqNo: this.nextSeqNo++,
    });
    
    // Look for an injected instance limit, otherwise default to 10000
    const limit = (this as any).maxLogSize || 10000; 
    
    if (this.opLog.length > limit) {
      this.opLog.shift();
    }
}

  // ─── Meta handling ───────────────────────────────────────────────────────

  private handleMeta(session: ConnectedSession, msg: MetaMessage): void {
    this.broadcast(msg, session.siteId);
  }

  // ─── Token minting ───────────────────────────────────────────────────────

  /**
   * Handle a MintTokenRequest (Owner only).
   * Mints a new signed token for the requested siteId and role, then sends
   * a MintTokenResponse back to the requester. Other clients are not notified.
   */
  private handleMintToken(session: ConnectedSession, msg: MintTokenRequest): void {
    if (!canChangeRoles(session.role)) {
      this.sendToSocket(session.ws, {
        kind: "error",
        code: "permission_denied",
        message: `Role "${session.role}" cannot mint tokens`,
      });
      return;
    }

    const token = this.sessionManager.mintToken(msg.siteId, msg.role);
    this.sendToSocket(session.ws, {
      kind: "token_minted",
      siteId: msg.siteId,
      role: msg.role,
      token,
    });
  }

  // ─── Log reset ───────────────────────────────────────────────────────────

  /**
   * Handle a ClearLogRequest (Owner only).
   * Wipes the in-memory op log, resets the sequence counter, and broadcasts
   * LogClearedMessage to every connected client including the requester.
   * Each client resets its local Replica and IndexedDB queue on receipt,
   * giving all parties a clean slate without restarting the relay.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private handleClearLog(session: ConnectedSession, _msg: ClearLogRequest): void {
    if (!canChangeRoles(session.role)) {
      this.sendToSocket(session.ws, {
        kind: "error",
        code: "permission_denied",
        message: `Role "${session.role}" cannot reset the session log`,
      });
      return;
    }

    this.opLog = [];
    this.nextSeqNo = 0;
    // eslint-disable-next-line no-console
    console.log(`[relay] op log cleared by ${session.siteId}`);

    // Broadcast to every connected client including the requester
    const raw = serializeWireMessage({ kind: "log_cleared" });
    for (const s of this.sessions.values()) {
      if (s.ws.readyState === WebSocket.OPEN) {
        s.ws.send(raw);
      }
    }
  }

  // ─── Disconnect ──────────────────────────────────────────────────────────

  private onDisconnect(session: ConnectedSession): void {
    this.sessions.delete(session.siteId);
    this.sessionManager.deregisterSite(session.siteId);
    // Note: do NOT clear this site's ops from the log — the disconnected
    // client may rejoin, and other late joiners still need the history.
    this.broadcast(
      { kind: "site_left", siteId: session.siteId },
      session.siteId
    );
  }

  // ─── Broadcast ───────────────────────────────────────────────────────────

  private broadcast(msg: WireMessage, exclude: SiteId): void {
    const raw = serializeWireMessage(msg);
    for (const [siteId, session] of this.sessions.entries()) {
      if (siteId === exclude) continue;
      if (session.ws.readyState === WebSocket.OPEN) {
        session.ws.send(raw);
      }
    }
  }

  private sendToSocket(ws: WebSocket, msg: WireMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(serializeWireMessage(msg));
    }
  }
}