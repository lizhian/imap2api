import { ImapFlow } from "imapflow";
import type { ConnectionStatus, FolderKind, SyncMode, SyncTriggerResult } from "@imap2api/shared";
import { AppDatabase, type StoredAccount } from "./database.js";
import { EventBroker } from "./events.js";
import { AccountNotFoundError } from "./errors.js";
import { MailboxSynchronizer } from "./mail-sync.js";

const JUNK_NAMES = new Set(["junk", "spam", "bulk mail", "垃圾邮件", "垃圾箱", "广告邮件"]);

export type ImapClientFactory = (account: StoredAccount) => ImapFlow;
export type PollScheduler = (delay: number, callback: () => void) => () => void;

export class AccountSupervisor {
  private readonly accountQueues = new Map<string, Promise<void>>();
  private readonly accounts = new Map<string, AccountState>();
  private readonly synchronizer: MailboxSynchronizer;
  private stopped = false;

  constructor(
    private readonly db: AppDatabase,
    private readonly events: EventBroker,
    private readonly clientFactory: ImapClientFactory,
    private readonly schedulePoll: PollScheduler
  ) {
    this.synchronizer = new MailboxSynchronizer(db, events);
  }

  start(): void {
    this.stopped = false;
    for (const account of this.db.listAccounts()) this.startAccount(account.id);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await Promise.allSettled([...this.accounts.keys()].map((accountId) => this.removeAccount(accountId)));
  }

  startAccount(accountId: string): void {
    if (this.stopped || this.accounts.has(accountId)) return;
    let readyResolve!: () => void;
    const ready = new Promise<void>((resolve) => { readyResolve = resolve; });
    const account: AccountState = {
      accountId,
      stopped: false,
      sessions: new Map(),
      discoveryClient: null,
      retryResolve: null,
      ready,
      readyResolve,
      loop: Promise.resolve()
    };
    account.loop = this.initialize(account);
    this.accounts.set(accountId, account);
  }

  async restartAccount(accountId: string): Promise<void> {
    await this.removeAccount(accountId);
    this.startAccount(accountId);
  }

  async removeAccount(accountId: string): Promise<void> {
    const account = this.accounts.get(accountId);
    if (!account) return;
    this.accounts.delete(accountId);
    account.stopped = true;
    account.readyResolve();
    account.retryResolve?.();
    account.discoveryClient?.close();
    for (const session of account.sessions.values()) this.stopSession(session);
    await Promise.allSettled([...account.sessions.values()].map((session) => session.loop ?? Promise.resolve()));
  }

  applySettings(previousPollIntervalSeconds: number): void {
    if (this.db.getSettings().pollIntervalSeconds === previousPollIntervalSeconds) return;
    for (const account of this.accounts.values()) {
      for (const session of account.sessions.values()) {
        if (session.mode === "polling") session.pollWake?.("reschedule");
      }
    }
  }

  triggerSync(accountId: string): SyncTriggerResult {
    this.requireAccount(accountId);
    this.startAccount(accountId);
    const account = this.accounts.get(accountId);
    if (!account) throw new Error("邮箱同步服务已停止");
    const sessions = [...account.sessions.values()].filter((session) => session.client?.usable);
    const running = sessions.some((session) => Boolean(session.syncPromise));
    for (const session of sessions) void this.enqueueSync(session).catch((error) => this.failSession(session, error));
    return { status: running ? "running" : "started" };
  }

  async sync(accountId: string): Promise<void> {
    this.requireAccount(accountId);
    this.startAccount(accountId);
    const account = this.accounts.get(accountId);
    if (!account) throw new Error("邮箱同步服务已停止");
    await account.ready;
    await Promise.all([...account.sessions.values()].map((session) => session.firstReady));
    await Promise.all([...account.sessions.values()].map((session) => this.enqueueSync(session)));
  }

