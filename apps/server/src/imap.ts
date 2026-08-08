import { ImapFlow } from "imapflow";
import { Transform, type Readable } from "node:stream";
import type { Account, MailboxListResponse, ReadAllResult, SyncFolderConfig, SyncTriggerResult } from "@imap2api/shared";
import { AccountSupervisor, isSelectableCustomMailbox, resolveSystemMailboxes, type ImapClientFactory, type ListedMailbox, type PollScheduler } from "./account-supervisor.js";
import { AppDatabase, type StoredAccount } from "./database.js";
import { EventBroker } from "./events.js";
import { AccountNotFoundError, InputError, MessageNotFoundError } from "./errors.js";
import { HttpError } from "./errors.js";
import { DownloadCancelledError, DownloadLimiter } from "./download-limiter.js";

export interface AttachmentDownload {
  content: Readable;
  filename: string;
  contentType: string;
  expectedSize: number | null;
}

const BYTES_PER_MEGABYTE = 1024 * 1024;

class AttachmentSizeLimitStream extends Transform {
  private bytes = 0;

  constructor(private readonly maximumBytes: number) {
    super();
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null, data?: Buffer) => void): void {
    this.bytes += chunk.length;
    if (this.bytes > this.maximumBytes) {
      callback(new HttpError(413, "ATTACHMENT_TOO_LARGE", "附件超过系统设置的大小上限"));
      return;
    }
    callback(null, chunk);
  }
}

export class ImapService {
  private readonly supervisor: AccountSupervisor;
  private readonly downloadLimiter: DownloadLimiter;
  private readonly activeDownloads = new Set<() => Promise<void>>();

  constructor(
    private readonly db: AppDatabase,
    private readonly events = new EventBroker(),
    private readonly clientFactory: ImapClientFactory = (account) => this.createClient(account),
    schedulePoll: PollScheduler = (delay, callback) => {
      const timer = setTimeout(callback, delay);
      timer.unref();
      return () => clearTimeout(timer);
    }
  ) {
    this.supervisor = new AccountSupervisor(db, events, clientFactory, schedulePoll);
    this.downloadLimiter = new DownloadLimiter(() => this.db.getSettings().maxConcurrentDownloads);
  }

  start(): void {
    this.supervisor.start();
  }

  stop(): Promise<void> {
    this.downloadLimiter.stop();
    return Promise.all([
      this.supervisor.stop(),
      ...[...this.activeDownloads].map((cancel) => cancel())
    ]).then(() => undefined);
  }

  startAccount(accountId: string): void {
    this.supervisor.startAccount(accountId);
  }

  restartAccount(accountId: string): Promise<void> {
    return this.supervisor.restartAccount(accountId);
  }

  removeAccount(accountId: string): Promise<void> {
    return this.supervisor.removeAccount(accountId);
  }

  applySettings(previousPollIntervalSeconds: number): void {
    this.supervisor.applySettings(previousPollIntervalSeconds);
    this.downloadLimiter.refresh();
  }

  triggerSync(accountId: string): SyncTriggerResult {
    return this.supervisor.triggerSync(accountId);
  }

  sync(accountId: string): Promise<void> {
    return this.supervisor.sync(accountId);
  }

  async test(accountId: string): Promise<void> {
    const account = this.requireAccount(accountId);
    const client = this.clientFactory(account);
    try {
      await client.connect();
    } finally {
      if (client.usable) await client.logout().catch(() => undefined);
    }
  }

  async listMailboxes(accountId: string): Promise<MailboxListResponse> {
    const account = this.requireAccount(accountId);
    const mailboxes = await this.discoverMailboxes(account);
    return this.toMailboxList(account, mailboxes);
  }

  async updateSyncFolders(accountId: string, folders: SyncFolderConfig[]): Promise<Account> {
    const account = this.requireAccount(accountId);
    const mailboxes = await this.discoverMailboxes(account);
    const system = resolveSystemMailboxes(mailboxes);
    const available = new Set(mailboxes.filter((box) => isSelectableCustomMailbox(box, system)).map((box) => box.path));
    const existing = new Set(account.syncFolders.map((folder) => folder.path));
    const unavailableNew = folders.find((folder) => !available.has(folder.path) && !existing.has(folder.path));
    if (unavailableNew) throw new InputError(`同步文件夹不可用：${unavailableNew.path}`);

    await this.supervisor.removeAccount(accountId);
    try {
      const result = this.db.updateSyncFolders(accountId, folders);
      if (!result) throw new AccountNotFoundError();
      for (const removed of result.removed) {
        this.events.publish({
          type: "messages.changed", accountId, folder: removed.folder,
          addedIds: [], updatedIds: [], deletedIds: removed.ids, occurredAt: new Date().toISOString()
        });
      }
      return result.account;
    } finally {
      this.supervisor.startAccount(accountId);
    }
  }

