/**
 * shared/roles.ts — Role enum, permission checks, and HMAC-SHA256 token auth.
 *
 * Tokens are signed with a per-session secret held only by the relay.
 * Format: base64(JSON payload) + "." + base64(HMAC-SHA256 signature)
 */

import * as crypto from "crypto";
import type { SiteId } from "../../crdt-engine/src/types.ts";

// ── Role enum ────────────────────────────────────────────────────────────────

export enum Role {
  Owner = "owner",
  Editor = "editor",
  Viewer = "viewer",
}

// ── Permission checks ────────────────────────────────────────────────────────

/** Owner and Editor may insert characters. */
export function canInsert(role: Role): boolean {
  return role === Role.Owner || role === Role.Editor;
}

/** Owner and Editor may delete characters. */
export function canDelete(role: Role): boolean {
  return role === Role.Owner || role === Role.Editor;
}

/**
 * Returns true if the role may perform privileged session operations:
 * minting tokens for new sites and resetting the relay op log (clear_log).
 * Currently only Owner.
 */
export function canChangeRoles(role: Role): boolean {
  return role === Role.Owner;
}

// ── Token types ──────────────────────────────────────────────────────────────

export type TokenPayload = {
  siteId: SiteId;
  role: Role;
  sessionId: string;
  expiresAt: number; // Unix ms
};

// ── Token mint / validate ────────────────────────────────────────────────────

const TOKEN_LIFETIME_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Create an HMAC-SHA256 signed token.
 *
 * @param siteId        Site this token is issued to.
 * @param role          Granted role.
 * @param sessionSecret The relay's per-session secret.
 * @param lifetimeMs    Token lifetime in milliseconds (default 24h).
 * @returns             Signed token string: base64(payload).base64(sig)
 */
export function mintToken(
  siteId: SiteId,
  role: Role,
  sessionSecret: string,
  lifetimeMs: number = TOKEN_LIFETIME_MS
): string {
  const payload: TokenPayload = {
    siteId,
    role,
    sessionId: crypto.randomUUID(),
    expiresAt: Date.now() + lifetimeMs,
  };

  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto
    .createHmac("sha256", sessionSecret)
    .update(payloadB64)
    .digest("base64url");

  return `${payloadB64}.${sig}`;
}

/**
 * Validate a signed token. Returns the decoded payload if valid, null otherwise.
 *
 * Checks:
 * 1. Token has exactly two dot-separated parts
 * 2. HMAC signature matches
 * 3. Token has not expired
 * 4. Payload contains required fields
 */
export function validateToken(
  token: string,
  sessionSecret: string
): { siteId: SiteId; role: Role } | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 2) return null;

    const [payloadB64, sig] = parts as [string, string];

    // Verify HMAC
    const expectedSig = crypto
      .createHmac("sha256", sessionSecret)
      .update(payloadB64)
      .digest("base64url");

    if (sig !== expectedSig) return null;

    // Decode payload
    const payload: unknown = JSON.parse(
      Buffer.from(payloadB64, "base64url").toString("utf-8")
    );

    if (typeof payload !== "object" || payload === null) return null;

    const p = payload as Record<string, unknown>;
    if (typeof p["siteId"] !== "string") return null;
    if (typeof p["role"] !== "string") return null;
    if (typeof p["expiresAt"] !== "number") return null;

    // Check expiry
    if ((p["expiresAt"] as number) < Date.now()) return null;

    // Validate role is a known enum value
    const roleValues: string[] = Object.values(Role);
    if (!roleValues.includes(p["role"] as string)) return null;

    return {
      siteId: p["siteId"] as SiteId,
      role: p["role"] as Role,
    };
  } catch {
    return null;
  }
}