  private async initialize(accountState: AccountState): Promise<void> {
    let attempt = 0;
    while (!accountState.stopped && !this.stopped) {
      let client: ImapFlow | null = null;
      try {
        const account = this.requireAccount(accountState.accountId);
        client = this.clientFactory(account);
        accountState.discoveryClient = client;
        this.setAccountState(account.id, "connecting", null, false, null);
        await client.connect();
        if (accountState.stopped || this.stopped) {
          if (client.usable) client.close();
          return;
        }
        const mailboxes = await client.list();
        if (accountState.stopped || this.stopped) {
          if (client.usable) client.close();
          return;
        }
        const inbox = mailboxes.find((box) => box.path.toUpperCase() === "INBOX" || box.specialUse === "\\Inbox");
        const junk = mailboxes.find((box) => box.specialUse === "\\Junk") ??
          mailboxes.find((box) => JUNK_NAMES.has(box.name.toLowerCase()) || JUNK_NAMES.has(box.path.toLowerCase()));
        if (!inbox) throw new Error("IMAP 服务器未返回收件箱");
        if (client.usable) await client.logout().catch(() => undefined);
        if (accountState.stopped || this.stopped) return;
        accountState.discoveryClient = null;
        accountState.missingJunk = !junk;
        if (!junk) {
          const deletedIds = this.db.resetFolder(account.id, "junk");
          this.synchronizer.publishChange({ accountId: account.id, folder: "junk", addedIds: [], updatedIds: [], deletedIds });
        }
        const folders: Array<{ kind: FolderKind; path: string }> = [
          { kind: "inbox", path: inbox.path },
          ...(junk ? [{ kind: "junk" as const, path: junk.path }] : [])
        ];
        for (const folder of folders) {
          const session = this.createSession(accountState, folder.kind, folder.path);
          accountState.sessions.set(folder.kind, session);
          session.loop = this.runSession(session);
        }
        accountState.readyResolve();
        return;
      } catch (error) {
        accountState.discoveryClient = null;
        if (client?.usable) await client.logout().catch(() => undefined);
        if (accountState.stopped || this.stopped) return;
        this.setAccountState(accountState.accountId, "error", errorMessage(error), false, null);
        await this.waitForRetry(accountState, attempt++);
      }
    }
  }

  private createSession(account: AccountState, kind: FolderKind, path: string): FolderSession {
    let readyResolve!: () => void;
    const firstReady = new Promise<void>((resolve) => { readyResolve = resolve; });
    return {
      account,
      kind,
      path,
      client: null,
      mode: null,
      uidValidity: null,
      stopped: false,
      state: "connecting",
      error: null,
      syncRequested: false,
      syncPromise: null,
      idlePromise: null,
      loop: null,
      retryResolve: null,
      pollLoop: null,
      pollWake: null,
      failure: null,
      firstReady,
      readyResolve
    };
  }

  private async runSession(session: FolderSession): Promise<void> {
    let attempt = 0;
    while (!session.stopped && !session.account.stopped && !this.stopped) {
      session.state = "connecting";
      session.error = null;
      this.updateAccountState(session.account, false);
      const account = this.requireAccount(session.account.accountId);
      const client = this.clientFactory(account);
      session.client = client;
      session.failure = null;
      let closeResolve!: () => void;
      const closed = new Promise<void>((resolve) => { closeResolve = resolve; });
      const onClose = () => closeResolve();
      const onError = (error: unknown) => { session.failure = error; closeResolve(); };
      client.once("close", onClose);
      client.on("error", onError);
      try {
        await client.connect();
        const mode = supportsIdle(client) ? "idle" : "polling";
        session.mode = mode;
        (client as ImapFlow & { maxIdleTime: number }).maxIdleTime = 29 * 60 * 1000;
        if (mode === "polling") {
          (client as ImapFlow & { options: { disableAutoIdle?: boolean } }).options.disableAutoIdle = true;
        }
        this.attachSessionEvents(session, client);
        await this.enqueueSync(session);
        session.readyResolve();
        attempt = 0;
        if (mode === "idle") this.startIdle(session, client);
        else session.pollLoop = this.runPolling(session, client).catch((error) => this.failSession(session, error));
        await closed;
        if (!session.stopped && !session.account.stopped && !this.stopped) {
          throw session.failure ?? new Error("IMAP 长连接已断开");
        }
      } catch (error) {
        if (!session.stopped && !session.account.stopped && !this.stopped) {
          session.state = "error";
          session.error = errorMessage(error);
          this.updateAccountState(session.account, false);
        }
      } finally {
        client.removeListener("close", onClose);
        client.removeListener("error", onError);
        session.pollWake?.("stop");
        await session.pollLoop?.catch(() => undefined);
        session.pollLoop = null;
        session.idlePromise = null;
        session.client = null;
        if (client.usable) client.close();
      }
      if (!session.stopped && !session.account.stopped && !this.stopped) await this.waitForRetry(session, attempt++);
    }
  }

