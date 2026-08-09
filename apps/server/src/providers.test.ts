import { describe, expect, it } from "vitest";
import { detectProvider, resolveImapConfig, resolveSmtpConfig } from "./providers.js";

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

  it.each([
    ["qq", "smtp.qq.com", 465, true],
    ["gmail", "smtp.gmail.com", 465, true],
    ["icloud", "smtp.mail.me.com", 587, false],
    ["outlook", "smtp-mail.outlook.com", 587, false],
    ["qq-enterprise", "smtp.exmail.qq.com", 465, true],
    ["163", "smtp.163.com", 465, true]
  ] as const)("resolves the %s SMTP preset", (provider, host, port, secure) => {
    expect(resolveSmtpConfig(provider)).toEqual({ host, port, secure });
  });

  it("allows custom SMTP and leaves an unconfigured custom account receive-only", () => {
    expect(resolveSmtpConfig("custom")).toBeNull();
    expect(resolveSmtpConfig("custom", null)).toBeNull();
    expect(resolveSmtpConfig("custom", { host: "smtp.example.com", port: 587, secure: false }))
      .toEqual({ host: "smtp.example.com", port: 587, secure: false });
    expect(() => resolveSmtpConfig("custom", { port: 587, secure: false })).toThrow("SMTP 主机");
  });
});
