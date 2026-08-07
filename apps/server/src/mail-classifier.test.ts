import { describe, expect, it } from "vitest";
import { classifyMail, extractUnsubscribeUrl, extractVerificationCode } from "./mail-classifier.js";

describe("mail classification", () => {
  it("matches primary and alias recipients in To or Cc exactly and case-insensitively", () => {
    const base = { accountEmail: "main@example.test", aliases: ["alias@example.test"], text: "", html: null };
    expect(classifyMail({ ...base, to: [{ address: " MAIN@EXAMPLE.TEST " }], cc: [] }).labels).toEqual([]);
    expect(classifyMail({ ...base, to: [], cc: [{ address: "alias@example.test" }] }).labels).toEqual([]);
    expect(classifyMail({ ...base, to: [{ address: "main+tag@example.test" }], cc: [] }).labels).toEqual(["forwarded"]);
    expect(classifyMail({ ...base, to: [], cc: [] }).labels).toEqual(["forwarded"]);
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