  private attachSessionEvents(session: FolderSession, client: ImapFlow): void {
    client.on("exists", () => void this.enqueueSync(session).catch((error) => this.failSession(session, error)));
    client.on("expunge", () => void this.enqueueSync(session).catch((error) => this.failSession(session, error)));
    client.on("flags", (event: { uid?: number; flags?: Set<string> }) => {
      if (!event.uid || !event.flags || !session.uidValidity) return;
      const known = this.db.getKnownMessage(session.account.accountId, session.kind, session.uidValidity, event.uid);
      const read = event.flags.has("\\Seen");
      if (!known || known.read === read) return;
      this.db.updateKnownRead(known.id, read);
      this.synchronizer.publishChange({
        accountId: session.account.accountId,
        folder: session.kind,
        addedIds: [],
        updatedIds: [known.id],
        deletedIds: []
      });
    });
  }

  private enqueueSync(session: FolderSession): Promise<void> {
    session.syncRequested = true;
    if (session.syncPromise) return session.syncPromise;
    const operation = this.runSyncLoop(session).finally(() => {
      if (session.syncPromise === operation) session.syncPromise = null;
      if (session.syncRequested && session.client?.usable) {
        void this.enqueueSync(session).catch((error) => this.failSession(session, error));
      } else if (session.mode === "idle" && session.client) {
        this.startIdle(session, session.client);
      }
    });
    session.syncPromise = operation;
    return operation;
  }

  private async runSyncLoop(session: FolderSession): Promise<void> {
    do {
      session.syncRequested = false;
      const client = session.client;
      if (!client?.usable) throw new Error("IMAP 长连接不可用");
      const account = this.requireAccount(session.account.accountId);
      session.uidValidity = await this.enqueueAccountOperation(account.id, () =>
        this.synchronizer.syncFolder(client, account, session.kind, session.path, this.db.getSettings().maxMessagesPerAccount));
      session.state = "connected";
      session.error = null;
      this.updateAccountState(session.account, true);
    } while (session.syncRequested && session.client?.usable);
  }

  private startIdle(session: FolderSession, client: ImapFlow): void {
    if (session.stopped || session.syncPromise || session.client !== client || !client.usable || session.idlePromise || session.mode !== "idle") return;
    const tracked = client.idle().then(() => undefined).catch((error) => this.failSession(session, error)).finally(() => {
      if (session.idlePromise === tracked) session.idlePromise = null;
      if (!session.syncPromise && session.client === client && client.usable) setImmediate(() => this.startIdle(session, client));
    });
    session.idlePromise = tracked;
  }

  private failSession(session: FolderSession, error: unknown): void {
    session.failure = error;
    session.client?.close();
  }

  private stopSession(session: FolderSession): void {
    session.stopped = true;
    session.readyResolve();
    session.retryResolve?.();
    session.pollWake?.("stop");
    session.client?.close();
  }

  private async runPolling(session: FolderSession, client: ImapFlow): Promise<void> {
    while (!session.stopped && !session.account.stopped && !this.stopped && session.client === client && client.usable) {
      const wake = await this.waitForPoll(session, this.db.getSettings().pollIntervalSeconds * 1000);
      if (wake === "stop") return;
      if (wake === "reschedule") continue;
      await client.status(session.path, {
        messages: true,
        uidNext: true,
        uidValidity: true,
        unseen: true,
        highestModseq: true
      });
      await this.enqueueSync(session);
    }
  }

