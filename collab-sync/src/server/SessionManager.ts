/**
 * server/SessionManager.ts — Site identity and token lifecycle management.
 *
 * Manages the per-session secret, mints/validates tokens, and tracks which
 * sites are currently active in the collaborative session.
 */

import * as crypto from "crypto";
import type { SiteId } from "../../../crdt-engine";
import { Role, mintToken, validateToken } from "../../shared/roles.ts";

export class SessionManager {
  private sessionSecret: string;
  private knownSites: Map<SiteId, Role>;

  constructor() {
    // Generate a strong random secret for this session
    this.sessionSecret = crypto.randomBytes(32).toString("hex");
    this.knownSites = new Map();
  }

  // ─── Session initialisation ──────────────────────────────────────────────

  /**
   * Initialise a new collaborative session.
   * Generates an owner site ID and mints the owner token.
   *
   * @returns The owner's token and the session secret (for diagnostics/testing).
   */
  initSession(): { ownerSiteId: SiteId; ownerToken: string; sessionSecret: string } {
    const ownerSiteId = crypto.randomUUID();
    this.knownSites.set(ownerSiteId, Role.Owner);

    const ownerToken = mintToken(ownerSiteId, Role.Owner, this.sessionSecret);

    return {
      ownerSiteId,
      ownerToken,
      sessionSecret: this.sessionSecret,
    };
  }

  // ─── Token operations ────────────────────────────────────────────────────

  /**
   * Mint a new token for a site with the given role.
   * The site is automatically registered.
   */
  mintToken(siteId: SiteId, role: Role): string {
    this.knownSites.set(siteId, role);
    return mintToken(siteId, role, this.sessionSecret);
  }

  /**
   * Validate an incoming token against the session secret.
   * Returns { siteId, role } if valid, null otherwise.
   */
  validateToken(token: string): { siteId: SiteId; role: Role } | null {
    return validateToken(token, this.sessionSecret);
  }

  // ─── Site registry ───────────────────────────────────────────────────────

  /**
   * Register a site with a given role.
   * Called during join handshake after token validation.
   */
  registerSite(siteId: SiteId, role: Role): void {
    this.knownSites.set(siteId, role);
  }

  /**
   * Remove a site from the active registry.
   * Called on disconnect.
   */
  deregisterSite(siteId: SiteId): void {
    this.knownSites.delete(siteId);
  }

  /**
   * Get the role of a registered site.
   */
  getRole(siteId: SiteId): Role | undefined {
    return this.knownSites.get(siteId);
  }

  /**
   * Returns all currently registered site IDs.
   */
  getActiveSites(): SiteId[] {
    return [...this.knownSites.keys()];
  }

  /**
   * Expose the session secret (for testing / owner token distribution).
   */
  getSessionSecret(): string {
    return this.sessionSecret;
  }
}
