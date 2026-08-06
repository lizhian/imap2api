import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { CryptoService } from "./crypto.js";

describe("CryptoService", () => {
  it("round-trips structured values and detects tampering", () => {
    const crypto = CryptoService.derive("a".repeat(32), randomBytes(32));
    const encrypted = crypto.encrypt({ subject: "秘密主题", count: 2 });
    expect(encrypted.toString("utf8")).not.toContain("秘密主题");
    expect(crypto.decrypt(encrypted)).toEqual({ subject: "秘密主题", count: 2 });
    encrypted[encrypted.length - 1] = encrypted[encrypted.length - 1]! ^ 1;
    expect(() => crypto.decrypt(encrypted)).toThrow();
  });

  it("creates stable, normalized fingerprints", () => {
    const crypto = CryptoService.derive("b".repeat(32), Buffer.alloc(32, 1));
    expect(crypto.fingerprint(" User@Example.com ")).toBe(crypto.fingerprint("user@example.com"));
    expect(crypto.fingerprint("other@example.com")).not.toBe(crypto.fingerprint("user@example.com"));
  });
});
