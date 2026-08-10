import { ImapFlow } from "imapflow";
import type { ConnectionStatus, FolderKind, SyncMode, SyncTriggerResult } from "@email2api/shared";
import { AppDatabase, type StoredAccount } from "./database.js";
import { EventBroker } from "./events.js";
import { AccountNotFoundError } from "./errors.js";
import { MailboxSynchronizer } from "./mail-sync.js";

const JUNK_NAMES = new Set(["junk", "spam", "bulk mail", "垃圾邮件", "垃圾箱", "广告邮件"]);

export interface ListedMailbox {
  path: string;
  name: string;
  delimiter?: string;
  specialUse?: string;
  flags?: Set<string>;
}

export type ImapClientFactory = (account: StoredAccount) => ImapFlow;
export type PollScheduler = (delay: number, callback: () => void) => () => void;

export function resolveSystemMailboxes(mailboxes: ListedMailbox[]): { inbox?: ListedMailbox; junk?: ListedMailbox } {
  return {
    inbox: mailboxes.find((box) => box.path.toUpperCase() === "INBOX" || box.specialUse === "\\Inbox"),
    junk: mailboxes.find((box) => box.specialUse === "\\Junk") ??
      mailboxes.find((box) => JUNK_NAMES.has(box.name.toLowerCase()) || JUNK_NAMES.has(box.path.toLowerCase()))
  };
}

export function isSelectableCustomMailbox(box: ListedMailbox, system: { inbox?: ListedMailbox; junk?: ListedMailbox }): boolean {
  if (box.path === system.inbox?.path || box.path === system.junk?.path) return false;
  if (box.flags?.has("\\Noselect")) return false;
  return !box.specialUse;
}

