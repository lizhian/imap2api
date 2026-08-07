import { ImapFlow } from "imapflow";
import type { ReadAllResult, SyncTriggerResult } from "@imap2api/shared";
import { AccountSupervisor, type ImapClientFactory, type PollScheduler } from "./account-supervisor.js";
import { AppDatabase, type StoredAccount } from "./database.js";
import { EventBroker } from "./events.js";
import { AccountNotFoundError, MessageNotFoundError } from "./errors.js";

export class ImapService {
  private readonly supervisor: AccountSupervisor;

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
  }

  start(): void {
    this.supervisor.start();
  }

  stop(): Promise<void> {
    return this.supervisor.stop();
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

  async markAllRead(accountId: string): Promise<ReadAllResult> {
    const account = this.requireAccount(accountId);
    const rows = this.db.getUnreadTransports(accountId);
    if (!rows.length) return { count: 0, failedFolders: [] };
    const client = this.clientFactory(account);
    const failedFolders: ReadAllResult["failedFolders"] = [];
    let count = 0;
    try {
      await client.connect();
      for (const kind of ["inbox", "junk"] as const) {
        const group = rows.filter((row) => row.folder === kind);
        if (!group.length) continue;
        try {
          const lock = await client.getMailboxLock(group[0]!.mailboxPath);
          try {
            await client.messageFlagsAdd(group.map((row) => row.uid), ["\\Seen"], { uid: true });
            for (const row of group) this.db.updateKnownRead(row.id, true);
            this.events.publish({
              type: "messages.changed",
              accountId,
              folder: kind,
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
          failedFolders.push(kind);
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

  private requireAccount(id: string): StoredAccount {
    const account = this.db.getAccount(id);
    if (!account) throw new AccountNotFoundError();
    return account;
  }
}
