import { describe, expect, it } from "vitest";
import { detectProvider, resolveImapConfig } from "./providers.js";

describe("provider presets", () => {
  it.each([
    ["a@qq.com", "qq", "imap.qq.com"],
    ["a@gmail.com", "gmail", "imap.gmail.com"],
    ["a@icloud.com", "icloud", "imap.mail.me.com"],
    ["a@outlook.com", "outlook", "outlook.office365.com"],
    ["a@163.com", "163", "imap.163.com"]
  ])("detects %s", (email, provider, host) => {
    expect(detectProvider(email)).toBe(provider);
    expect(resolveImapConfig(email)).toMatchObject({ provider, host, port: 993, secure: true });
  });

  it("requires a host for unknown providers", () => {
    expect(() => resolveImapConfig("a@example.com")).toThrow("无法识别");
    expect(resolveImapConfig("a@example.com", { provider: "custom", host: "mail.example.com" })).toMatchObject({ host: "mail.example.com" });
  });
});
