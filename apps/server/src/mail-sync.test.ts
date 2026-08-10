import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ImapFlow } from "imapflow";
import { AppDatabase } from "./database.js";
import { EventBroker } from "./events.js";
import { FORWARDING_HEADER_FIELDS } from "./mail-classifier.js";
import { cleanHtml, MailboxSynchronizer } from "./mail-sync.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("mail HTML sanitization", () => {
  it("preserves common email layout and styling", () => {
    const html = cleanHtml(`<!doctype html><html lang="zh"><head><title>hidden</title><style>
      .hero { color: #123456; padding: 12px; } @media (max-width: 600px) { .hero { width: 100%; } }
    </style></head><body class="mail" style="background:#fff"><table width="640" cellpadding="8"><tr><td class="hero" align="center"><font face="serif" color="#123456">Hello</font></td></tr></table></body></html>`);

    expect(html).toContain("<style>");
    expect(html).toContain("@media (max-width: 600px)");
    expect(html).toContain('<div class="mail" style="background:#fff">');
    expect(html).toContain('<table width="640" cellpadding="8">');
    expect(html).toContain('<td class="hero" align="center">');
    expect(html).toContain('<font face="serif" color="#123456">Hello</font>');
    expect(html).not.toContain("hidden");
  });

  it("removes active content, dangerous attributes, URLs and remote images", () => {
    const html = cleanHtml(`<script>alert(1)</script><form action="https://evil.test"><input autofocus></form>
      <iframe src="https://evil.test"></iframe><object data="https://evil.test"></object><svg onload="alert(1)"><circle /></svg>
      <a href="javascript:alert(1)" onclick="alert(1)">open</a><a href="//evil.test">relative</a><a href="https://example.test/path?q=1">safe</a>
      <img src="https://tracker.test/pixel.gif" srcset="https://tracker.test/2x 2x" onerror="alert(1)" alt="blocked" width="1" height="1"><img src="data:image/svg+xml,bad" alt="unsafe">`);

    expect(html).not.toMatch(/script|form|input|iframe|object|svg|circle|onclick|onerror|javascript:|srcset/i);
    expect(html).toContain("<a>open</a><a>relative</a>");
    expect(html).toContain('<a data-safe-href="https://example.test/path?q=1">safe</a>');
    expect(html).toContain('<img alt="blocked" width="1" height="1" data-remote-src="https://tracker.test/pixel.gif" />');
    expect(html).toContain('<img alt="unsafe" />');
  });

  it("localizes approved CID images while leaving remote images blocked", () => {
    const dataUrl = "data:image/png;base64,iVBORw0KGgo=";
    const html = cleanHtml(
      '<img src="cid:LOGO@example.test" alt="logo"><div style="background-image:url(cid:logo@example.test)"></div><img src="https://tracker.test/a.png" alt="remote">',
      new Map([["logo@example.test", dataUrl]])
    );

    expect(html).toContain(`src="${dataUrl}"`);
    expect(html).toContain('alt="logo"');
    expect(html).toContain(`background-image:url(${dataUrl})`);
    expect(html).toContain('<img alt="remote" data-remote-src="https://tracker.test/a.png" />');
  });

  it("fetches bounded safe CID parts and rejects SVG and oversized parts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "email2api-mail-html-"));
    dirs.push(dir);
    const db = new AppDatabase(join(dir, "test.db"), "t".repeat(32));
    const publicAccount = db.createAccount({ email: "mail@qq.com", password: "authorization-code" });
    const account = db.getAccount(publicAccount.id)!;
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const requestedParts: string[] = [];
    let requestedHeaders: string[] | undefined;
    let failBodyFetch = false;
    const client = {
      mailbox: { uidValidity: 1n, exists: 1 },
      getMailboxLock: async () => ({ release: () => undefined }),
      fetchAll: async (_range: string, query: { headers?: string[] }) => {
        requestedHeaders = query.headers;
        return [{
        uid: 1, flags: new Set<string>(), envelope: {
          subject: "Styled", to: [{ address: "source@domain-a.test" }], date: new Date("2026-01-01T00:00:00Z")
        },
        headers: Buffer.from("Delivered-To: mail@qq.com\r\nDelivered-To: relay@domain-b.test\r\nTo: source@domain-a.test\r\n"),
        internalDate: new Date("2026-01-01T00:00:00Z"),
        bodyStructure: { type: "multipart/mixed", childNodes: [
          { type: "multipart/related", childNodes: [
            { part: "1", type: "text/html", encoding: "7bit", parameters: { charset: "utf-8" } },
            { part: "2", type: "image/png", encoding: "base64", id: "<logo@example.test>", size: 12, disposition: "inline", dispositionParameters: { filename: "logo.png" } },
            { part: "3", type: "image/svg+xml", encoding: "base64", id: "<unsafe@example.test>", size: 100, disposition: "inline" },
            { part: "4", type: "image/png", encoding: "base64", id: "<large@example.test>", size: 3 * 1024 * 1024, disposition: "inline" },
            { part: "9", type: "image/png", encoding: "base64", id: "<related@example.test>", size: 12, parameters: { name: "related.png" } }
          ] },
          { part: "5", type: "application/pdf", encoding: "base64", size: 1024, disposition: "attachment", dispositionParameters: { filename: "report.pdf" } },
          { part: "6", type: "application/pdf", encoding: "base64", size: 2048, disposition: "attachment", dispositionParameters: { filename: "report.pdf" } },
          { part: "7", type: "application/octet-stream", encoding: "base64", size: 0, disposition: "attachment" },
          { part: "8", type: "message/rfc822", encoding: "7bit", size: 4096, disposition: "attachment", dispositionParameters: { filename: "original.eml" }, childNodes: [
            { part: "8.1", type: "application/zip", encoding: "base64", size: 100, disposition: "attachment", dispositionParameters: { filename: "nested.zip" } }
          ] },
          { part: "10", type: "image/png", encoding: "base64", size: 12, parameters: { name: "photo.png" } }
        ] }
      }];
      },
      fetchOne: async (_uid: number, query: { bodyParts: string[] }) => {
        requestedParts.push(...query.bodyParts);
        if (failBodyFetch) throw new Error("body fetch failed");
        return { bodyParts: new Map([
          ["1", Buffer.from('<style>.logo{width:32px}</style><img class="logo" src="cid:logo@example.test"><img src="cid:related@example.test"><img src="https://images.example.test/a.png"><a href="https://example.test">Open</a><img src="cid:unsafe@example.test"><img src="cid:large@example.test">')],
          ["2", Buffer.from(png.toString("base64"))],
          ["9", Buffer.from(png.toString("base64"))]
        ]) };
      }
    };
    const broker = new EventBroker();
    const updatedIds: string[][] = [];
    broker.subscribe((published) => { if (published.event.type === "messages.changed" && published.event.updatedIds.length) updatedIds.push(published.event.updatedIds); });
    const synchronizer = new MailboxSynchronizer(db, broker);

    await synchronizer.syncFolder(client as unknown as ImapFlow, account, "inbox", "INBOX", 100);

    const summary = db.listMessages({ accountId: account.id, view: "all", limit: 50 }).items[0]!;
    const detail = db.getMessage(summary.id)!;
    expect(requestedHeaders).toEqual([...FORWARDING_HEADER_FIELDS]);
    expect(requestedParts).toEqual(["1", "2", "9"]);
    expect(detail.html).toContain("data:image/png;base64,");
    expect(detail.html).toContain('data-remote-src="https://images.example.test/a.png"');
    expect(detail.html).toContain('data-safe-href="https://example.test/"');
    expect(detail.html).toContain("<style>.logo{width:32px}</style>");
    expect(detail.html).not.toMatch(/unsafe@example\.test|large@example\.test/);
    expect(detail.labels).toEqual(["forwarded"]);
    expect(detail.forwardedVia).toBe("relay@domain-b.test");
    expect(detail.attachments.map((attachment) => attachment.filename)).toEqual(["report.pdf", "report.pdf", "附件-1", "original.eml", "photo.png"]);
    expect(detail.attachments.every((attachment) => attachment.id)).toBe(true);
    expect(detail.attachments.map((attachment) => attachment.size)).toEqual([1024, 2048, 0, 4096, 12]);

    db.upsertMessage({
      id: summary.id, accountId: account.id, folder: "inbox", mailboxPath: "INBOX", uid: 1, uidValidity: "1",
      read: false, displayTime: "2026-01-01T00:00:00.000Z",
      content: {
        htmlPolicyVersion: 2, classificationVersion: 3, attachmentMetadataVersion: 1,
        subject: detail.subject, from: detail.from, to: detail.to, cc: detail.cc,
        preview: detail.preview, text: detail.text, html: detail.html,
        attachments: [{
          id: "legacy-inline", part: "2", filename: "logo.png", contentType: "image/png", size: 12, encoding: "base64"
        }],
        labels: detail.labels, verificationCode: detail.verificationCode, unsubscribeUrl: detail.unsubscribeUrl,
        forwardedVia: detail.forwardedVia, forwardedViaSource: "delivery-chain"
      }
    });
    requestedParts.splice(0);
    await synchronizer.syncFolder(client as unknown as ImapFlow, account, "inbox", "INBOX", 100);
    expect(requestedParts).toEqual([]);
    expect(db.getMessage(summary.id)?.attachments.map((attachment) => attachment.filename))
      .toEqual(["report.pdf", "report.pdf", "附件-1", "original.eml", "photo.png"]);
    expect(db.getKnownMessage(account.id, "INBOX", "1", 1)?.attachmentMetadataVersion).toBe(2);

    db.upsertMessage({
      id: summary.id, accountId: account.id, folder: "inbox", mailboxPath: "INBOX", uid: 1, uidValidity: "1",
      read: false, displayTime: "2026-01-01T00:00:00.000Z",
      content: {
        htmlPolicyVersion: 2, classificationVersion: 0, subject: detail.subject, from: detail.from, to: detail.to, cc: detail.cc,
        preview: detail.preview, text: detail.text, html: detail.html, attachments: detail.attachments, labels: detail.labels,
        verificationCode: detail.verificationCode, unsubscribeUrl: detail.unsubscribeUrl,
        forwardedVia: detail.forwardedVia, forwardedViaSource: "delivery-chain"
      }
    });
    await synchronizer.syncFolder(client as unknown as ImapFlow, account, "inbox", "INBOX", 100);
    expect(requestedParts).toEqual([]);
    expect(db.getKnownMessage(account.id, "INBOX", "1", 1)?.classificationVersion).toBe(3);

    const legacyContent = { subject: "Legacy", from: [], to: [], cc: [], preview: "legacy", text: "legacy", html: "<p>legacy</p>", attachments: [] };
    db.upsertMessage({ id: summary.id, accountId: account.id, folder: "inbox", mailboxPath: "INBOX", uid: 1, uidValidity: "1", read: false, displayTime: "2026-01-01T00:00:00.000Z", content: legacyContent });
    expect(db.getKnownMessage(account.id, "INBOX", "1", 1)?.htmlPolicyVersion).toBe(0);
    await synchronizer.syncFolder(client as unknown as ImapFlow, account, "inbox", "INBOX", 100);
    expect(requestedParts).toEqual(["1", "2", "9"]);
    expect(updatedIds.at(-1)).toEqual([summary.id]);
    expect(db.getKnownMessage(account.id, "INBOX", "1", 1)?.htmlPolicyVersion).toBe(2);

    db.upsertMessage({ id: summary.id, accountId: account.id, folder: "inbox", mailboxPath: "INBOX", uid: 1, uidValidity: "1", read: false, displayTime: "2026-01-01T00:00:00.000Z", content: { ...legacyContent, html: "<p>preserved</p>" } });
    failBodyFetch = true;
    await expect(synchronizer.syncFolder(client as unknown as ImapFlow, account, "inbox", "INBOX", 100)).rejects.toThrow("body fetch failed");
    expect(db.getMessage(summary.id)?.html).toBe("<p>preserved</p>");
    db.close();
  });

  it("backfills a version 2 forwarding result from metadata headers without fetching a body", async () => {
    const dir = mkdtempSync(join(tmpdir(), "email2api-mail-forwarding-"));
    dirs.push(dir);
    const db = new AppDatabase(join(dir, "test.db"), "t".repeat(32));
    const publicAccount = db.createAccount({
      email: "503457938@qq.com", password: "authorization-code",
      imap: { provider: "custom", host: "imap.qq.com", port: 993, secure: true }
    });
    const account = db.getAccount(publicAccount.id)!;
    let bodyFetches = 0;
    const client = {
      mailbox: { uidValidity: 1n, exists: 1 },
      getMailboxLock: async () => ({ release: () => undefined }),
      fetchAll: async () => [{
        uid: 1, flags: new Set<string>(),
        envelope: {
          subject: "Header only", to: [{ address: "commandcode-proxy@noreply.github.com" }],
          cc: [{ address: "lizhiangg@gmail.com" }, { address: "author@noreply.github.com" }],
          date: new Date("2026-01-01T00:00:00Z")
        },
        headers: Buffer.from([
          "X-Forwarded-To: 503457938@qq.com",
          "X-Forwarded-For: lizhiangg@gmail.com 503457938@qq.com",
          "Delivered-To: lizhiangg@gmail.com",
          "To: commandcode-proxy@noreply.github.com",
          "Cc: lizhiangg@gmail.com, author@noreply.github.com",
          ""
        ].join("\r\n")),
        internalDate: new Date("2026-01-01T00:00:00Z"), bodyStructure: undefined
      }],
      fetchOne: async () => { bodyFetches += 1; return false; }
    };

    await new MailboxSynchronizer(db, new EventBroker()).syncFolder(
      client as unknown as ImapFlow, account, "inbox", "INBOX", 100
    );

    const message = db.listMessages({ accountId: account.id, view: "all", limit: 50 }).items[0]!;
    expect(bodyFetches).toBe(0);
    expect(message).toMatchObject({ labels: ["forwarded"], forwardedVia: "lizhiangg@gmail.com" });

    const detail = db.getMessage(message.id)!;
    db.upsertMessage({
      id: message.id, accountId: account.id, folder: "inbox", mailboxPath: "INBOX", uid: 1, uidValidity: "1",
      read: false, displayTime: "2026-01-01T00:00:00.000Z",
      content: {
        htmlPolicyVersion: detail.htmlPolicyVersion, classificationVersion: 2,
        subject: detail.subject, from: detail.from, to: detail.to, cc: detail.cc, preview: detail.preview,
        text: detail.text, html: detail.html, attachments: detail.attachments, labels: ["forwarded"],
        verificationCode: detail.verificationCode, unsubscribeUrl: detail.unsubscribeUrl,
        forwardedVia: null, forwardedViaSource: null
      }
    });

    await new MailboxSynchronizer(db, new EventBroker()).syncFolder(
      client as unknown as ImapFlow, account, "inbox", "INBOX", 100
    );

    expect(bodyFetches).toBe(0);
    expect(db.getKnownMessage(account.id, "INBOX", "1", 1)?.classificationVersion).toBe(3);
    expect(db.listMessages({ accountId: account.id, view: "all", limit: 50 }).items[0]?.forwardedVia)
      .toBe("lizhiangg@gmail.com");
    db.close();
  });
});