export function supportsIdle(client: ImapFlow): boolean {
  return client.capabilities.has("IDLE") || client.capabilities.has("IMAP4rev2") ||
    client.capabilities.has("IMAP4REV2") || client.enabled.has("IMAP4REV2");
}

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
      accountId, stopped: false, missingJunk: false, missingCustomPaths: [], downgradedPaths: [],
      sessions: new Map(), pollingGroup: null, discoveryClient: null, retryResolve: null,
      ready, readyResolve, loop: Promise.resolve()
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
    if (account.pollingGroup) this.stopPollingGroup(account.pollingGroup);
    await Promise.allSettled([
      ...[...account.sessions.values()].map((session) => session.loop ?? Promise.resolve()),
      account.pollingGroup?.loop ?? Promise.resolve()
    ]);
  }

  applySettings(previousPollIntervalSeconds: number): void {
    if (this.db.getSettings().pollIntervalSeconds === previousPollIntervalSeconds) return;
    for (const account of this.accounts.values()) {
      for (const session of account.sessions.values()) {
        if (session.mode === "polling") session.pollWake?.("reschedule");
      }
      account.pollingGroup?.pollWake?.("reschedule");
    }
  }

  triggerSync(accountId: string): SyncTriggerResult {
    this.requireAccount(accountId);
    this.startAccount(accountId);
    const account = this.accounts.get(accountId);
    if (!account) throw new Error("邮箱同步服务已停止");
    const sessions = [...account.sessions.values()].filter((session) => session.client?.usable);
    const group = account.pollingGroup?.client?.usable ? account.pollingGroup : null;
    const running = sessions.some((session) => Boolean(session.syncPromise)) || Boolean(group?.syncPromise);
    for (const session of sessions) void this.enqueueSync(session).catch((error) => this.failSession(session, error));
    if (group) void this.enqueuePollingSync(group).catch((error) => this.failPollingGroup(group, error));
    return { status: running ? "running" : "started" };
  }

  async sync(accountId: string): Promise<void> {
    this.requireAccount(accountId);
    this.startAccount(accountId);
    const account = this.accounts.get(accountId);
    if (!account) throw new Error("邮箱同步服务已停止");
    await account.ready;
    await Promise.all([
      ...[...account.sessions.values()].map((session) => session.firstReady),
      account.pollingGroup?.firstReady ?? Promise.resolve()
    ]);
    await Promise.all([
      ...[...account.sessions.values()].map((session) => this.enqueueSync(session)),
      account.pollingGroup ? this.enqueuePollingSync(account.pollingGroup) : Promise.resolve()
    ]);
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
        const mailboxes = await client.list() as ListedMailbox[];
        const system = resolveSystemMailboxes(mailboxes);
        if (!system.inbox) throw new Error("IMAP 服务器未返回收件箱");
        const idleAvailable = supportsIdle(client);
        if (client.usable) await client.logout().catch(() => undefined);
        if (accountState.stopped || this.stopped) return;
        accountState.discoveryClient = null;
        accountState.missingJunk = !system.junk;
        if (!system.junk) {
          const deletedIds = this.db.resetMailboxesByKind(account.id, "junk");
          this.synchronizer.publishChange({ accountId: account.id, folder: "junk", addedIds: [], updatedIds: [], deletedIds });
        }

        const availableCustom = new Map(mailboxes
          .filter((box) => isSelectableCustomMailbox(box, system)).map((box) => [box.path, box]));
        accountState.missingCustomPaths = account.syncFolders
          .filter((folder) => !availableCustom.has(folder.path)).map((folder) => folder.path);
        accountState.downgradedPaths = account.syncFolders
          .filter((folder) => folder.mode === "idle" && availableCustom.has(folder.path) && !idleAvailable)
          .map((folder) => folder.path);

        const targets: FolderTarget[] = [
          { path: system.inbox.path, mailboxKind: "inbox", publicFolder: "inbox", role: "inbox" },
          ...(system.junk ? [{ path: system.junk.path, mailboxKind: "junk" as const, publicFolder: "junk" as const, role: "junk" as const }] : [])
        ];
        const pollingTargets: FolderTarget[] = [];
        for (const folder of account.syncFolders) {
          if (!availableCustom.has(folder.path)) continue;
          const target: FolderTarget = { path: folder.path, mailboxKind: "custom", publicFolder: "inbox", role: "custom" };
          if (folder.mode === "idle" && idleAvailable) targets.push(target);
          else pollingTargets.push(target);
        }
        for (const target of targets) {
          const session = this.createSession(accountState, target);
          accountState.sessions.set(this.db.mailboxKey(target.path), session);
          session.loop = this.runSession(session);
        }
        if (pollingTargets.length) {
          const group = this.createPollingGroup(accountState, pollingTargets);
          accountState.pollingGroup = group;
          group.loop = this.runPollingGroup(group);
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

  private createSession(account: AccountState, target: FolderTarget): FolderSession {
    let readyResolve!: () => void;
    const firstReady = new Promise<void>((resolve) => { readyResolve = resolve; });
    return {
      account, target, client: null, mode: null, state: "connecting", error: null, uidValidity: null,
      stopped: false, syncRequested: false, syncPromise: null, idlePromise: null, loop: null,
      retryResolve: null, pollLoop: null, pollWake: null, failure: null, firstReady, readyResolve
    };
  }

  private createPollingGroup(account: AccountState, targets: FolderTarget[]): PollingGroup {
    let readyResolve!: () => void;
    const firstReady = new Promise<void>((resolve) => { readyResolve = resolve; });
    return {
      account, targets, client: null, state: "connecting", error: null, stopped: false,
      syncRequested: false, syncPromise: null, loop: null, retryResolve: null, pollWake: null,
      pollLoop: null, failure: null, firstReady, readyResolve
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
          if (session.target.role === "custom" && !session.account.downgradedPaths.includes(session.target.path)) {
            session.account.downgradedPaths.push(session.target.path);
          }
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
        if (client.usable) client.close();
        await session.pollLoop?.catch(() => undefined);
        session.pollLoop = null;
        session.idlePromise = null;
        session.client = null;
      }
      if (!session.stopped && !session.account.stopped && !this.stopped) await this.waitForRetry(session, attempt++);
    }
  }

  private async runPollingGroup(group: PollingGroup): Promise<void> {
    let attempt = 0;
    while (!group.stopped && !group.account.stopped && !this.stopped) {
      group.state = "connecting";
      group.error = null;
      this.updateAccountState(group.account, false);
      const account = this.requireAccount(group.account.accountId);
      const client = this.clientFactory(account);
      group.client = client;
      group.failure = null;
      let closeResolve!: () => void;
      const closed = new Promise<void>((resolve) => { closeResolve = resolve; });
      const onClose = () => closeResolve();
      const onError = (error: unknown) => { group.failure = error; closeResolve(); };
      client.once("close", onClose);
      client.on("error", onError);
      try {
        await client.connect();
        (client as ImapFlow & { options: { disableAutoIdle?: boolean } }).options.disableAutoIdle = true;
        await this.enqueuePollingSync(group);
        group.readyResolve();
        attempt = 0;
        group.pollLoop = this.runPollingGroupLoop(group, client).catch((error) => this.failPollingGroup(group, error));
        await closed;
        if (!group.stopped && !group.account.stopped && !this.stopped) {
          throw group.failure ?? new Error("自定义文件夹轮询连接已断开");
        }
      } catch (error) {
        if (!group.stopped && !group.account.stopped && !this.stopped) {
          group.state = "error";
          group.error = errorMessage(error);
          this.updateAccountState(group.account, false);
        }
      } finally {
        client.removeListener("close", onClose);
        client.removeListener("error", onError);
        group.pollWake?.("stop");
        if (client.usable) client.close();
        await group.pollLoop?.catch(() => undefined);
        group.pollLoop = null;
        group.client = null;
      }
      if (!group.stopped && !group.account.stopped && !this.stopped) await this.waitForRetry(group, attempt++);
    }
  }

  private attachSessionEvents(session: FolderSession, client: ImapFlow): void {
    client.on("exists", () => void this.enqueueSync(session).catch((error) => this.failSession(session, error)));
    client.on("expunge", () => void this.enqueueSync(session).catch((error) => this.failSession(session, error)));
    client.on("flags", (event: { uid?: number; flags?: Set<string> }) => {
      if (!event.uid || !event.flags || !session.uidValidity) return;
      const known = this.db.getKnownMessage(session.account.accountId, session.target.path, session.uidValidity, event.uid);
      const read = event.flags.has("\\Seen");
      if (!known || known.read === read) return;
      this.db.updateKnownRead(known.id, read);
      this.synchronizer.publishChange({
        accountId: session.account.accountId, folder: session.target.publicFolder,
        addedIds: [], updatedIds: [known.id], deletedIds: []
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
        this.synchronizer.syncFolder(client, account, session.target.publicFolder, session.target.path,
          this.db.getSettings().maxMessagesPerAccount, session.target.mailboxKind));
      session.state = "connected";
      session.error = null;
      this.updateAccountState(session.account, true);
    } while (session.syncRequested && session.client?.usable);
  }

  private enqueuePollingSync(group: PollingGroup): Promise<void> {
    group.syncRequested = true;
    if (group.syncPromise) return group.syncPromise;
    const operation = this.runPollingSyncLoop(group).finally(() => {
      if (group.syncPromise === operation) group.syncPromise = null;
      if (group.syncRequested && group.client?.usable) {
        void this.enqueuePollingSync(group).catch((error) => this.failPollingGroup(group, error));
      }
    });
    group.syncPromise = operation;
    return operation;
  }

  private async runPollingSyncLoop(group: PollingGroup): Promise<void> {
    do {
      group.syncRequested = false;
      const client = group.client;
      if (!client?.usable) throw new Error("自定义文件夹轮询连接不可用");
      const account = this.requireAccount(group.account.accountId);
      for (const target of group.targets) {
        await this.enqueueAccountOperation(account.id, () => this.synchronizer.syncFolder(
          client, account, target.publicFolder, target.path, this.db.getSettings().maxMessagesPerAccount, target.mailboxKind));
      }
      group.state = "connected";
      group.error = null;
      this.updateAccountState(group.account, true);
    } while (group.syncRequested && group.client?.usable);
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

  private failPollingGroup(group: PollingGroup, error: unknown): void {
    group.failure = error;
    group.client?.close();
  }

  private stopSession(session: FolderSession): void {
    session.stopped = true;
    session.readyResolve();
    session.retryResolve?.();
    session.pollWake?.("stop");
    session.client?.close();
  }

  private stopPollingGroup(group: PollingGroup): void {
    group.stopped = true;
    group.readyResolve();
    group.retryResolve?.();
    group.pollWake?.("stop");
    group.client?.close();
  }

  private async runPolling(session: FolderSession, client: ImapFlow): Promise<void> {
    while (!session.stopped && !session.account.stopped && !this.stopped && session.client === client && client.usable) {
      const wake = await this.waitForPoll(session, this.db.getSettings().pollIntervalSeconds * 1000);
      if (wake === "stop") return;
      if (wake === "reschedule") continue;
      await client.status(session.target.path, {
        messages: true, uidNext: true, uidValidity: true, unseen: true, highestModseq: true
      });
      await this.enqueueSync(session);
    }
  }

  private async runPollingGroupLoop(group: PollingGroup, client: ImapFlow): Promise<void> {
    while (!group.stopped && !group.account.stopped && !this.stopped && group.client === client && client.usable) {
      const wake = await this.waitForPoll(group, this.db.getSettings().pollIntervalSeconds * 1000);
      if (wake === "stop") return;
      if (wake === "reschedule") continue;
      for (const target of group.targets) {
        await client.status(target.path, {
          messages: true, uidNext: true, uidValidity: true, unseen: true, highestModseq: true
        });
      }
      await this.enqueuePollingSync(group);
    }
  }

  private waitForPoll(target: { pollWake: ((reason: PollWake) => void) | null }, delay: number): Promise<PollWake> {
    return new Promise((resolve) => {
      let cancel: () => void = () => undefined;
      const finish = (reason: PollWake) => {
        cancel();
        if (target.pollWake === finish) target.pollWake = null;
        resolve(reason);
      };
      cancel = this.schedulePoll(delay, () => finish("elapsed"));
      target.pollWake = finish;
    });
  }

  private updateAccountState(account: AccountState, synced: boolean): void {
    const sessions = [...account.sessions.values()];
    const inbox = sessions.find((session) => session.target.role === "inbox");
    const junk = sessions.find((session) => session.target.role === "junk");
    const optional = sessions.filter((session) => session.target.role !== "inbox");
    const mode = inbox?.mode ?? junk?.mode ?? null;
    let status: ConnectionStatus = "connecting";
    let error: string | null = null;

    if (inbox?.state === "error") {
      status = "error";
      error = inbox.error;
    } else if (inbox?.state === "connected") {
      const pending = optional.some((session) => session.state === "connecting") || account.pollingGroup?.state === "connecting";
      const failed = optional.find((session) => session.state === "error");
      if (pending) {
        status = "connecting";
      } else if (account.missingJunk) {
        status = "warning";
        error = "未找到垃圾邮箱文件夹";
      } else if (account.missingCustomPaths.length) {
        status = "warning";
        error = `未找到 ${account.missingCustomPaths.length} 个自定义同步文件夹`;
      } else if (account.downgradedPaths.length) {
        status = "warning";
        error = `${account.downgradedPaths.length} 个自定义文件夹已降级为轮询`;
      } else if (failed) {
        status = "warning";
        error = failed.error;
      } else if (account.pollingGroup?.state === "error") {
        status = "warning";
        error = account.pollingGroup.error;
      } else {
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
      type: "account.changed", accountId, status: account.status, syncMode: account.syncMode,
      lastSyncedAt: account.lastSyncedAt, occurredAt: new Date().toISOString()
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

interface FolderTarget {
  path: string;
  mailboxKind: "inbox" | "junk" | "custom";
  publicFolder: FolderKind;
  role: "inbox" | "junk" | "custom";
}

interface AccountState {
  accountId: string;
  stopped: boolean;
  missingJunk: boolean;
  missingCustomPaths: string[];
  downgradedPaths: string[];
  sessions: Map<string, FolderSession>;
  pollingGroup: PollingGroup | null;
  discoveryClient: ImapFlow | null;
  retryResolve: (() => void) | null;
  ready: Promise<void>;
  readyResolve: () => void;
  loop: Promise<void>;
}

type PollWake = "elapsed" | "reschedule" | "stop";

interface FolderSession {
  account: AccountState;
  target: FolderTarget;
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

interface PollingGroup {
  account: AccountState;
  targets: FolderTarget[];
  client: ImapFlow | null;
  state: "connecting" | "connected" | "error";
  error: string | null;
  stopped: boolean;
  syncRequested: boolean;
  syncPromise: Promise<void> | null;
  loop: Promise<void> | null;
  retryResolve: (() => void) | null;
  pollWake: ((reason: PollWake) => void) | null;
  pollLoop: Promise<void> | null;
  failure: unknown;
  firstReady: Promise<void>;
  readyResolve: () => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