  async markRead(messageId: string, read: boolean): Promise<void> {
    const transport = this.db.getMessageTransport(messageId);
    if (!transport) throw new MessageNotFoundError();
    const account = this.requireAccount(transport.accountId);
    const client = this.clientFactory(account);
    try {
      await client.connect();
      const lock = await client.getMailboxLock(transport.mailboxPath);
      try {
        if (read) await client.messageFlagsAdd(transport.uid, ["\\Seen"], { uid: true });
        else await client.messageFlagsRemove(transport.uid, ["\\Seen"], { uid: true });
      } finally {
        lock.release();
      }
      this.db.updateKnownRead(messageId, read);
      this.events.publish({
        type: "messages.changed",
        accountId: transport.accountId,
        folder: transport.folder,
        addedIds: [],
        updatedIds: [messageId],
        deletedIds: [],
        occurredAt: new Date().toISOString()
      });
    } finally {
      if (client.usable) await client.logout().catch(() => undefined);
    }
  }

  async downloadAttachment(messageId: string, attachmentId: string, signal?: AbortSignal): Promise<AttachmentDownload> {
    if (!this.db.hasMessage(messageId)) throw new MessageNotFoundError();
    const transport = this.db.getAttachmentTransport(messageId, attachmentId);
    if (!transport) throw new HttpError(404, "ATTACHMENT_NOT_FOUND", "附件不存在");
    const settings = this.db.getSettings();
    const maximumBytes = settings.maxAttachmentSizeMb * BYTES_PER_MEGABYTE;
    const expectedSize = estimatedDecodedSize(transport.attachment.size, transport.attachment.encoding);
    if (expectedSize !== null && expectedSize > maximumBytes) {
      throw new HttpError(413, "ATTACHMENT_TOO_LARGE", "附件超过系统设置的大小上限");
    }

    const release = await this.downloadLimiter.acquire(signal);
    const account = this.requireAccount(transport.accountId);
    const client = this.clientFactory(account);
    let lock: { release: () => void } | null = null;
    let source: Readable | null = null;
    try {
      await client.connect();
      if (signal?.aborted) throw new DownloadCancelledError();
      lock = await client.getMailboxLock(transport.mailboxPath);
      const currentUidValidity = String(client.mailbox && client.mailbox.uidValidity ? client.mailbox.uidValidity : "");
      if (currentUidValidity !== transport.uidValidity) {
        throw new HttpError(410, "ATTACHMENT_STALE", "邮件已发生变化，请同步后重试");
      }
      const result = await client.download(transport.uid, transport.attachment.part, { uid: true });
      if (!result?.content) throw new HttpError(404, "ATTACHMENT_NOT_FOUND", "远端附件不存在");
      source = result.content;
      const output = new AttachmentSizeLimitStream(maximumBytes);
      const forwardSourceError = (error: Error) => output.destroy(error);
      source.once("error", forwardSourceError);
      source.pipe(output);

      let cleanupPromise: Promise<void> | null = null;
      const cleanup = (): Promise<void> => {
        if (cleanupPromise) return cleanupPromise;
        cleanupPromise = (async () => {
          signal?.removeEventListener("abort", cancel);
          source?.removeListener("error", forwardSourceError);
          source?.destroy();
          lock?.release();
          lock = null;
          if (client.usable) await client.logout().catch(() => undefined);
          release();
        })().finally(() => this.activeDownloads.delete(cancel));
        return cleanupPromise;
      };
      const cancel = (): Promise<void> => {
        output.destroy(new DownloadCancelledError());
        return cleanup();
      };
      this.activeDownloads.add(cancel);
      signal?.addEventListener("abort", cancel, { once: true });
      output.once("end", () => void cleanup());
      output.once("error", () => void cleanup());
      output.once("close", () => void cleanup());
      return {
        content: output,
        filename: transport.attachment.filename,
        contentType: safeContentType(result.meta?.contentType ?? transport.attachment.contentType),
        expectedSize
      };
    } catch (error) {
      source?.destroy();
      lock?.release();
      if (client.usable) await client.logout().catch(() => undefined);
      release();
      throw error;
    }
  }