  private waitForPoll(session: FolderSession, delay: number): Promise<PollWake> {
    return new Promise((resolve) => {
      let cancel: () => void = () => undefined;
      const finish = (reason: PollWake) => {
        cancel();
        if (session.pollWake === finish) session.pollWake = null;
        resolve(reason);
      };
      cancel = this.schedulePoll(delay, () => finish("elapsed"));
      session.pollWake = finish;
    });
  }

  private updateAccountState(account: AccountState, synced: boolean): void {
    const inbox = account.sessions.get("inbox");
    const junk = account.sessions.get("junk");
    const mode = inbox?.mode ?? junk?.mode ?? null;
    let status: ConnectionStatus = "connecting";
    let error: string | null = null;

    if (inbox?.state === "error") {
      status = "error";
      error = inbox.error;
    } else if (inbox?.state === "connected") {
      if (account.missingJunk) {
        status = "warning";
        error = "未找到垃圾邮箱文件夹";
      } else if (junk?.state === "error") {
        status = "warning";
        error = junk.error;
      } else if (junk?.state === "connected") {
        status = "connected";
      }
    }
    this.setAccountState(account.accountId, status, error, synced, mode);
  }

  private setAccountState(accountId: string, status: ConnectionStatus, error: string | null, synced: boolean, mode: SyncMode | null): void {
    this.db.setAccountStatus(accountId, status, error, synced);
    this.db.setAccountSyncMode(accountId, mode);
    const account = this.db.getAccount(accountId);
    if (!account) return;
    this.events.publish({
      type: "account.changed",
      accountId,
      status: account.status,
      syncMode: account.syncMode,
      lastSyncedAt: account.lastSyncedAt,
      occurredAt: new Date().toISOString()
    });
  }

  private enqueueAccountOperation<T>(accountId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.accountQueues.get(accountId) ?? Promise.resolve();
    const current = previous.then(operation);
    const tail = current.then(() => undefined, () => undefined);
    this.accountQueues.set(accountId, tail);
    return current.finally(() => {
      if (this.accountQueues.get(accountId) === tail) this.accountQueues.delete(accountId);
    });
  }

  private requireAccount(id: string): StoredAccount {
    const account = this.db.getAccount(id);
    if (!account) throw new AccountNotFoundError();
    return account;
  }

  private waitForRetry(target: { retryResolve: (() => void) | null }, attempt: number): Promise<void> {
    const delays = [1000, 2000, 5000, 10_000, 30_000, 60_000];
    const base = delays[Math.min(attempt, delays.length - 1)]!;
    const delay = Math.round(base * (1 + Math.random() * 0.2));
    return new Promise((resolve) => {
      const timer = setTimeout(() => { target.retryResolve = null; resolve(); }, delay);
      timer.unref();
      target.retryResolve = () => { clearTimeout(timer); target.retryResolve = null; resolve(); };
    });
  }
}

interface AccountState {
  accountId: string;
  stopped: boolean;
  missingJunk?: boolean;
  sessions: Map<FolderKind, FolderSession>;
  discoveryClient: ImapFlow | null;
  retryResolve: (() => void) | null;
  ready: Promise<void>;
  readyResolve: () => void;
  loop: Promise<void>;
}

type PollWake = "elapsed" | "reschedule" | "stop";

interface FolderSession {
  account: AccountState;
  kind: FolderKind;
  path: string;
  client: ImapFlow | null;
  mode: SyncMode | null;
  state: "connecting" | "connected" | "error";
  error: string | null;
  uidValidity: string | null;
  stopped: boolean;
  syncRequested: boolean;
  syncPromise: Promise<void> | null;
  idlePromise: Promise<void> | null;
  loop: Promise<void> | null;
  retryResolve: (() => void) | null;
  pollLoop: Promise<void> | null;
  pollWake: ((reason: PollWake) => void) | null;
  failure: unknown;
  firstReady: Promise<void>;
  readyResolve: () => void;
}

function supportsIdle(client: ImapFlow): boolean {
  return client.capabilities.has("IDLE") || client.capabilities.has("IMAP4rev2") ||
    client.capabilities.has("IMAP4REV2") || client.enabled.has("IMAP4REV2");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
