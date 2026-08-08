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
  MessageLabel,
  MessageListResponse,
  MessageSecondaryFilter,
  MessageSummary,
  MessageView,
  Settings,
  SyncFolderConfig,
  SyncMode
} from "@imap2api/shared";
import { CryptoService } from "./crypto.js";
import { resolveImapConfig, type ResolvedImapConfig } from "./providers.js";
import { InputError } from "./errors.js";
import { classifyMail, type ForwardedViaResult, type ForwardedViaSource, type MailClassificationResult } from "./mail-classifier.js";

interface AccountConfigPayload {
  email: string;
  aliases?: string[];
  imap: ResolvedImapConfig;
  syncFolders?: SyncFolderConfig[];
}

export interface StoredAccount extends Omit<AccountConfigPayload, "aliases"> {
  id: string;
  aliases: string[];
  syncFolders: SyncFolderConfig[];
  password: string;
  status: ConnectionStatus;
  syncMode: SyncMode | null;
  lastSyncedAt: string | null;
  lastError: string | null;
}

export interface StoredMessageContent {
  htmlPolicyVersion?: number;
  classificationVersion?: number;
  subject: string;
  from: Address[];
  to: Address[];
  cc: Address[];
  preview: string;
  text: string;
  html: string | null;
  attachments: string[];
  labels?: MessageLabel[];
  verificationCode?: string | null;
  unsubscribeUrl?: string | null;
  forwardedVia?: string | null;
  forwardedViaSource?: ForwardedViaSource | null;
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
  sync_mode: SyncMode | null;
  last_sync_at: string | null;
  error_enc: Buffer | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

interface PublicAccountRow extends AccountRow {
  message_count: number;
  unread_count: number;
}

interface MessageRow {
  id: string;
  account_id: string;
  folder_kind: "inbox" | "junk";
  mailbox_key: string;
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
  max_messages_per_account INTEGER NOT NULL DEFAULT 100 CHECK (max_messages_per_account BETWEEN 1 AND 10000),
  poll_interval_seconds INTEGER NOT NULL DEFAULT 10 CHECK (poll_interval_seconds BETWEEN 5 AND 3600),
  page_size INTEGER NOT NULL DEFAULT 100 CHECK (page_size BETWEEN 10 AND 100)
);
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  email_hash TEXT NOT NULL UNIQUE,
  config_enc BLOB NOT NULL,
  credential_enc BLOB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  sync_mode TEXT CHECK (sync_mode IS NULL OR sync_mode IN ('idle', 'polling')),
  last_sync_at TEXT,
  error_enc BLOB,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS folders (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  mailbox_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('inbox', 'junk', 'custom')),
  path_enc BLOB NOT NULL,
  uid_validity TEXT NOT NULL,
  synced_at TEXT NOT NULL,
  PRIMARY KEY (account_id, mailbox_key)
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  folder_kind TEXT NOT NULL CHECK (folder_kind IN ('inbox', 'junk')),
  mailbox_key TEXT NOT NULL,
  mailbox_path_enc BLOB NOT NULL,
  uid INTEGER NOT NULL,
  uid_validity TEXT NOT NULL,
  is_read INTEGER NOT NULL DEFAULT 0,
  display_time TEXT NOT NULL,
  has_attachments INTEGER NOT NULL DEFAULT 0,
  content_enc BLOB NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(account_id, mailbox_key, uid_validity, uid)
);
CREATE INDEX IF NOT EXISTS messages_list_idx ON messages(display_time DESC, id DESC);
CREATE INDEX IF NOT EXISTS messages_account_idx ON messages(account_id, display_time DESC, id DESC);
CREATE INDEX IF NOT EXISTS messages_view_idx ON messages(folder_kind, is_read, display_time DESC);
`;

function asBuffer(value: Buffer | Uint8Array): Buffer {
  return Buffer.isBuffer(value) ? value : Buffer.from(value);
}

export class AppDatabase {
  readonly raw: Database.Database;
  readonly crypto: CryptoService;

  constructor(path: string, token: string, initialPollIntervalSeconds = 10) {
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
    this.migrate();
    this.raw.prepare("INSERT OR IGNORE INTO settings(id, max_messages_per_account, poll_interval_seconds, page_size) VALUES (1, 100, ?, 100)")
      .run(initialPollIntervalSeconds);
  }

  close(): void {
    this.raw.close();
  }

  getSettings(): Settings {
    const row = this.raw.prepare(`SELECT max_messages_per_account AS maxMessagesPerAccount,
      poll_interval_seconds AS pollIntervalSeconds, page_size AS pageSize FROM settings WHERE id = 1`).get() as Settings;
    return row;
  }

  updateSettings(input: Partial<Settings>): { settings: Settings; deleted: Array<{ accountId: string; folder: "inbox" | "junk"; ids: string[] }> } {
    return this.raw.transaction(() => {
      const current = this.getSettings();
      const next = { ...current, ...input };
      this.raw.prepare("UPDATE settings SET max_messages_per_account = ?, poll_interval_seconds = ?, page_size = ? WHERE id = 1")
        .run(next.maxMessagesPerAccount, next.pollIntervalSeconds, next.pageSize);
      const deleted: Array<{ accountId: string; folder: "inbox" | "junk"; ids: string[] }> = [];
      if (next.maxMessagesPerAccount !== current.maxMessagesPerAccount) {
        for (const { id } of this.raw.prepare("SELECT id FROM accounts").all() as Array<{ id: string }>) {
          for (const removed of this.enforceRetention(id)) {
            const group = deleted.find((item) => item.accountId === id && item.folder === removed.folder);
            if (group) group.ids.push(removed.id);
            else deleted.push({ accountId: id, folder: removed.folder, ids: [removed.id] });
          }
        }
      }
      return { settings: this.getSettings(), deleted };
    })();
  }

  listAccounts(): Account[] {
    return (this.raw.prepare(`SELECT accounts.*,
      (SELECT COUNT(*) FROM messages WHERE messages.account_id = accounts.id) AS message_count,
      (SELECT COUNT(*) FROM messages WHERE messages.account_id = accounts.id AND messages.is_read = 0) AS unread_count
      FROM accounts ORDER BY accounts.sort_order ASC, accounts.created_at ASC, accounts.id ASC`).all() as PublicAccountRow[]).map((row) => this.toPublicAccount(row));
  }

  reorderAccounts(accountIds: string[]): Account[] {
    return this.raw.transaction(() => {
      const existing = (this.raw.prepare("SELECT id FROM accounts").all() as Array<{ id: string }>).map((row) => row.id);
      if (accountIds.length !== existing.length || new Set(accountIds).size !== existing.length || accountIds.some((id) => !existing.includes(id))) {
        throw new InputError("账号排序数据无效");
      }
      const update = this.raw.prepare("UPDATE accounts SET sort_order = ? WHERE id = ?");
      accountIds.forEach((id, index) => update.run(index, id));
      return this.listAccounts();
    })();
  }

  getAccount(id: string): StoredAccount | null {
    const row = this.raw.prepare("SELECT * FROM accounts WHERE id = ?").get(id) as AccountRow | undefined;
    if (!row) return null;
    const config = this.crypto.decrypt<AccountConfigPayload>(asBuffer(row.config_enc));
    return {
      id: row.id,
      email: config.email,
      aliases: config.aliases ?? [],
      syncFolders: config.syncFolders ?? [],
      imap: config.imap,
      password: this.crypto.decrypt<string>(asBuffer(row.credential_enc)),
      status: row.status,
      syncMode: row.sync_mode,
      lastSyncedAt: row.last_sync_at,
      lastError: row.error_enc ? this.crypto.decrypt<string>(asBuffer(row.error_enc)) : null
    };
  }

  createAccount(input: AccountInput): Account {
    const now = new Date().toISOString();
    const id = randomUUID();
    const email = input.email.trim().toLowerCase();
    const aliases = normalizeAliases(email, input.aliases ?? []);
    const imap = resolveImapConfig(email, input.imap);
    const sortOrder = (this.raw.prepare("SELECT COALESCE(MAX(sort_order), -1) + 1 AS value FROM accounts").get() as { value: number }).value;
    this.raw.prepare(`
      INSERT INTO accounts(id, email_hash, config_enc, credential_enc, status, sort_order, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)
    `).run(id, this.crypto.fingerprint(email), this.crypto.encrypt({ email, aliases, imap, syncFolders: [] }), this.crypto.encrypt(input.password), sortOrder, now, now);
    return this.toPublicAccount(this.selectPublicAccount(id));
  }

  updateAccount(id: string, input: AccountUpdate): Account | null {
    const current = this.getAccount(id);
    if (!current) return null;
    const email = (input.email ?? current.email).trim().toLowerCase();
    const aliases = normalizeAliases(email, input.aliases ?? current.aliases);
    const imap = resolveImapConfig(email, input.imap ?? current.imap);
    const now = new Date().toISOString();
    const credential = input.password ? this.crypto.encrypt(input.password) : this.crypto.encrypt(current.password);
    this.raw.prepare(`
      UPDATE accounts SET email_hash = ?, config_enc = ?, credential_enc = ?, status = 'pending',
        sync_mode = NULL, error_enc = NULL, updated_at = ? WHERE id = ?
    `).run(this.crypto.fingerprint(email), this.crypto.encrypt({
      email, aliases, imap, syncFolders: current.syncFolders
    }), credential, now, id);
    return this.toPublicAccount(this.selectPublicAccount(id));
  }

  updateSyncFolders(id: string, folders: SyncFolderConfig[]): { account: Account; removed: Array<{ folder: "inbox"; ids: string[] }> } | null {
    const current = this.getAccount(id);
    if (!current) return null;
    validateSyncFolders(folders);
    const selected = new Set(folders.map((folder) => folder.path));
    const removedPaths = current.syncFolders.map((folder) => folder.path).filter((path) => !selected.has(path));
    const result = this.raw.transaction(() => {
      const removed: Array<{ folder: "inbox"; ids: string[] }> = [];
      for (const path of removedPaths) {
        const ids = this.resetMailbox(id, path);
        if (ids.length) removed.push({ folder: "inbox", ids });
      }
      const row = this.raw.prepare("SELECT config_enc FROM accounts WHERE id = ?").get(id) as { config_enc: Buffer };
      const config = this.crypto.decrypt<AccountConfigPayload>(asBuffer(row.config_enc));
      this.raw.prepare(`UPDATE accounts SET config_enc = ?, status = 'pending', sync_mode = NULL,
        error_enc = NULL, updated_at = ? WHERE id = ?`)
        .run(this.crypto.encrypt({ ...config, syncFolders: folders }), new Date().toISOString(), id);
      return { account: this.toPublicAccount(this.selectPublicAccount(id)), removed };
    })();
    return result;
  }

  mailboxKey(path: string): string {
    return this.crypto.mailboxFingerprint(path);
  }

  getMailboxCachedCounts(accountId: string): Map<string, number> {
    const rows = this.raw.prepare(`SELECT mailbox_key AS mailboxKey, COUNT(*) AS count FROM messages
      WHERE account_id = ? GROUP BY mailbox_key`).all(accountId) as Array<{ mailboxKey: string; count: number }>;
    return new Map(rows.map((row) => [row.mailboxKey, row.count]));
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

  setAccountSyncMode(id: string, syncMode: SyncMode | null): void {
    this.raw.prepare("UPDATE accounts SET sync_mode = ?, updated_at = ? WHERE id = ?")
      .run(syncMode, new Date().toISOString(), id);
  }

  getFolderState(accountId: string, path: string): { path: string; uidValidity: string } | null {
    const row = this.raw.prepare("SELECT path_enc, uid_validity FROM folders WHERE account_id = ? AND mailbox_key = ?")
      .get(accountId, this.mailboxKey(path)) as { path_enc: Buffer; uid_validity: string } | undefined;
    return row ? { path: this.crypto.decrypt<string>(asBuffer(row.path_enc)), uidValidity: row.uid_validity } : null;
  }

  setFolderState(accountId: string, kind: "inbox" | "junk" | "custom", path: string, uidValidity: string): void {
    this.raw.prepare(`
      INSERT INTO folders(account_id, mailbox_key, kind, path_enc, uid_validity, synced_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id, mailbox_key) DO UPDATE SET kind = excluded.kind, path_enc = excluded.path_enc,
        uid_validity = excluded.uid_validity, synced_at = excluded.synced_at
    `).run(accountId, this.mailboxKey(path), kind, this.crypto.encrypt(path), uidValidity, new Date().toISOString());
  }

  resetMailbox(accountId: string, path: string): string[] {
    const mailboxKey = this.mailboxKey(path);
    const ids = (this.raw.prepare("SELECT id FROM messages WHERE account_id = ? AND mailbox_key = ?")
      .all(accountId, mailboxKey) as Array<{ id: string }>).map((row) => row.id);
    this.raw.prepare("DELETE FROM messages WHERE account_id = ? AND mailbox_key = ?").run(accountId, mailboxKey);
    this.raw.prepare("DELETE FROM folders WHERE account_id = ? AND mailbox_key = ?").run(accountId, mailboxKey);
    return ids;
  }

  resetMailboxesByKind(accountId: string, kind: "inbox" | "junk" | "custom"): string[] {
    const rows = this.raw.prepare("SELECT path_enc FROM folders WHERE account_id = ? AND kind = ?")
      .all(accountId, kind) as Array<{ path_enc: Buffer }>;
    return rows.flatMap((row) => this.resetMailbox(accountId, this.crypto.decrypt<string>(asBuffer(row.path_enc))));
  }

  getKnownMessage(accountId: string, path: string, uidValidity: string, uid: number): { id: string; read: boolean; htmlPolicyVersion: number; classificationVersion: number } | null {
    const row = this.raw.prepare(`SELECT id, is_read, content_enc FROM messages
      WHERE account_id = ? AND mailbox_key = ? AND uid_validity = ? AND uid = ?`)
      .get(accountId, this.mailboxKey(path), uidValidity, uid) as { id: string; is_read: number; content_enc: Buffer } | undefined;
    if (!row) return null;
    const content = this.crypto.decrypt<StoredMessageContent>(asBuffer(row.content_enc));
    return {
      id: row.id, read: Boolean(row.is_read), htmlPolicyVersion: content.htmlPolicyVersion ?? 0,
      classificationVersion: content.classificationVersion ?? 0
    };
  }

  reclassifyMessage(id: string, account: StoredAccount, forwardedVia?: ForwardedViaResult | null): boolean {
    const row = this.raw.prepare("SELECT content_enc FROM messages WHERE id = ?").get(id) as { content_enc: Buffer } | undefined;
    if (!row) return false;
    const content = this.crypto.decrypt<StoredMessageContent>(asBuffer(row.content_enc));
    const classification = classifyStoredContent(account, content, forwardedVia);
    const changed = classificationChanged(content, classification);
    this.raw.prepare("UPDATE messages SET content_enc = ?, updated_at = ? WHERE id = ?")
      .run(this.crypto.encrypt({ ...content, ...classification }), new Date().toISOString(), id);
    return changed;
  }

  reclassifyAccountMessages(account: StoredAccount): Array<{ folder: "inbox" | "junk"; ids: string[] }> {
    return this.raw.transaction(() => {
      const rows = this.raw.prepare("SELECT id, folder_kind, content_enc FROM messages WHERE account_id = ?")
        .all(account.id) as Array<Pick<MessageRow, "id" | "folder_kind" | "content_enc">>;
      const groups: Array<{ folder: "inbox" | "junk"; ids: string[] }> = [];
      for (const row of rows) {
        const content = this.crypto.decrypt<StoredMessageContent>(asBuffer(row.content_enc));
        const classification = classifyStoredContent(account, content);
        const changed = classificationChanged(content, classification);
        this.raw.prepare("UPDATE messages SET content_enc = ?, updated_at = ? WHERE id = ?")
          .run(this.crypto.encrypt({ ...content, ...classification }), new Date().toISOString(), row.id);
        if (!changed) continue;
        const group = groups.find((item) => item.folder === row.folder_kind);
        if (group) group.ids.push(row.id);
        else groups.push({ folder: row.folder_kind, ids: [row.id] });
      }
      return groups;
    })();
  }

  updateKnownRead(id: string, read: boolean): void {
    this.raw.prepare("UPDATE messages SET is_read = ?, updated_at = ? WHERE id = ?").run(read ? 1 : 0, new Date().toISOString(), id);
  }

  hasMessage(id: string): boolean {
    return Boolean(this.raw.prepare("SELECT 1 FROM messages WHERE id = ?").get(id));
  }

  isInRetentionWindow(accountId: string, displayTime: string, folder: "inbox" | "junk", path: string, uid: number): boolean {
    const max = this.getSettings().maxMessagesPerAccount;
    const count = (this.raw.prepare("SELECT COUNT(*) AS count FROM messages WHERE account_id = ?").get(accountId) as { count: number }).count;
    if (count < max) return true;
    const cutoff = this.raw.prepare(`SELECT display_time AS displayTime, folder_kind AS folder, mailbox_key AS mailboxKey, uid
      FROM messages WHERE account_id = ?
      ORDER BY display_time DESC, folder_kind ASC, mailbox_key ASC, uid DESC LIMIT 1 OFFSET ?`)
      .get(accountId, max - 1) as { displayTime: string; folder: "inbox" | "junk"; mailboxKey: string; uid: number } | undefined;
    if (!cutoff || displayTime !== cutoff.displayTime) return !cutoff || displayTime > cutoff.displayTime;
    if (folder !== cutoff.folder) return folder < cutoff.folder;
    const mailboxKey = this.mailboxKey(path);
    if (mailboxKey !== cutoff.mailboxKey) return mailboxKey < cutoff.mailboxKey;
    return uid > cutoff.uid;
  }

  upsertMessage(message: SyncedMessage): string {
    const now = new Date().toISOString();
    const id = message.id ?? randomUUID();
    this.raw.prepare(`
      INSERT INTO messages(id, account_id, folder_kind, mailbox_key, mailbox_path_enc, uid, uid_validity, is_read,
        display_time, has_attachments, content_enc, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id, mailbox_key, uid_validity, uid) DO UPDATE SET
        is_read = excluded.is_read, display_time = excluded.display_time,
        has_attachments = excluded.has_attachments, content_enc = excluded.content_enc, updated_at = excluded.updated_at
    `).run(
      id, message.accountId, message.folder, this.mailboxKey(message.mailboxPath), this.crypto.encrypt(message.mailboxPath),
      message.uid, message.uidValidity, message.read ? 1 : 0, message.displayTime,
      message.content.attachments.length ? 1 : 0, this.crypto.encrypt(message.content), now, now
    );
    return id;
  }

  removeMissingFolderMessages(accountId: string, path: string, uidValidity: string, retainedUids: number[]): string[] {
    const mailboxKey = this.mailboxKey(path);
    const suffix = retainedUids.length ? `AND (uid_validity != ? OR uid NOT IN (${retainedUids.map(() => "?").join(",")}))` : "";
    const params: unknown[] = retainedUids.length ? [accountId, mailboxKey, uidValidity, ...retainedUids] : [accountId, mailboxKey];
    const ids = (this.raw.prepare(`SELECT id FROM messages WHERE account_id = ? AND mailbox_key = ? ${suffix}`).all(...params) as Array<{ id: string }>).map((row) => row.id);
    if (!retainedUids.length) {
      this.raw.prepare("DELETE FROM messages WHERE account_id = ? AND mailbox_key = ?").run(accountId, mailboxKey);
      return ids;
    }
    const placeholders = retainedUids.map(() => "?").join(",");
    this.raw.prepare(`DELETE FROM messages WHERE account_id = ? AND mailbox_key = ?
      AND (uid_validity != ? OR uid NOT IN (${placeholders}))`).run(accountId, mailboxKey, uidValidity, ...retainedUids);
    return ids;
  }

  enforceRetention(accountId: string): Array<{ id: string; folder: "inbox" | "junk" }> {
    const max = this.getSettings().maxMessagesPerAccount;
    const removed = this.raw.prepare(`SELECT id, folder_kind AS folder FROM messages WHERE account_id = ? AND id NOT IN (
      SELECT id FROM messages WHERE account_id = ? ORDER BY display_time DESC, folder_kind ASC, mailbox_key ASC, uid DESC LIMIT ?
    )`).all(accountId, accountId, max) as Array<{ id: string; folder: "inbox" | "junk" }>;
    this.raw.prepare(`DELETE FROM messages WHERE account_id = ? AND id NOT IN (
      SELECT id FROM messages WHERE account_id = ? ORDER BY display_time DESC, folder_kind ASC, mailbox_key ASC, uid DESC LIMIT ?
    )`).run(accountId, accountId, max);
    return removed;
  }

  listMessages(options: { accountId?: string; view: MessageView; filter?: MessageSecondaryFilter[]; after?: string; before?: string; cursor?: string; limit: number }): MessageListResponse {
    const conditions: string[] = [];
    const params: unknown[] = [];
    const filters = options.filter ?? [];
    const labelFilters = filters.filter((filter): filter is Extract<MessageSecondaryFilter, MessageLabel> => filter !== "attachment");
    if (options.accountId) { conditions.push("account_id = ?"); params.push(options.accountId); }
    if (options.view === "unread") conditions.push("is_read = 0");
    if (options.view === "junk") conditions.push("folder_kind = 'junk'");
    if (filters.includes("attachment")) conditions.push("has_attachments = 1");
    if (options.after) { conditions.push("display_time >= ?"); params.push(options.after); }
    if (options.before) { conditions.push("display_time < ?"); params.push(options.before); }
    let scanCursor = options.cursor ? this.decodeCursor(options.cursor) : null;
    const rows: MessageRow[] = [];
    const batchSize = labelFilters.length ? Math.max(100, options.limit * 2) : options.limit + 1;
    while (rows.length <= options.limit) {
      const batchConditions = [...conditions];
      const batchParams = [...params];
      if (scanCursor) {
        batchConditions.push("(display_time < ? OR (display_time = ? AND id < ?))");
        batchParams.push(scanCursor[0], scanCursor[0], scanCursor[1]);
      }
      const where = batchConditions.length ? `WHERE ${batchConditions.join(" AND ")}` : "";
      const batch = this.raw.prepare(`SELECT * FROM messages ${where} ORDER BY display_time DESC, id DESC LIMIT ?`)
        .all(...batchParams, batchSize) as MessageRow[];
      for (const row of batch) {
        const labels = labelFilters.length ? (this.crypto.decrypt<StoredMessageContent>(asBuffer(row.content_enc)).labels ?? []) : [];
        if (labelFilters.every((filter) => labels.includes(filter))) rows.push(row);
      }
      if (rows.length > options.limit || batch.length < batchSize) break;
      const tail = batch.at(-1);
      if (!tail) break;
      scanCursor = [tail.display_time, tail.id];
    }
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
    return {
      ...summary, to: content.to, cc: content.cc, attachments: content.attachments, text: content.text, html: content.html,
      verificationCode: content.verificationCode ?? null, unsubscribeUrl: content.unsubscribeUrl ?? null
    };
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

  private selectPublicAccount(id: string): PublicAccountRow {
    return this.raw.prepare(`SELECT accounts.*,
      (SELECT COUNT(*) FROM messages WHERE messages.account_id = accounts.id) AS message_count,
      (SELECT COUNT(*) FROM messages WHERE messages.account_id = accounts.id AND messages.is_read = 0) AS unread_count
      FROM accounts WHERE accounts.id = ?`).get(id) as PublicAccountRow;
  }

  private toPublicAccount(row: AccountRow | PublicAccountRow): Account {
    const config = this.crypto.decrypt<AccountConfigPayload>(asBuffer(row.config_enc));
    return {
      id: row.id, email: config.email, aliases: config.aliases ?? [], provider: config.imap.provider, imap: config.imap,
      hasCredential: true, status: row.status, syncMode: row.sync_mode,
      messageCount: "message_count" in row ? row.message_count : 0,
      unreadCount: "unread_count" in row ? row.unread_count : 0,
      syncFolderCount: config.syncFolders?.length ?? 0, lastSyncedAt: row.last_sync_at,
      lastError: row.error_enc ? this.crypto.decrypt<string>(asBuffer(row.error_enc)) : null,
      createdAt: row.created_at, updatedAt: row.updated_at
    };
  }

  private toMessageSummary(row: MessageRow, accountEmail: string): MessageSummary {
    const content = this.crypto.decrypt<StoredMessageContent>(asBuffer(row.content_enc));
    return {
      id: row.id, accountId: row.account_id, accountEmail, subject: content.subject,
      from: content.from, preview: content.preview, displayTime: row.display_time,
      folder: row.folder_kind, read: Boolean(row.is_read), hasAttachments: Boolean(row.has_attachments),
      labels: content.labels ?? [], forwardedVia: content.forwardedVia ?? null
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
      throw new InputError("分页游标无效");
    }
  }

  private migrate(): void {
    const settingsColumns = new Set((this.raw.pragma("table_info(settings)") as Array<{ name: string }>).map((column) => column.name));
    if (!settingsColumns.has("poll_interval_seconds")) {
      this.raw.exec("ALTER TABLE settings ADD COLUMN poll_interval_seconds INTEGER NOT NULL DEFAULT 10 CHECK (poll_interval_seconds BETWEEN 5 AND 3600)");
    }
    if (!settingsColumns.has("page_size")) {
      this.raw.exec("ALTER TABLE settings ADD COLUMN page_size INTEGER NOT NULL DEFAULT 100 CHECK (page_size BETWEEN 10 AND 100)");
    }
    const accountColumns = new Set((this.raw.pragma("table_info(accounts)") as Array<{ name: string }>).map((column) => column.name));
    if (!accountColumns.has("sync_mode")) {
      this.raw.exec("ALTER TABLE accounts ADD COLUMN sync_mode TEXT CHECK (sync_mode IS NULL OR sync_mode IN ('idle', 'polling'))");
    }
    if (!accountColumns.has("sort_order")) {
      this.raw.exec("ALTER TABLE accounts ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0");
      const rows = this.raw.prepare("SELECT id FROM accounts ORDER BY created_at ASC, id ASC").all() as Array<{ id: string }>;
      const update = this.raw.prepare("UPDATE accounts SET sort_order = ? WHERE id = ?");
      this.raw.transaction(() => rows.forEach((row, index) => update.run(index, row.id)))();
    }
    const messageColumns = new Set((this.raw.pragma("table_info(messages)") as Array<{ name: string }>).map((column) => column.name));
    if (!messageColumns.has("mailbox_key")) this.migrateMailboxSchema();
    this.raw.pragma("user_version = 5");
  }

  private migrateMailboxSchema(): void {
    type LegacyFolderRow = { account_id: string; kind: "inbox" | "junk"; path_enc: Buffer; uid_validity: string; synced_at: string };
    type LegacyMessageRow = Omit<MessageRow, "mailbox_key"> & { created_at: string; updated_at: string };
    const folders = this.raw.prepare("SELECT * FROM folders").all() as LegacyFolderRow[];
    const messages = this.raw.prepare("SELECT * FROM messages").all() as LegacyMessageRow[];
    this.raw.pragma("foreign_keys = OFF");
    try {
      this.raw.transaction(() => {
        this.raw.exec(`
          DROP INDEX IF EXISTS messages_list_idx;
          DROP INDEX IF EXISTS messages_account_idx;
          DROP INDEX IF EXISTS messages_view_idx;
          ALTER TABLE folders RENAME TO folders_legacy;
          ALTER TABLE messages RENAME TO messages_legacy;
          CREATE TABLE folders (
            account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
            mailbox_key TEXT NOT NULL,
            kind TEXT NOT NULL CHECK (kind IN ('inbox', 'junk', 'custom')),
            path_enc BLOB NOT NULL,
            uid_validity TEXT NOT NULL,
            synced_at TEXT NOT NULL,
            PRIMARY KEY (account_id, mailbox_key)
          );
          CREATE TABLE messages (
            id TEXT PRIMARY KEY,
            account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
            folder_kind TEXT NOT NULL CHECK (folder_kind IN ('inbox', 'junk')),
            mailbox_key TEXT NOT NULL,
            mailbox_path_enc BLOB NOT NULL,
            uid INTEGER NOT NULL,
            uid_validity TEXT NOT NULL,
            is_read INTEGER NOT NULL DEFAULT 0,
            display_time TEXT NOT NULL,
            has_attachments INTEGER NOT NULL DEFAULT 0,
            content_enc BLOB NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE(account_id, mailbox_key, uid_validity, uid)
          );
        `);
        const insertFolder = this.raw.prepare(`INSERT INTO folders
          (account_id, mailbox_key, kind, path_enc, uid_validity, synced_at) VALUES (?, ?, ?, ?, ?, ?)`);
        for (const row of folders) {
          const path = this.crypto.decrypt<string>(asBuffer(row.path_enc));
          insertFolder.run(row.account_id, this.mailboxKey(path), row.kind, row.path_enc, row.uid_validity, row.synced_at);
        }
        const insertMessage = this.raw.prepare(`INSERT INTO messages
          (id, account_id, folder_kind, mailbox_key, mailbox_path_enc, uid, uid_validity, is_read,
            display_time, has_attachments, content_enc, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        for (const row of messages) {
          const path = this.crypto.decrypt<string>(asBuffer(row.mailbox_path_enc));
          insertMessage.run(row.id, row.account_id, row.folder_kind, this.mailboxKey(path), row.mailbox_path_enc,
            row.uid, row.uid_validity, row.is_read, row.display_time, row.has_attachments, row.content_enc,
            row.created_at, row.updated_at);
        }
        this.raw.exec(`
          DROP TABLE folders_legacy;
          DROP TABLE messages_legacy;
          CREATE INDEX messages_list_idx ON messages(display_time DESC, id DESC);
          CREATE INDEX messages_account_idx ON messages(account_id, display_time DESC, id DESC);
          CREATE INDEX messages_view_idx ON messages(folder_kind, is_read, display_time DESC);
        `);
      })();
    } finally {
      this.raw.pragma("foreign_keys = ON");
    }
  }
}

