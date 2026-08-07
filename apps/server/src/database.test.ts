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
        classificationVersion: 1, labels: ["forwarded", "verification_code", "unsubscribe"],
        verificationCode: "123456", unsubscribeUrl: "https://private.example/unsubscribe"
      }
    });
    const item = db.listMessages({ view: "all", limit: 50 }).items[0]!;
    expect(item.labels).toEqual(["forwarded", "verification_code", "unsubscribe"]);
    expect(db.getMessage(item.id)).toMatchObject({ verificationCode: "123456", unsubscribeUrl: "https://private.example/unsubscribe" });
    expect(() => db.updateAccount(account.id, { aliases: ["MAIN@gmail.com"] })).toThrow("不能与主邮箱相同");
    expect(() => db.updateAccount(account.id, { aliases: ["same@gmail.com", "SAME@gmail.com"] })).toThrow("不能重复");
    db.close();
    const bytes = readFileSync(path).toString("utf8");
    expect(bytes).not.toContain("alias@gmail.com");
    expect(bytes).not.toContain("123456");
    expect(bytes).not.toContain("private.example");
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
    db.raw.exec("ALTER TABLE settings DROP COLUMN poll_interval_seconds; ALTER TABLE accounts DROP COLUMN sync_mode; ALTER TABLE accounts DROP COLUMN sort_order; PRAGMA user_version = 1;");
    db.close();

    const migrated = new AppDatabase(path, "t".repeat(32));
    expect(migrated.raw.pragma("user_version", { simple: true })).toBe(3);
    expect(migrated.getSettings()).toEqual({ maxMessagesPerAccount: 100, pollIntervalSeconds: 10 });
    expect(migrated.listAccounts()[0]).toMatchObject({ email: "migration@qq.com", syncMode: null });
    migrated.close();
  });

  it("updates polling and retention settings independently", () => {
    const { db } = database();
    expect(db.updateSettings({ pollIntervalSeconds: 25 }).settings).toEqual({ maxMessagesPerAccount: 100, pollIntervalSeconds: 25 });
    expect(db.updateSettings({ maxMessagesPerAccount: 80 }).settings).toEqual({ maxMessagesPerAccount: 80, pollIntervalSeconds: 25 });
    expect(() => db.updateSettings({ pollIntervalSeconds: 4 })).toThrow();
    expect(db.getSettings()).toEqual({ maxMessagesPerAccount: 80, pollIntervalSeconds: 25 });
    db.close();
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
