/**
 * shared/protocol.ts — Wire message types for the collab-sync relay protocol.
 *
 * Both server and client import from this file; nothing else defines message
 * shapes. Every message over the WebSocket is a JSON-serialised WireMessage.
 */

import type {
  SiteId,
  RGAOperation,
  VectorClockSnapshot,
} from "../../crdt-engine/src/types.ts";
import type { LWWState } from "../../crdt-engine/src/lww/LWWRegister.ts";
import type { Role } from "./roles.ts";

// Re-export for convenience
export type { SiteId, RGAOperation, VectorClockSnapshot };

// ── Op messages (client → relay → all other clients) ─────────────────────────

export type OpMessage = {
  kind: "op";
  siteId: SiteId;
  op: RGAOperation;
};

// ── LWW state broadcast (client → relay → all clients) ──────────────────────

export type MetaMessage = {
  kind: "meta";
  state: LWWState<unknown>;
  fromSiteId: SiteId;
};

// ── Session handshake (client → relay on connect) ────────────────────────────

export type JoinMessage = {
  kind: "join";
  siteId: SiteId;
  token: string;
  clockSnapshot: VectorClockSnapshot;
};

// ── Session acknowledgement (relay → client after join) ──────────────────────

export type WelcomeMessage = {
  kind: "welcome";
  assignedSiteId: SiteId;
  role: Role;
  activeSites: Array<{ siteId: SiteId; role: Role }>;
};

// ── Presence / site events (relay → all clients) ─────────────────────────────

export type SiteJoinedMessage = {
  kind: "site_joined";
  siteId: SiteId;
  role: Role;
};

export type SiteLeftMessage = {
  kind: "site_left";
  siteId: SiteId;
};

// ── Token minting (client → relay, owner only) ───────────────────────────────

export type MintTokenRequest = {
  kind: "mint_token";
  siteId: SiteId;  // the new site to mint for
  role: Role;
};

// ── Token minting response (relay → requesting client) ───────────────────────

export type MintTokenResponse = {
  kind: "token_minted";
  siteId: SiteId;
  role: Role;
  token: string;
};

// ── Error (relay → client) ───────────────────────────────────────────────────

export type ErrorCode =
  | "invalid_token"
  | "unknown_site"
  | "permission_denied"
  | "malformed_message";

export type ErrorMessage = {
  kind: "error";
  code: ErrorCode;
  message: string;
  fatal?: boolean;
};

// ── Session reset (Owner → relay → all clients) ───────────────────────────────

/**
 * Owner sends this to clear the relay's op log and reset all clients to an
 * empty document. Useful between demo scenarios without restarting the server.
 */
export type ClearLogRequest = { kind: "clear_log" };

/**
 * Relay broadcasts this to every connected client (including the requester)
 * after clearing the op log. Each client resets its local Replica and queue.
 */
export type LogClearedMessage = { kind: "log_cleared" };

// ── Union ────────────────────────────────────────────────────────────────────

export type WireMessage =
  | OpMessage
  | MetaMessage
  | JoinMessage
  | WelcomeMessage
  | SiteJoinedMessage
  | SiteLeftMessage
  | MintTokenRequest
  | MintTokenResponse
  | ClearLogRequest
  | LogClearedMessage
  | ErrorMessage;

// ── Factory helpers ──────────────────────────────────────────────────────────

export function makeJoinMessage(
  siteId: SiteId,
  token: string,
  clientClock: VectorClockSnapshot,
): JoinMessage {
  return { kind: "join", siteId, token, clockSnapshot: clientClock };
}

export function makeOpMessage(siteId: SiteId, op: RGAOperation): OpMessage {
  return { kind: "op", siteId, op };
}

export function makeMetaMessage(
  fromSiteId: SiteId,
  state: LWWState<unknown>,
): MetaMessage {
  return { kind: "meta", fromSiteId, state };
}

export function makeWelcomeMessage(
  assignedSiteId: SiteId,
  role: Role,
  activeSites: Array<{ siteId: SiteId; role: Role }>,
  _timestamp?: number,
): WelcomeMessage {
  return { kind: "welcome", assignedSiteId, role, activeSites };
}

export function makeErrorMessage(
  code: ErrorCode,
  message: string,
  fatal?: boolean,
): ErrorMessage {
  return { kind: "error", code, message, fatal };
}

export function makeSiteJoinedMessage(
  siteId: SiteId,
  role: Role,
): SiteJoinedMessage {
  return { kind: "site_joined", siteId, role };
}

export function makeSiteLeftMessage(siteId: SiteId): SiteLeftMessage {
  return { kind: "site_left", siteId };
}

export function makeMintTokenRequest(
  siteId: SiteId,
  role: Role,
): MintTokenRequest {
  return { kind: "mint_token", siteId, role };
}

export function makeMintTokenResponse(
  siteId: SiteId,
  role: Role,
  token: string,
): MintTokenResponse {
  return { kind: "token_minted", siteId, role, token };
}

/** Create a ClearLogRequest. Sent by the Owner to reset the relay op log. */
export function makeClearLogRequest(): ClearLogRequest {
  return { kind: "clear_log" };
}

/** Create a LogClearedMessage. Broadcast by the relay to all clients after clearing the log. */
export function makeLogClearedMessage(): LogClearedMessage {
  return { kind: "log_cleared" };
}

// ── Narrowing helpers ────────────────────────────────────────────────────────

export function validateOpMessage(msg: WireMessage): OpMessage | undefined {
  return msg.kind === "op" ? msg : undefined;
}

export function validateMetaMessage(
  msg: WireMessage,
): MetaMessage | undefined {
  return msg.kind === "meta" ? msg : undefined;
}

// ── Serialisation helpers ────────────────────────────────────────────────────

/** Serialise a WireMessage to a JSON string for WebSocket transmission. */
export function encodeMessage(msg: WireMessage): string {
  return JSON.stringify(msg);
}

/** Alias kept for symmetry with encodeMessage. */
export function serializeWireMessage(msg: WireMessage): string {
  return JSON.stringify(msg);
}

/**
 * Parse a raw WebSocket string into a WireMessage.
 * Returns null if the string is not valid JSON or lacks a `kind` field.
 */
export function parseWireMessage(raw: string): WireMessage | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "kind" in parsed &&
      typeof (parsed as Record<string, unknown>)["kind"] === "string"
    ) {
      return parsed as WireMessage;
    }
    return null;
  } catch {
    return null;
  }
}