function normalizeAliases(email: string, values: string[]): string[] {
  if (values.length > 50) throw new InputError("最多配置 50 个别名邮箱");
  const aliases = values.map((value) => value.trim().toLowerCase());
  if (aliases.some((value) => value.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value))) {
    throw new InputError("别名邮箱格式无效");
  }
  if (aliases.some((value) => value === email)) throw new InputError("别名邮箱不能与主邮箱相同");
  if (new Set(aliases).size !== aliases.length) throw new InputError("别名邮箱不能重复");
  return aliases;
}

function validateSyncFolders(folders: SyncFolderConfig[]): void {
  if (folders.length > 20) throw new InputError("每个账号最多同步 20 个自定义文件夹");
  if (folders.filter((folder) => folder.mode === "idle").length > 5) throw new InputError("每个账号最多为 5 个自定义文件夹启用 IDLE");
  if (folders.some((folder) => !folder.path || folder.path.length > 1000)) throw new InputError("同步文件夹路径无效");
  if (new Set(folders.map((folder) => folder.path)).size !== folders.length) throw new InputError("同步文件夹不能重复");
}

function classifyStoredContent(account: StoredAccount, content: StoredMessageContent, forwardedVia?: ForwardedViaResult | null): MailClassificationResult {
  const preserved = content.forwardedVia && content.forwardedViaSource && content.forwardedViaSource !== "recipient"
    ? { address: content.forwardedVia, source: content.forwardedViaSource }
    : undefined;
  const resolved = forwardedVia === undefined ? preserved : forwardedVia;
  return classifyMail({
    accountEmail: account.email, aliases: account.aliases, to: content.to, cc: content.cc,
    text: content.text, html: content.html, ...(resolved === undefined ? {} : { forwardedVia: resolved })
  });
}

function classificationChanged(content: StoredMessageContent, next: MailClassificationResult): boolean {
  return JSON.stringify(content.labels ?? []) !== JSON.stringify(next.labels)
    || (content.verificationCode ?? null) !== next.verificationCode
    || (content.unsubscribeUrl ?? null) !== next.unsubscribeUrl
    || (content.forwardedVia ?? null) !== next.forwardedVia
    || (content.forwardedViaSource ?? null) !== next.forwardedViaSource;
}
