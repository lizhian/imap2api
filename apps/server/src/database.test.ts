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
    db.updateSettings(2);
    const result = db.listMessages({ view: "all", limit: 50 });
    expect(result.items.map((item) => item.subject)).toEqual(["message-2", "message-1"]);
    db.close();
  });
});