  async markAllRead(accountId: string): Promise<ReadAllResult> {
    const account = this.requireAccount(accountId);
    const rows = this.db.getUnreadTransports(accountId);
    if (!rows.length) return { count: 0, failedFolders: [] };
    const client = this.clientFactory(account);
    const failedFolders: ReadAllResult["failedFolders"] = [];
    let count = 0;
    try {
      await client.connect();
      const groups = new Map<string, typeof rows>();
      for (const row of rows) groups.set(row.mailboxPath, [...(groups.get(row.mailboxPath) ?? []), row]);
      for (const [mailboxPath, group] of groups) {
        if (!group.length) continue;
        try {
          const lock = await client.getMailboxLock(mailboxPath);
          try {
            await client.messageFlagsAdd(group.map((row) => row.uid), ["\\Seen"], { uid: true });
            for (const row of group) this.db.updateKnownRead(row.id, true);
            this.events.publish({
              type: "messages.changed",
              accountId,
              folder: group[0]!.folder,
              addedIds: [],
              updatedIds: group.map((row) => row.id),
              deletedIds: [],
              occurredAt: new Date().toISOString()
            });
            count += group.length;
          } finally {
            lock.release();
          }
        } catch {
          if (!failedFolders.includes(group[0]!.folder)) failedFolders.push(group[0]!.folder);
        }
      }
      return { count, failedFolders };
    } finally {
      if (client.usable) await client.logout().catch(() => undefined);
    }
  }

  private createClient(account: StoredAccount): ImapFlow {
    const client = new ImapFlow({
      host: account.imap.host,
      port: account.imap.port,
      secure: account.imap.secure,
      auth: { user: account.email, pass: account.password },
      logger: false,
      missingIdleCommand: "STATUS",
      maxIdleTime: 29 * 60 * 1000
    });
    client.on("error", () => undefined);
    return client;
  }

  private async discoverMailboxes(account: StoredAccount): Promise<ListedMailbox[]> {
    const client = this.clientFactory(account);
    try {
      await client.connect();
      return await client.list() as ListedMailbox[];
    } finally {
      if (client.usable) await client.logout().catch(() => undefined);
    }
  }

  private toMailboxList(account: StoredAccount, mailboxes: ListedMailbox[]): MailboxListResponse {
    const system = resolveSystemMailboxes(mailboxes);
    const selected = new Map(account.syncFolders.map((folder) => [folder.path, folder.mode]));
    const counts = this.db.getMailboxCachedCounts(account.id);
    const item = (box: ListedMailbox, kind: "inbox" | "junk" | "custom", selectable: boolean) => ({
      path: box.path,
      name: box.name,
      depth: box.delimiter ? Math.max(0, box.path.split(box.delimiter).length - 1) : 0,
      kind,
      selectable,
      available: true,
      selectedMode: kind === "custom" ? selected.get(box.path) ?? null : null,
      cachedMessageCount: counts.get(this.db.mailboxKey(box.path)) ?? 0
    });
    const items = [
      ...(system.inbox ? [item(system.inbox, "inbox" as const, false)] : []),
      ...(system.junk ? [item(system.junk, "junk" as const, false)] : []),
      ...mailboxes.filter((box) => isSelectableCustomMailbox(box, system)).map((box) => item(box, "custom", true))
    ];
    const known = new Set(items.map((value) => value.path));
    for (const folder of account.syncFolders) {
      if (known.has(folder.path)) continue;
      items.push({
        path: folder.path, name: folder.path, depth: 0, kind: "custom", selectable: true,
        available: false, selectedMode: folder.mode,
        cachedMessageCount: counts.get(this.db.mailboxKey(folder.path)) ?? 0
      });
    }
    return { items };
  }

  private requireAccount(id: string): StoredAccount {
    const account = this.db.getAccount(id);
    if (!account) throw new AccountNotFoundError();
    return account;
  }
}

function estimatedDecodedSize(size: number | null, encoding?: string): number | null {
  if (size === null) return null;
  return encoding === "base64" ? Math.floor(size / 4) * 3 : size;
}

function safeContentType(value: string | undefined): string {
  const normalized = value?.trim().toLowerCase() ?? "";
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(normalized) ? normalized : "application/octet-stream";
}
