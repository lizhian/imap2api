import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import type {
  Account,
  AccountInput,
  AccountUpdate,
  Address,
  ConnectionStatus,
  MessageDetail,
  MessageListResponse,
  MessageSummary,
  MessageView,
  Settings
} from "@imap2api/shared";
import { CryptoService } from "./crypto.js";
import { resolveImapConfig, type ResolvedImapConfig } from "./providers.js";

interface AccountConfigPayload {
  email: string;
  imap: ResolvedImapConfig;
}

export interface StoredAccount extends AccountConfigPayload {
  id: string;
  password: string;
  status: ConnectionStatus;
  lastSyncedAt: string | null;
  lastError: string | null;
}

export interface StoredMessageContent {
  subject: string;
  from: Address[];
  to: Address[];
  cc: Address[];
  preview: string;
  text: string;
  html: string | null;
  attachments: string[];
}

export interface SyncedMessage {
  id?: string;
  accountId: string;
  folder: "inbox" | "junk";
  mailboxPath: string;
  uid: number;
  uidValidity: string;
  read: boolean;
  displayTime: string;
  content: StoredMessageContent;
}

interface AccountRow {
  id: string;
  config_enc: Buffer;
  credential_enc: Buffer;
  status: ConnectionStatus;
  last_sync_at: string | null;
  error_enc: Buffer | null;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  id: string;
  account_id: string;
  folder_kind: "inbox" | "junk";
  mailbox_path_enc: Buffer;
  uid: number;
  uid_validity: string;
  is_read: number;
  display_time: string;
  has_attachments: number;
  content_enc: Buffer;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  max_messages_per_account INTEGER NOT NULL DEFAULT 100 CHECK (max_messages_per_account BETWEEN 1 AND 10000)
);
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  email_hash TEXT NOT NULL UNIQUE,
  config_enc BLOB NOT NULL,
  credential_enc BLOB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  last_sync_at TEXT,
  error_enc BLOB,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS folders (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('inbox', 'junk')),
  path_enc BLOB NOT NULL,
  uid_validity TEXT NOT NULL,
  synced_at TEXT NOT NULL,
  PRIMARY KEY (account_id, kind)
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  folder_kind TEXT NOT NULL CHECK (folder_kind IN ('inbox', 'junk')),
  mailbox_path_enc BLOB NOT NULL,
  uid INTEGER NOT NULL,
  uid_validity TEXT NOT NULL,
  is_read INTEGER NOT NULL DEFAULT 0,
  display_time TEXT NOT NULL,
  has_attachments INTEGER NOT NULL DEFAULT 0,
  content_enc BLOB NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(account_id, folder_kind, uid_validity, uid)
);
CREATE INDEX IF NOT EXISTS messages_list_idx ON messages(display_time DESC, id DESC);
CREATE INDEX IF NOT EXISTS messages_account_idx ON messages(account_id, display_time DESC, id DESC);
CREATE INDEX IF NOT EXISTS messages_view_idx ON messages(folder_kind, is_read, display_time DESC);
INSERT OR IGNORE INTO settings(id, max_messages_per_account) VALUES (1, 100);
PRAGMA user_version = 1;
`;

function asBuffer(value: Buffer | Uint8Array): Buffer {
  return Buffer.isBuffer(value) ? value : Buffer.from(value);
}

export class AppDatabase {
  readonly raw: Database.Database;
  readonly crypto: CryptoService;

  constructor(path: string, token: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.raw = new Database(path);
    this.raw.pragma("journal_mode = WAL");
    this.raw.pragma("foreign_keys = ON");
    this.raw.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value BLOB NOT NULL)");

    const saltRow = this.raw.prepare("SELECT value FROM meta WHERE key = 'encryption_salt'").get() as { value: Buffer } | undefined;
    const salt = saltRow ? asBuffer(saltRow.value) : randomBytes(32);
    if (!saltRow) this.raw.prepare("INSERT INTO meta(key, value) VALUES ('encryption_salt', ?)").run(salt);
    this.crypto = CryptoService.derive(token, salt);

    const checkRow = this.raw.prepare("SELECT value FROM meta WHERE key = 'key_check'").get() as { value: Buffer } | undefined;
    if (checkRow) {
      try {
        if (this.crypto.decrypt<string>(asBuffer(checkRow.value)) !== "imap2api-key-check-v1") throw new Error("mismatch");
      } catch {
        this.raw.close();
        throw new Error("IMAP2API_TOKEN cannot decrypt the existing database");
      }
    } else {
      this.raw.prepare("INSERT INTO meta(key, value) VALUES ('key_check', ?)").run(this.crypto.encrypt("imap2api-key-check-v1"));
    }
    this.raw.exec(SCHEMA);
  }

  close(): void {
    this.raw.close();
  }

  getSettings(): Settings {
    const row = this.raw.prepare("SELECT max_messages_per_account AS maxMessagesPerAccount FROM settings WHERE id = 1").get() as Settings;
    return row;
  }

  updateSettings(maxMessagesPerAccount: number): Settings {
    this.raw.prepare("UPDATE settings SET max_messages_per_account = ? WHERE id = 1").run(maxMessagesPerAccount);
    for (const { id } of this.raw.prepare("SELECT id FROM accounts").all() as Array<{ id: string }>) this.enforceRetention(id);
    return this.getSettings();
  }

  listAccounts(): Account[] {
    return (this.raw.prepare("SELECT * FROM accounts ORDER BY created_at ASC").all() as AccountRow[]).map((row) => this.toPublicAccount(row));
  }

  getAccount(id: string): StoredAccount | null {
    const row = this.raw.prepare("SELECT * FROM accounts WHERE id = ?").get(id) as AccountRow | undefined;
    if (!row) return null;
    const config = this.crypto.decrypt<AccountConfigPayload>(asBuffer(row.config_enc));
    return {
      id: row.id,
      ...config,
      password: this.crypto.decrypt<string>(asBuffer(row.credential_enc)),
      status: row.status,
      lastSyncedAt: row.last_sync_at,
      lastError: row.error_enc ? this.crypto.decrypt<string>(asBuffer(row.error_enc)) : null
    };
  }

  createAccount(input: AccountInput): Account {
    const now = new Date().toISOString();
    const id = randomUUID();
    const email = input.email.trim().toLowerCase();
    const imap = resolveImapConfig(email, input.imap);
    this.raw.prepare(`
      INSERT INTO accounts(id, email_hash, config_enc, credential_enc, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'pending', ?, ?)
    `).run(id, this.crypto.fingerprint(email), this.crypto.encrypt({ email, imap }), this.crypto.encrypt(input.password), now, now);
    return this.toPublicAccount(this.raw.prepare("SELECT * FROM accounts WHERE id = ?").get(id) as AccountRow);
  }

  updateAccount(id: string, input: AccountUpdate): Account | null {
    const current = this.getAccount(id);
    if (!current) return null;
    const email = (input.email ?? current.email).trim().toLowerCase();
    const imap = resolveImapConfig(email, input.imap ?? current.imap);
    const now = new Date().toISOString();
    const credential = input.password ? this.crypto.encrypt(input.password) : this.crypto.encrypt(current.password);
    this.raw.prepare(`
      UPDATE accounts SET email_hash = ?, config_enc = ?, credential_enc = ?, status = 'pending',
        error_enc = NULL, updated_at = ? WHERE id = ?
    `).run(this.crypto.fingerprint(email), this.crypto.encrypt({ email, imap }), credential, now, id);
    return this.toPublicAccount(this.raw.prepare("SELECT * FROM accounts WHERE id = ?").get(id) as AccountRow);
  }

  deleteAccount(id: string): boolean {
    return this.raw.prepare("DELETE FROM accounts WHERE id = ?").run(id).changes > 0;
  }

  setAccountStatus(id: string, status: ConnectionStatus, error?: string | null, synced = false): void {
    const now = new Date().toISOString();
    this.raw.prepare(`
      UPDATE accounts SET status = ?, error_enc = ?, last_sync_at = CASE WHEN ? THEN ? ELSE last_sync_at END,
        updated_at = ? WHERE id = ?
    `).run(status, error ? this.crypto.encrypt(error.slice(0, 1000)) : null, synced ? 1 : 0, now, now, id);
  }

  getFolderState(accountId: string, kind: "inbox" | "junk"): { path: string; uidValidity: string } | null {
    const row = this.raw.prepare("SELECT path_enc, uid_validity FROM folders WHERE account_id = ? AND kind = ?").get(accountId, kind) as { path_enc: Buffer; uid_validity: string } | undefined;
    return row ? { path: this.crypto.decrypt<string>(asBuffer(row.path_enc)), uidValidity: row.uid_validity } : null;
  }

  setFolderState(accountId: string, kind: "inbox" | "junk", path: string, uidValidity: string): void {
    this.raw.prepare(`
      INSERT INTO folders(account_id, kind, path_enc, uid_validity, synced_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(account_id, kind) DO UPDATE SET path_enc = excluded.path_enc,
        uid_validity = excluded.uid_validity, synced_at = excluded.synced_at
    `).run(accountId, kind, this.crypto.encrypt(path), uidValidity, new Date().toISOString());
  }

  resetFolder(accountId: string, kind: "inbox" | "junk"): void {
    this.raw.prepare("DELETE FROM messages WHERE account_id = ? AND folder_kind = ?").run(accountId, kind);
  }

  getKnownMessage(accountId: string, kind: "inbox" | "junk", uidValidity: string, uid: number): { id: string; read: boolean } | null {
    const row = this.raw.prepare(`SELECT id, is_read FROM messages
      WHERE account_id = ? AND folder_kind = ? AND uid_validity = ? AND uid = ?`).get(accountId, kind, uidValidity, uid) as { id: string; is_read: number } | undefined;
    return row ? { id: row.id, read: Boolean(row.is_read) } : null;
  }

  updateKnownRead(id: string, read: boolean): void {
    this.raw.prepare("UPDATE messages SET is_read = ?, updated_at = ? WHERE id = ?").run(read ? 1 : 0, new Date().toISOString(), id);
  }

  upsertMessage(message: SyncedMessage): void {
    const now = new Date().toISOString();
    this.raw.prepare(`
      INSERT INTO messages(id, account_id, folder_kind, mailbox_path_enc, uid, uid_validity, is_read,
        display_time, has_attachments, content_enc, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id, folder_kind, uid_validity, uid) DO UPDATE SET
        is_read = excluded.is_read, display_time = excluded.display_time,
        has_attachments = excluded.has_attachments, content_enc = excluded.content_enc, updated_at = excluded.updated_at
    `).run(
      message.id ?? randomUUID(), message.accountId, message.folder, this.crypto.encrypt(message.mailboxPath),
      message.uid, message.uidValidity, message.read ? 1 : 0, message.displayTime,
      message.content.attachments.length ? 1 : 0, this.crypto.encrypt(message.content), now, now
    );
  }

  removeMissingFolderMessages(accountId: string, kind: "inbox" | "junk", uidValidity: string, retainedUids: number[]): void {
    if (!retainedUids.length) {
      this.raw.prepare("DELETE FROM messages WHERE account_id = ? AND folder_kind = ?").run(accountId, kind);
      return;
    }
    const placeholders = retainedUids.map(() => "?").join(",");
    this.raw.prepare(`DELETE FROM messages WHERE account_id = ? AND folder_kind = ?
      AND (uid_validity != ? OR uid NOT IN (${placeholders}))`).run(accountId, kind, uidValidity, ...retainedUids);
  }

  enforceRetention(accountId: string): void {
    const max = this.getSettings().maxMessagesPerAccount;
    this.raw.prepare(`DELETE FROM messages WHERE account_id = ? AND id NOT IN (
      SELECT id FROM messages WHERE account_id = ? ORDER BY display_time DESC, id DESC LIMIT ?
    )`).run(accountId, accountId, max);
  }

  listMessages(options: { accountId?: string; view: MessageView; after?: string; before?: string; cursor?: string; limit: number }): MessageListResponse {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (options.accountId) { conditions.push("account_id = ?"); params.push(options.accountId); }
    if (options.view === "unread") conditions.push("is_read = 0");
    if (options.view === "junk") conditions.push("folder_kind = 'junk'");
    if (options.after) { conditions.push("display_time >= ?"); params.push(options.after); }
    if (options.before) { conditions.push("display_time < ?"); params.push(options.before); }
    if (options.cursor) {
      const [time, id] = this.decodeCursor(options.cursor);
      conditions.push("(display_time < ? OR (display_time = ? AND id < ?))");
      params.push(time, time, id);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = this.raw.prepare(`SELECT * FROM messages ${where} ORDER BY display_time DESC, id DESC LIMIT ?`)
      .all(...params, options.limit + 1) as MessageRow[];
    const hasMore = rows.length > options.limit;
    const selected = rows.slice(0, options.limit);
    const accountCache = new Map(this.listAccounts().map((account) => [account.id, account.email]));
    const items = selected.map((row) => this.toMessageSummary(row, accountCache.get(row.account_id) ?? ""));
    const tail = selected.at(-1);
    return { items, nextCursor: hasMore && tail ? this.encodeCursor(tail.display_time, tail.id) : null };
  }

  getMessage(id: string): MessageDetail | null {
    const row = this.raw.prepare("SELECT * FROM messages WHERE id = ?").get(id) as MessageRow | undefined;
    if (!row) return null;
    const account = this.toPublicAccount(this.raw.prepare("SELECT * FROM accounts WHERE id = ?").get(row.account_id) as AccountRow);
    const summary = this.toMessageSummary(row, account.email);
    const content = this.crypto.decrypt<StoredMessageContent>(asBuffer(row.content_enc));
    return { ...summary, to: content.to, cc: content.cc, attachments: content.attachments, text: content.text, html: content.html };
  }

  getMessageTransport(id: string): { accountId: string; folder: "inbox" | "junk"; mailboxPath: string; uid: number } | null {
    const row = this.raw.prepare("SELECT account_id, folder_kind, mailbox_path_enc, uid FROM messages WHERE id = ?").get(id) as Pick<MessageRow, "account_id" | "folder_kind" | "mailbox_path_enc" | "uid"> | undefined;
    return row ? { accountId: row.account_id, folder: row.folder_kind, mailboxPath: this.crypto.decrypt<string>(asBuffer(row.mailbox_path_enc)), uid: row.uid } : null;
  }

  getUnreadTransports(accountId: string): Array<{ id: string; folder: "inbox" | "junk"; mailboxPath: string; uid: number }> {
    return (this.raw.prepare("SELECT id, folder_kind, mailbox_path_enc, uid FROM messages WHERE account_id = ? AND is_read = 0").all(accountId) as Array<Pick<MessageRow, "id" | "folder_kind" | "mailbox_path_enc" | "uid">>)
      .map((row) => ({ id: row.id, folder: row.folder_kind, mailboxPath: this.crypto.decrypt<string>(asBuffer(row.mailbox_path_enc)), uid: row.uid }));
  }

  markAllLocalRead(accountId: string): number {
    return this.raw.prepare("UPDATE messages SET is_read = 1, updated_at = ? WHERE account_id = ? AND is_read = 0").run(new Date().toISOString(), accountId).changes;
  }

  private toPublicAccount(row: AccountRow): Account {
    const config = this.crypto.decrypt<AccountConfigPayload>(asBuffer(row.config_enc));
    return {
      id: row.id, email: config.email, provider: config.imap.provider, imap: config.imap,
      hasCredential: true, status: row.status, lastSyncedAt: row.last_sync_at,
      lastError: row.error_enc ? this.crypto.decrypt<string>(asBuffer(row.error_enc)) : null,
      createdAt: row.created_at, updatedAt: row.updated_at
    };
  }

  private toMessageSummary(row: MessageRow, accountEmail: string): MessageSummary {
    const content = this.crypto.decrypt<StoredMessageContent>(asBuffer(row.content_enc));
    return {
      id: row.id, accountId: row.account_id, accountEmail, subject: content.subject,
      from: content.from, preview: content.preview, displayTime: row.display_time,
      folder: row.folder_kind, read: Boolean(row.is_read), hasAttachments: Boolean(row.has_attachments)
    };
  }

  private encodeCursor(time: string, id: string): string {
    return Buffer.from(JSON.stringify([time, id])).toString("base64url");
  }

  private decodeCursor(cursor: string): [string, string] {
    try {
      const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
      if (!Array.isArray(value) || value.length !== 2 || value.some((part) => typeof part !== "string")) throw new Error();
      return value as [string, string];
    } catch {
      throw new Error("Invalid cursor");
    }
  }
}
