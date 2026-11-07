/**
 * tests/sessionManager.test.ts — Unit tests for SessionManager.
 */

import { SessionManager } from "../src/server/SessionManager.ts";
import { Role, validateToken } from "../shared/roles.ts";

describe("SessionManager", () => {
  let sm: SessionManager;

  beforeEach(() => {
    sm = new SessionManager();
  });

  test("initSession returns non-empty ownerToken, ownerSiteId, and sessionSecret", () => {
    const { ownerSiteId, ownerToken, sessionSecret } = sm.initSession();

    expect(ownerSiteId).toBeTruthy();
    expect(ownerToken).toBeTruthy();
    expect(sessionSecret).toBeTruthy();
    expect(ownerToken.split(".").length).toBe(2);
  });

  test("owner token validates to role Owner", () => {
    const { ownerToken, sessionSecret } = sm.initSession();
    const result = validateToken(ownerToken, sessionSecret);

    expect(result).not.toBeNull();
    expect(result!.role).toBe(Role.Owner);
  });

  test("owner token validates via sm.validateToken()", () => {
    const { ownerToken } = sm.initSession();
    const result = sm.validateToken(ownerToken);

    expect(result).not.toBeNull();
    expect(result!.role).toBe(Role.Owner);
  });

  test("owner siteId is registered as active after initSession", () => {
    const { ownerSiteId } = sm.initSession();
    expect(sm.getActiveSites()).toContain(ownerSiteId);
    expect(sm.getRole(ownerSiteId)).toBe(Role.Owner);
  });

  test("registerSite + getRole returns correct role", () => {
    sm.registerSite("site-editor-1", Role.Editor);
    expect(sm.getRole("site-editor-1")).toBe(Role.Editor);

    sm.registerSite("site-viewer-1", Role.Viewer);
    expect(sm.getRole("site-viewer-1")).toBe(Role.Viewer);
  });

  test("deregisterSite removes the site from active list", () => {
    sm.registerSite("site-1", Role.Editor);
    expect(sm.getActiveSites()).toContain("site-1");

    sm.deregisterSite("site-1");
    expect(sm.getActiveSites()).not.toContain("site-1");
    expect(sm.getRole("site-1")).toBeUndefined();
  });

  test("getActiveSites returns all registered sites", () => {
    sm.registerSite("a", Role.Owner);
    sm.registerSite("b", Role.Editor);
    sm.registerSite("c", Role.Viewer);

    const sites = sm.getActiveSites();
    expect(sites).toContain("a");
    expect(sites).toContain("b");
    expect(sites).toContain("c");
    expect(sites.length).toBe(3);
  });

  test("mintToken for a registered editor validates correctly", () => {
    const siteId = "editor-site";
    const token = sm.mintToken(siteId, Role.Editor);
    const result = sm.validateToken(token);

    expect(result).not.toBeNull();
    expect(result!.siteId).toBe(siteId);
    expect(result!.role).toBe(Role.Editor);
  });

  test("mintToken auto-registers the site", () => {
    const siteId = "auto-reg-site";
    sm.mintToken(siteId, Role.Viewer);
    expect(sm.getActiveSites()).toContain(siteId);
    expect(sm.getRole(siteId)).toBe(Role.Viewer);
  });

  test("each SessionManager instance has a unique secret", () => {
    const sm2 = new SessionManager();
    expect(sm.getSessionSecret()).not.toBe(sm2.getSessionSecret());
  });
});
