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
    db.createAccount({ email: "migration@qq.com", password: "secret" });
    db.raw.exec("ALTER TABLE settings DROP COLUMN poll_interval_seconds; ALTER TABLE accounts DROP COLUMN sync_mode; PRAGMA user_version = 1;");
    db.close();

    const migrated = new AppDatabase(path, "t".repeat(32));
    expect(migrated.raw.pragma("user_version", { simple: true })).toBe(2);
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
