import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ImapFlow } from "imapflow";
import { AppDatabase } from "./database.js";
import { EventBroker } from "./events.js";
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
    const dir = mkdtempSync(join(tmpdir(), "imap2api-mail-html-"));
    dirs.push(dir);
    const db = new AppDatabase(join(dir, "test.db"), "t".repeat(32));
    const publicAccount = db.createAccount({ email: "mail@qq.com", password: "authorization-code" });
    const account = db.getAccount(publicAccount.id)!;
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const requestedParts: string[] = [];
    let failBodyFetch = false;
    const client = {
      mailbox: { uidValidity: 1n, exists: 1 },
      getMailboxLock: async () => ({ release: () => undefined }),
      fetchAll: async () => [{
        uid: 1, flags: new Set<string>(), envelope: { subject: "Styled", date: new Date("2026-01-01T00:00:00Z") },
        internalDate: new Date("2026-01-01T00:00:00Z"),
        bodyStructure: { type: "multipart/related", childNodes: [
          { part: "1", type: "text/html", encoding: "7bit", parameters: { charset: "utf-8" } },
          { part: "2", type: "image/png", encoding: "base64", id: "<logo@example.test>", size: 12, disposition: "inline" },
          { part: "3", type: "image/svg+xml", encoding: "base64", id: "<unsafe@example.test>", size: 100, disposition: "inline" },
          { part: "4", type: "image/png", encoding: "base64", id: "<large@example.test>", size: 3 * 1024 * 1024, disposition: "inline" }
        ] }
      }],
      fetchOne: async (_uid: number, query: { bodyParts: string[] }) => {
        requestedParts.push(...query.bodyParts);
        if (failBodyFetch) throw new Error("body fetch failed");
        return { bodyParts: new Map([
          ["1", Buffer.from('<style>.logo{width:32px}</style><img class="logo" src="cid:logo@example.test"><img src="https://images.example.test/a.png"><a href="https://example.test">Open</a><img src="cid:unsafe@example.test"><img src="cid:large@example.test">')],
          ["2", Buffer.from(png.toString("base64"))]
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
    expect(requestedParts).toEqual(["1", "2"]);
    expect(detail.html).toContain("data:image/png;base64,");
    expect(detail.html).toContain('data-remote-src="https://images.example.test/a.png"');
    expect(detail.html).toContain('data-safe-href="https://example.test/"');
    expect(detail.html).toContain("<style>.logo{width:32px}</style>");
    expect(detail.html).not.toMatch(/unsafe@example\.test|large@example\.test/);
    expect(detail.labels).toEqual(["forwarded"]);

    requestedParts.splice(0);
    await synchronizer.syncFolder(client as unknown as ImapFlow, account, "inbox", "INBOX", 100);
    expect(requestedParts).toEqual([]);

    db.upsertMessage({
      id: summary.id, accountId: account.id, folder: "inbox", mailboxPath: "INBOX", uid: 1, uidValidity: "1",
      read: false, displayTime: "2026-01-01T00:00:00.000Z",
      content: {
        htmlPolicyVersion: 2, classificationVersion: 0, subject: detail.subject, from: detail.from, to: detail.to, cc: detail.cc,
        preview: detail.preview, text: detail.text, html: detail.html, attachments: detail.attachments, labels: detail.labels,
        verificationCode: detail.verificationCode, unsubscribeUrl: detail.unsubscribeUrl
      }
    });
    await synchronizer.syncFolder(client as unknown as ImapFlow, account, "inbox", "INBOX", 100);
    expect(requestedParts).toEqual([]);
    expect(db.getKnownMessage(account.id, "inbox", "1", 1)?.classificationVersion).toBe(1);

    const legacyContent = { subject: "Legacy", from: [], to: [], cc: [], preview: "legacy", text: "legacy", html: "<p>legacy</p>", attachments: [] };
    db.upsertMessage({ id: summary.id, accountId: account.id, folder: "inbox", mailboxPath: "INBOX", uid: 1, uidValidity: "1", read: false, displayTime: "2026-01-01T00:00:00.000Z", content: legacyContent });
    expect(db.getKnownMessage(account.id, "inbox", "1", 1)?.htmlPolicyVersion).toBe(0);
    await synchronizer.syncFolder(client as unknown as ImapFlow, account, "inbox", "INBOX", 100);
    expect(requestedParts).toEqual(["1", "2"]);
    expect(updatedIds.at(-1)).toEqual([summary.id]);
    expect(db.getKnownMessage(account.id, "inbox", "1", 1)?.htmlPolicyVersion).toBe(2);

    db.upsertMessage({ id: summary.id, accountId: account.id, folder: "inbox", mailboxPath: "INBOX", uid: 1, uidValidity: "1", read: false, displayTime: "2026-01-01T00:00:00.000Z", content: { ...legacyContent, html: "<p>preserved</p>" } });
    failBodyFetch = true;
    await expect(synchronizer.syncFolder(client as unknown as ImapFlow, account, "inbox", "INBOX", 100)).rejects.toThrow("body fetch failed");
    expect(db.getMessage(summary.id)?.html).toBe("<p>preserved</p>");
    db.close();
  });
});
