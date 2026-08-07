import { describe, expect, it } from "vitest";
import { classifyMail, extractUnsubscribeUrl, extractVerificationCode, resolveForwardedVia } from "./mail-classifier.js";

describe("mail classification", () => {
  it("matches primary and alias recipients in To or Cc exactly and case-insensitively", () => {
    const base = { accountEmail: "main@example.test", aliases: ["alias@example.test"], text: "", html: null };
    expect(classifyMail({ ...base, to: [{ address: " MAIN@EXAMPLE.TEST " }], cc: [] }).labels).toEqual([]);
    expect(classifyMail({ ...base, to: [], cc: [{ address: "alias@example.test" }] }).labels).toEqual([]);
    expect(classifyMail({ ...base, to: [{ address: "main+tag@example.test" }], cc: [] }).labels).toEqual(["forwarded"]);
    expect(classifyMail({ ...base, to: [], cc: [] }).labels).toEqual(["forwarded"]);
  });

  it("resolves the nearest forwarding mailbox from a provider-neutral delivery chain", async () => {
    const result = await resolveForwardedVia({
      accountEmail: "inbox@domain-c.test", aliases: [], to: [{ address: "source@domain-a.test" }], cc: [],
      headers: Buffer.from([
        "Delivered-To: inbox@domain-c.test",
        "Delivered-To: relay@domain-b.test",
        "Delivered-To: source@domain-a.test",
        "To: source@domain-a.test",
        ""
      ].join("\r\n"))
    });

    expect(result).toEqual({ address: "relay@domain-b.test", source: "delivery-chain" });
  });

  it("uses explicit resender evidence before other forwarding headers", async () => {
    const result = await resolveForwardedVia({
      accountEmail: "inbox@domain-c.test", aliases: [], to: [{ address: "source@domain-a.test" }], cc: [],
      headers: Buffer.from([
        "Resent-Sender: relay@domain-b.test",
        "Resent-From: delegated@domain-b.test",
        "X-Forwarded-For: other@domain-d.test",
        ""
      ].join("\r\n"))
    });

    expect(result).toEqual({ address: "relay@domain-b.test", source: "resent" });
  });

  it("does not guess when the highest available evidence has multiple candidates", async () => {
    const result = await resolveForwardedVia({
      accountEmail: "inbox@domain-c.test", aliases: [], to: [{ address: "source@domain-a.test" }], cc: [],
      headers: Buffer.from([
        "X-Forwarded-For: relay@domain-b.test, other@domain-d.test",
        "Delivered-To: relay@domain-b.test",
        ""
      ].join("\r\n"))
    });

    expect(result).toBeNull();
  });

  it("falls back only to one unique non-local recipient", async () => {
    const base = { accountEmail: "inbox@domain-c.test", aliases: ["alias@domain-c.test"], headers: undefined };
    await expect(resolveForwardedVia({ ...base, to: [{ address: " Relay@Domain-B.test " }], cc: [] }))
      .resolves.toEqual({ address: "relay@domain-b.test", source: "recipient" });
    await expect(resolveForwardedVia({ ...base, to: [{ address: "relay@domain-b.test" }, { address: "other@domain-d.test" }], cc: [] }))
      .resolves.toBeNull();
    await expect(resolveForwardedVia({ ...base, to: [{ address: "alias@domain-c.test" }], cc: [] }))
      .resolves.toBeNull();
  });

  it("skips local aliases in a BCC delivery chain regardless of address case", async () => {
    const result = await resolveForwardedVia({
      accountEmail: "inbox@domain-c.test", aliases: ["alias@domain-c.test"], to: [], cc: [],
      headers: Buffer.from([
        "Delivered-To: ALIAS@DOMAIN-C.TEST",
        "Original-Recipient: rfc822; Relay@Domain-B.test",
        ""
      ].join("\r\n"))
    });

    expect(result).toEqual({ address: "relay@domain-b.test", source: "delivery-chain" });
  });

  it("does not infer a forwarding mailbox from ambiguous recipients or sender headers", async () => {
    const result = await resolveForwardedVia({
      accountEmail: "inbox@domain-c.test", aliases: [],
      to: [{ address: "list@domain-a.test" }], cc: [{ address: "member@domain-b.test" }],
      headers: Buffer.from([
        "X-Forwarded-For: not-an-address",
        "From: source@domain-a.test",
        "Sender: sender@domain-a.test",
        "Return-Path: bounce@domain-a.test",
        ""
      ].join("\r\n"))
    });

    expect(result).toBeNull();
  });

  it("extracts the nearest 4-8 character verification code around a keyword", () => {
    expect(extractVerificationCode("订单 778899，验证码 AB12CD，请勿泄露")).toBe("AB12CD");
    expect(extractVerificationCode("654321 is your verification code; backup 112233")).toBe("112233");
    expect(extractVerificationCode("订单号 778899 已创建")).toBeNull();
    expect(extractVerificationCode("验证码 ONLYWORD")).toBeNull();
  });

  it("extracts only contextual safe HTTP unsubscribe links in document order", () => {
    const html = '<p><a data-safe-href="https://example.test/account">Account</a></p>'
      + '<p>Unsubscribe <a data-safe-href="https://example.test/first">here</a></p>'
      + '<p>退订 <a data-safe-href="https://example.test/second">第二个</a></p>';
    expect(extractUnsubscribeUrl(html)).toBe("https://example.test/first");
    expect(extractUnsubscribeUrl('<p>退订 <a data-safe-href="javascript:alert(1)">here</a></p>')).toBeNull();
    expect(extractUnsubscribeUrl('<p>退订 <a data-safe-href="mailto:list@example.test">here</a></p>')).toBeNull();
    expect(extractUnsubscribeUrl('<p>退订</p><p><a data-safe-href="https://example.test/other">Account</a></p>')).toBeNull();
  });
});
