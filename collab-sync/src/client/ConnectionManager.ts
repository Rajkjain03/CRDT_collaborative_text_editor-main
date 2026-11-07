/**
 * ConnectionManager — WebSocket lifecycle for ClientSync.
 *
 * Owns the raw socket and the reconnect loop. Exposes a minimal callback-based
 * API so ClientSync does not need to know anything about WebSocket state
 * machines or exponential backoff.
 *
 * ── State machine ────────────────────────────────────────────────────────────
 *
 *   disconnected ──connect()──▶ connecting ──onopen──▶ connected
 *        ▲                          │                      │
 *        │                          │onclose/error         │onclose
 *        │                          ▼                      │
 *        │                     reconnecting ◀──────────────┘
 *        │                          │
 *        └───────disconnect()───────┘
 *
 * ── Reconnect strategy ──────────────────────────────────────────────────────
 *
 * On any unexpected close or error, schedule a reconnect with exponential
 * backoff. The first retry is after 500ms, doubling after each subsequent
 * failure up to a maximum of 30 seconds. A successful open resets the backoff.
 *
 * ── Environment compatibility ────────────────────────────────────────────────
 *
 * Works in both browser and Node.js. In the browser, `WebSocket` is global.
 * In Node.js, pass a `WebSocket` constructor (from the `ws` package) via
 * the options argument to avoid a hard dependency on a specific package.
 */

export type ConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting";

/**
 * Minimal WebSocket interface that both browser WebSocket and the `ws`
 * package satisfy. Accepting this shape avoids coupling ConnectionManager
 * to one implementation.
 */
export interface WebSocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export interface WebSocketConstructor {
  new (url: string): WebSocketLike;
  readonly OPEN: number;
}

export interface ConnectionManagerOptions {
  /** Custom WebSocket constructor (e.g. from `ws` package in Node.js).
   *  Defaults to the global `WebSocket` (browser environment). */
  WebSocketImpl?: WebSocketConstructor;
  /** Initial reconnect delay in ms. Default: 500. */
  initialBackoffMs?: number;
  /** Maximum reconnect delay in ms. Default: 30000. */
  maxBackoffMs?: number;
  /** Multiplier applied to backoff after each failure. Default: 2. */
  backoffMultiplier?: number;
}

export class ConnectionManager {
  private readonly url: string;
  private readonly WebSocketImpl: WebSocketConstructor;
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly backoffMultiplier: number;

  private socket: WebSocketLike | null = null;
  private state: ConnectionState = "disconnected";
  private currentBackoffMs: number;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalClose = false;

  // Event callbacks — set by ClientSync
  onOpen: (() => void) | null = null;
  onMessage: ((raw: string) => void) | null = null;
  onClose: (() => void) | null = null;
  onStateChange: ((state: ConnectionState) => void) | null = null;

  constructor(url: string, options: ConnectionManagerOptions = {}) {
    this.url = url;

    // Resolve WebSocket constructor: explicit option, then globalThis.WebSocket
    const impl =
      options.WebSocketImpl ??
      (typeof globalThis !== "undefined" && "WebSocket" in globalThis
        ? (globalThis as unknown as { WebSocket: WebSocketConstructor })
            .WebSocket
        : null);

    if (!impl) {
      throw new Error(
        "ConnectionManager: no WebSocket implementation available. " +
          "In Node.js, pass { WebSocketImpl: require('ws') } to the constructor.",
      );
    }
    this.WebSocketImpl = impl;

    this.initialBackoffMs = options.initialBackoffMs ?? 500;
    this.maxBackoffMs = options.maxBackoffMs ?? 30000;
    this.backoffMultiplier = options.backoffMultiplier ?? 2;
    this.currentBackoffMs = this.initialBackoffMs;
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  /**
   * Open the WebSocket connection. Idempotent — calling while already
   * connecting or connected is a no-op.
   */
  connect(): void {
    if (this.state === "connecting" || this.state === "connected") return;

    this.intentionalClose = false;
    this.setState("connecting");
    this.openSocket();
  }

  /**
   * Close the connection cleanly. Any scheduled reconnect is cancelled.
   * The reconnect loop will not fire after this is called.
   */
  disconnect(): void {
    this.intentionalClose = true;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.socket) {
      try {
        this.socket.close(1000, "client disconnecting");
      } catch {
        // Socket already closed — ignore
      }
      this.socket = null;
    }

    this.setState("disconnected");
  }

  /**
   * Send a pre-serialised message over the socket.
   *
   * @returns true if the message was queued for transmission,
   *          false if the socket is not open (caller should persist
   *          the message to the offline queue).
   */
  send(raw: string): boolean {
    if (!this.socket || this.socket.readyState !== this.WebSocketImpl.OPEN) {
      return false;
    }
    try {
      this.socket.send(raw);
      return true;
    } catch {
      return false;
    }
  }

  getState(): ConnectionState {
    return this.state;
  }

  /** Exposed for test assertions — current backoff interval. */
  getBackoffMs(): number {
    return this.currentBackoffMs;
  }

  // ─── Internal ─────────────────────────────────────────────────────────────

  private openSocket(): void {
    try {
      this.socket = new this.WebSocketImpl(this.url);
    } catch (err) {
      // Constructor throwing is rare but possible (invalid URL)
      this.scheduleReconnect();
      return;
    }

    this.socket.onopen = () => this.handleOpen();
    this.socket.onmessage = (ev) => this.handleMessage(ev);
    this.socket.onclose = () => this.handleClose();
    this.socket.onerror = () => {
      // onerror fires before onclose; let onclose handle state transition
      // to avoid firing onClose callback twice.
    };
  }

  private handleOpen(): void {
    this.setState("connected");
    this.currentBackoffMs = this.initialBackoffMs; // reset backoff on success
    this.onOpen?.();
  }

  private handleMessage(ev: { data: unknown }): void {
    if (typeof ev.data !== "string") {
      // Binary messages not supported; drop silently
      return;
    }
    this.onMessage?.(ev.data);
  }

  private handleClose(): void {
    this.socket = null;
    this.onClose?.();

    if (this.intentionalClose) {
      this.setState("disconnected");
      return;
    }

    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    this.setState("reconnecting");

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.intentionalClose) return;
      this.setState("connecting");
      this.openSocket();

      // Prepare next backoff for the following failure (if any)
      this.currentBackoffMs = Math.min(
        this.currentBackoffMs * this.backoffMultiplier,
        this.maxBackoffMs,
      );
    }, this.currentBackoffMs);
  }

  private setState(next: ConnectionState): void {
    if (this.state === next) return;
    this.state = next;
    this.onStateChange?.(next);
  }
}
