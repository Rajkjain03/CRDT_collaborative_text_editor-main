/**
 * tests/roles.test.ts — Unit tests for role permissions and token mint/validate.
 */

import { Role, canInsert, canDelete, canChangeRoles, mintToken, validateToken } from "../shared/roles.ts";
import * as crypto from "crypto";

describe("Permission checks", () => {
  test("canInsert returns true for Owner", () => {
    expect(canInsert(Role.Owner)).toBe(true);
  });

  test("canInsert returns true for Editor", () => {
    expect(canInsert(Role.Editor)).toBe(true);
  });

  test("canInsert returns false for Viewer", () => {
    expect(canInsert(Role.Viewer)).toBe(false);
  });

  test("canDelete returns true for Owner", () => {
    expect(canDelete(Role.Owner)).toBe(true);
  });

  test("canDelete returns true for Editor", () => {
    expect(canDelete(Role.Editor)).toBe(true);
  });

  test("canDelete returns false for Viewer", () => {
    expect(canDelete(Role.Viewer)).toBe(false);
  });

  test("canChangeRoles returns true only for Owner", () => {
    expect(canChangeRoles(Role.Owner)).toBe(true);
    expect(canChangeRoles(Role.Editor)).toBe(false);
    expect(canChangeRoles(Role.Viewer)).toBe(false);
  });
});

describe("Token mint / validate", () => {
  const secret = crypto.randomBytes(32).toString("hex");

  test("mintToken → validateToken roundtrip returns correct siteId and role", () => {
    const siteId = "site-abc-123";
    const role = Role.Editor;
    const token = mintToken(siteId, role, secret);
    const result = validateToken(token, secret);

    expect(result).not.toBeNull();
    expect(result!.siteId).toBe(siteId);
    expect(result!.role).toBe(role);
  });

  test("roundtrip works for all roles", () => {
    for (const role of [Role.Owner, Role.Editor, Role.Viewer]) {
      const token = mintToken("site-x", role, secret);
      const result = validateToken(token, secret);
      expect(result).not.toBeNull();
      expect(result!.role).toBe(role);
    }
  });

  test("validateToken returns null for tampered payload", () => {
    const token = mintToken("site-1", Role.Editor, secret);
    const [payloadB64, sig] = token.split(".");

    // Tamper with the payload
    const tampered = Buffer.from(
      JSON.stringify({ siteId: "hacker", role: "owner", sessionId: "x", expiresAt: Date.now() + 99999999 })
    ).toString("base64url");

    const result = validateToken(`${tampered}.${sig}`, secret);
    expect(result).toBeNull();
  });

  test("validateToken returns null for tampered signature", () => {
    const token = mintToken("site-1", Role.Editor, secret);
    const [payloadB64] = token.split(".");

    const result = validateToken(`${payloadB64}.tampered-signature`, secret);
    expect(result).toBeNull();
  });

  test("validateToken returns null for expired token", () => {
    // Mint a token that has already expired (negative lifetime)
    const token = mintToken("site-1", Role.Editor, secret, -1000);
    const result = validateToken(token, secret);
    expect(result).toBeNull();
  });

  test("validateToken returns null for wrong secret", () => {
    const token = mintToken("site-1", Role.Editor, secret);
    const wrongSecret = crypto.randomBytes(32).toString("hex");
    const result = validateToken(token, wrongSecret);
    expect(result).toBeNull();
  });

  test("validateToken returns null for garbage input", () => {
    expect(validateToken("", secret)).toBeNull();
    expect(validateToken("not-a-token", secret)).toBeNull();
    expect(validateToken("a.b.c", secret)).toBeNull();
    expect(validateToken("{}", secret)).toBeNull();
    expect(validateToken("abc.def", secret)).toBeNull();
  });

  test("token contains expected structure (two dot-separated parts)", () => {
    const token = mintToken("site-1", Role.Owner, secret);
    const parts = token.split(".");
    expect(parts.length).toBe(2);
    // Both parts should be non-empty base64url strings
    expect(parts[0]!.length).toBeGreaterThan(0);
    expect(parts[1]!.length).toBeGreaterThan(0);
  });
});
