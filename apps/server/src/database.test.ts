import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase } from "./database.js";

const dirs: string[] = [];
function database(token = "t".repeat(32)) {
  const dir = mkdtempSync(join(tmpdir(), "imap2api-test-")); dirs.push(dir);
  const path = join(dir, "test.db");
  return { db: new AppDatabase(path, token), path };
}

afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("AppDatabase", () => {
  it("encrypts account secrets and rejects a different token", () => {
    const { db, path } = database();
    const account = db.createAccount({ email: "secret@gmail.com", password: "app-password" });
    expect(account).not.toHaveProperty("password");
    db.close();
    const bytes = readFileSync(path).toString("utf8");
    expect(bytes).not.toContain("secret@gmail.com");
    expect(bytes).not.toContain("app-password");
    expect(() => new AppDatabase(path, "x".repeat(32))).toThrow("cannot decrypt");
  });

  it("normalizes aliases and keeps message classifications encrypted", () => {
    const { db, path } = database();
    const account = db.createAccount({ email: "main@gmail.com", aliases: [" Alias@Gmail.com "], password: "secret" });
    expect(account.aliases).toEqual(["alias@gmail.com"]);
    db.upsertMessage({
      accountId: account.id, folder: "inbox", mailboxPath: "INBOX", uid: 1, uidValidity: "1", read: false,
      displayTime: "2026-01-01T00:00:00.000Z",
      content: {
        subject: "Code", from: [], to: [{ address: "other@gmail.com" }], cc: [], preview: "验证码 123456",
        text: "验证码 123456", html: '<p>退订 <a data-safe-href="https://private.example/unsubscribe">here</a></p>', attachments: [],
        classificationVersion: 2, labels: ["forwarded", "verification_code", "unsubscribe"],
        verificationCode: "123456", unsubscribeUrl: "https://private.example/unsubscribe",
        forwardedVia: "relay@private.example", forwardedViaSource: "delivery-chain"
      }
    });
    const item = db.listMessages({ view: "all", limit: 50 }).items[0]!;
    expect(item.labels).toEqual(["forwarded", "verification_code", "unsubscribe"]);
    expect(item.forwardedVia).toBe("relay@private.example");
    expect(db.getMessage(item.id)).toMatchObject({
      verificationCode: "123456", unsubscribeUrl: "https://private.example/unsubscribe", forwardedVia: "relay@private.example"
    });
    expect(() => db.updateAccount(account.id, { aliases: ["MAIN@gmail.com"] })).toThrow("不能与主邮箱相同");
    expect(() => db.updateAccount(account.id, { aliases: ["same@gmail.com", "SAME@gmail.com"] })).toThrow("不能重复");
    db.close();
    const bytes = readFileSync(path).toString("utf8");
    expect(bytes).not.toContain("alias@gmail.com");
    expect(bytes).not.toContain("123456");
    expect(bytes).not.toContain("private.example");
  });

  it("combines encrypted labels and attachment filters without breaking cursor pagination", () => {
    const { db } = database();
    const account = db.createAccount({ email: "filters@gmail.com", password: "secret" });
    const messages = [
      { labels: ["verification_code"], attachments: ["first.pdf"] },
      { labels: ["forwarded"], attachments: ["forwarded.pdf"] },
      { labels: ["verification_code"], attachments: [] },
      { labels: ["verification_code", "forwarded"], attachments: ["latest.pdf"] }
    ] as const;
    messages.forEach((message, index) => db.upsertMessage({
      accountId: account.id, folder: "inbox", mailboxPath: "INBOX", uid: index + 1, uidValidity: "1", read: false,
      displayTime: `2026-01-0${index + 1}T00:00:00.000Z`,
      content: {
        subject: `message-${index + 1}`, from: [], to: [], cc: [], preview: "", text: "", html: null,
        attachments: [...message.attachments], labels: [...message.labels]
      }
    }));

    const first = db.listMessages({ view: "unread", filter: ["verification_code", "attachment"], limit: 1 });
    expect(first.items.map((message) => message.subject)).toEqual(["message-4"]);
    expect(first.total).toBe(2);
    expect(first.nextCursor).not.toBeNull();
    const second = db.listMessages({ view: "unread", filter: ["verification_code", "attachment"], cursor: first.nextCursor!, limit: 1 });
    expect(second.items.map((message) => message.subject)).toEqual(["message-1"]);
    expect(second.total).toBe(2);
    expect(second.nextCursor).toBeNull();

    const fullyFiltered = db.listMessages({ view: "all", filter: ["verification_code", "attachment", "forwarded"], limit: 10 });
    expect(fullyFiltered.items.map((message) => message.subject)).toEqual(["message-4"]);
    expect(fullyFiltered.total).toBe(1);
    db.close();
  });

  it("keeps download metadata encrypted and normalizes legacy attachment names", () => {
    const { db, path } = database();
    const account = db.createAccount({ email: "attachments@gmail.com", password: "secret" });
    const storedId = db.upsertMessage({
      accountId: account.id, folder: "inbox", mailboxPath: "Custom/Files", uid: 7, uidValidity: "9", read: true,
      displayTime: "2026-01-01T00:00:00.000Z",
      content: {
        subject: "Attachments", from: [], to: [], cc: [], preview: "", text: "", html: null,
        attachmentMetadataVersion: 1,
        attachments: [{ id: "stable-id", part: "2.1", filename: "账单.pdf", contentType: "application/pdf", size: 2048, encoding: "base64" }]
      }
    });
    const legacyId = db.upsertMessage({
      accountId: account.id, folder: "inbox", mailboxPath: "INBOX", uid: 8, uidValidity: "9", read: true,
      displayTime: "2026-01-02T00:00:00.000Z",
      content: { subject: "Legacy", from: [], to: [], cc: [], preview: "", text: "", html: null, attachments: ["legacy.txt"] }
    });

    expect(db.getMessage(storedId)?.attachments).toEqual([{ id: "stable-id", filename: "账单.pdf", contentType: "application/pdf", size: 2048 }]);
    expect(db.getMessage(storedId)?.attachments[0]).not.toHaveProperty("part");
    expect(db.getAttachmentTransport(storedId, "stable-id")).toMatchObject({ mailboxPath: "Custom/Files", uid: 7, uidValidity: "9", attachment: { part: "2.1" } });
    expect(db.getMessage(legacyId)?.attachments).toEqual([{ id: null, filename: "legacy.txt", contentType: "application/octet-stream", size: null }]);
    expect(db.getAttachmentTransport(legacyId, "legacy.txt")).toBeNull();
    db.close();
    const bytes = readFileSync(path).toString("utf8");
    expect(bytes).not.toContain("账单.pdf");
    expect(bytes).not.toContain("Custom/Files");
  });

  it("returns the cached and unread message counts for each account", () => {
    const { db } = database();
    const account = db.createAccount({ email: "counts@gmail.com", password: "secret" });
    for (const [uid, read] of [[1, false], [2, false], [3, true]] as const) {
      db.upsertMessage({
        accountId: account.id, folder: uid === 2 ? "junk" : "inbox", mailboxPath: "INBOX",
        uid, uidValidity: "1", read, displayTime: `2026-01-0${uid}T00:00:00.000Z`,
        content: { subject: `message-${uid}`, from: [], to: [], cc: [], preview: "", text: "", html: null, attachments: [] }
      });
    }

    expect(db.listAccounts()[0]).toMatchObject({ messageCount: 3, unreadCount: 2 });
    db.updateKnownRead(db.listMessages({ accountId: account.id, view: "unread", limit: 50 }).items[0]!.id, true);
    expect(db.listAccounts()[0]).toMatchObject({ messageCount: 3, unreadCount: 1 });
    expect(db.updateAccount(account.id, { aliases: ["alias@gmail.com"] })).toMatchObject({ messageCount: 3, unreadCount: 1 });
    db.close();
  });

  it("isolates custom mailbox UIDs, encrypts paths, and removes only deselected cache", () => {
    const { db, path } = database();
    const account = db.createAccount({ email: "folders@gmail.com", password: "secret" });
    const firstPath = "Projects/Forwarded-Private";
    const secondPath = "Archive/Receipts-Private";
    expect(db.updateSyncFolders(account.id, [
      { path: firstPath, mode: "idle" }, { path: secondPath, mode: "polling" }
    ])?.account).toMatchObject({ syncFolderCount: 2 });
    for (const [mailboxPath, subject] of [[firstPath, "forwarded"], [secondPath, "receipt"]] as const) {
      db.upsertMessage({
        accountId: account.id, folder: "inbox", mailboxPath, uid: 7, uidValidity: "1", read: false,
        displayTime: "2026-01-01T00:00:00.000Z",
        content: { subject, from: [], to: [], cc: [], preview: "", text: "", html: null, attachments: [] }
      });
    }
    expect(db.listMessages({ accountId: account.id, view: "all", limit: 50 }).items).toHaveLength(2);

    const removed = db.updateSyncFolders(account.id, [{ path: secondPath, mode: "polling" }]);
    expect(removed?.removed).toHaveLength(1);
    expect(db.listMessages({ accountId: account.id, view: "all", limit: 50 }).items.map((message) => message.subject)).toEqual(["receipt"]);
    db.close();
    const bytes = readFileSync(path).toString("utf8");
    expect(bytes).not.toContain(firstPath);
    expect(bytes).not.toContain(secondPath);
  });

  it("persists an explicit account order and appends new accounts", () => {
    const { db } = database();
    const first = db.createAccount({ email: "first@gmail.com", password: "secret" });
    const second = db.createAccount({ email: "second@gmail.com", password: "secret" });
    const third = db.createAccount({ email: "third@gmail.com", password: "secret" });

    expect(db.listAccounts().map((account) => account.id)).toEqual([first.id, second.id, third.id]);
    db.reorderAccounts([third.id, first.id, second.id]);
    expect(db.listAccounts().map((account) => account.id)).toEqual([third.id, first.id, second.id]);
    expect(() => db.reorderAccounts([third.id, first.id])).toThrow("账号排序数据无效");

    const fourth = db.createAccount({ email: "fourth@gmail.com", password: "secret" });
    expect(db.listAccounts().map((account) => account.id)).toEqual([third.id, first.id, second.id, fourth.id]);
    db.close();
  });

  it("reclassifies cached messages after aliases change", () => {
    const { db } = database();
    const account = db.createAccount({ email: "main@gmail.com", password: "secret" });
    db.upsertMessage({
      accountId: account.id, folder: "inbox", mailboxPath: "INBOX", uid: 1, uidValidity: "1", read: false,
      displayTime: "2026-01-01T00:00:00.000Z",
      content: { subject: "Forwarded", from: [], to: [{ address: "alias@gmail.com" }], cc: [], preview: "", text: "", html: null, attachments: [], labels: ["forwarded"] }
    });
    db.updateAccount(account.id, { aliases: ["alias@gmail.com"] });
    const groups = db.reclassifyAccountMessages(db.getAccount(account.id)!);
    expect(groups).toEqual([{ folder: "inbox", ids: [expect.any(String)] }]);
    expect(db.listMessages({ view: "all", limit: 50 }).items[0]!.labels).toEqual([]);
    db.close();
  });

  it("enforces the combined per-account retention limit", () => {
    const { db } = database();
    const account = db.createAccount({ email: "mail@gmail.com", password: "code" });
    for (let index = 0; index < 3; index++) {
      db.upsertMessage({
        accountId: account.id, folder: index === 0 ? "junk" : "inbox", mailboxPath: "INBOX",
        uid: index + 1, uidValidity: "1", read: false, displayTime: new Date(2026, 0, index + 1).toISOString(),
        content: { subject: `message-${index}`, from: [], to: [], cc: [], preview: "", text: "", html: null, attachments: [] }
      });
    }
    db.updateSettings({ maxMessagesPerAccount: 2 });
    const result = db.listMessages({ view: "all", limit: 50 });
    expect(result.items.map((item) => item.subject)).toEqual(["message-2", "message-1"]);
    db.close();
  });

  it("migrates v1 settings without losing encrypted account data", () => {
    const { db, path } = database();
    const account = db.createAccount({ email: "migration@qq.com", password: "secret" });
    const stored = db.getAccount(account.id)!;
    db.raw.prepare("UPDATE accounts SET config_enc = ? WHERE id = ?")
      .run(db.crypto.encrypt({ email: stored.email, imap: stored.imap }), account.id);
    expect(db.listAccounts()[0]!.aliases).toEqual([]);
    db.raw.exec("ALTER TABLE settings DROP COLUMN poll_interval_seconds; ALTER TABLE settings DROP COLUMN page_size; ALTER TABLE settings DROP COLUMN max_concurrent_downloads; ALTER TABLE settings DROP COLUMN max_attachment_size_mb; ALTER TABLE settings DROP COLUMN remote_image_allowlist_enc; ALTER TABLE settings DROP COLUMN default_sender_name_enc; ALTER TABLE accounts DROP COLUMN sync_mode; ALTER TABLE accounts DROP COLUMN sort_order; PRAGMA user_version = 1;");
    db.close();

    const migrated = new AppDatabase(path, "t".repeat(32));
    expect(migrated.raw.pragma("user_version", { simple: true })).toBe(8);
    expect(migrated.getSettings()).toEqual({ maxMessagesPerAccount: 100, pollIntervalSeconds: 10, pageSize: 100, maxConcurrentDownloads: 3, maxAttachmentSizeMb: 100, remoteImageAllowlist: [], defaultSenderName: "" });
    expect(migrated.listAccounts()[0]).toMatchObject({
      email: "migration@qq.com", syncMode: null, smtp: { host: "smtp.qq.com", port: 465, secure: true }, defaultSenderName: null
    });
    migrated.close();
  });

  it("updates polling, retention, pagination and encrypted image settings independently", () => {
    const { db, path } = database();
    expect(db.updateSettings({ pollIntervalSeconds: 25 }).settings).toEqual({ maxMessagesPerAccount: 100, pollIntervalSeconds: 25, pageSize: 100, maxConcurrentDownloads: 3, maxAttachmentSizeMb: 100, remoteImageAllowlist: [], defaultSenderName: "" });
    expect(db.updateSettings({ maxMessagesPerAccount: 80 }).settings).toEqual({ maxMessagesPerAccount: 80, pollIntervalSeconds: 25, pageSize: 100, maxConcurrentDownloads: 3, maxAttachmentSizeMb: 100, remoteImageAllowlist: [], defaultSenderName: "" });
    expect(db.updateSettings({ pageSize: 60, maxConcurrentDownloads: 4, maxAttachmentSizeMb: 200 }).settings).toEqual({ maxMessagesPerAccount: 80, pollIntervalSeconds: 25, pageSize: 60, maxConcurrentDownloads: 4, maxAttachmentSizeMb: 200, remoteImageAllowlist: [], defaultSenderName: "" });
    expect(db.updateSettings({ remoteImageAllowlist: [" Trusted@Example.com ", "trusted@example.com"], defaultSenderName: " Operations " }).settings)
      .toEqual({ maxMessagesPerAccount: 80, pollIntervalSeconds: 25, pageSize: 60, maxConcurrentDownloads: 4, maxAttachmentSizeMb: 200, remoteImageAllowlist: ["trusted@example.com"], defaultSenderName: "Operations" });
    expect(() => db.updateSettings({ pollIntervalSeconds: 4 })).toThrow();
    expect(() => db.updateSettings({ pageSize: 101 })).toThrow();
    expect(() => db.updateSettings({ maxConcurrentDownloads: 11 })).toThrow();
    expect(() => db.updateSettings({ maxAttachmentSizeMb: 1025 })).toThrow();
    expect(db.getSettings()).toEqual({ maxMessagesPerAccount: 80, pollIntervalSeconds: 25, pageSize: 60, maxConcurrentDownloads: 4, maxAttachmentSizeMb: 200, remoteImageAllowlist: ["trusted@example.com"], defaultSenderName: "Operations" });
    db.close();
    expect(readFileSync(path).toString("utf8")).not.toContain("trusted@example.com");
    expect(readFileSync(path).toString("utf8")).not.toContain("Operations");
  });

  it("encrypts SMTP and sender defaults without resetting an active IMAP status", () => {
    const { db, path } = database();
    const created = db.createAccount({
      email: "custom@example.com", password: "secret", imap: { provider: "custom", host: "imap.example.com" },
      smtp: { host: "smtp.example.com", port: 587, secure: false }, defaultSenderName: "Custom Sender"
    });
    db.setAccountStatus(created.id, "connected", null, true);
    const updated = db.updateAccount(created.id, { defaultSenderName: "Updated Sender", smtp: { host: "relay.example.com", port: 587, secure: false } });
    expect(updated).toMatchObject({
      status: "connected", defaultSenderName: "Updated Sender", smtp: { host: "relay.example.com", port: 587, secure: false }
    });
    db.close();
    const raw = readFileSync(path).toString("utf8");
    expect(raw).not.toContain("Updated Sender");
    expect(raw).not.toContain("relay.example.com");
  });

  it("skips bodies that cannot enter the combined retention window", () => {
    const { db } = database();
    const account = db.createAccount({ email: "window@gmail.com", password: "code" });
    db.updateSettings({ maxMessagesPerAccount: 1 });
    db.upsertMessage({
      accountId: account.id, folder: "inbox", mailboxPath: "INBOX", uid: 2, uidValidity: "1", read: false,
      displayTime: "2026-01-02T00:00:00.000Z",
      content: { subject: "newer", from: [], to: [], cc: [], preview: "", text: "", html: null, attachments: [] }
    });
    expect(db.isInRetentionWindow(account.id, "2026-01-01T00:00:00.000Z", "junk", 1)).toBe(false);
    expect(db.isInRetentionWindow(account.id, "2026-01-03T00:00:00.000Z", "junk", 1)).toBe(true);
    db.close();
  });
});
