import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { ImapFlow } from "imapflow";
import { AppDatabase } from "./database.js";
import { ImapService } from "./imap.js";
import { EventBroker } from "./events.js";

const dirs: string[] = [];

class ManualPollScheduler {
  private now = 0;
  private readonly tasks: Array<{ at: number; callback: () => void; cancelled: boolean }> = [];

  schedule = (delay: number, callback: () => void) => {
    const task = { at: this.now + delay, callback, cancelled: false };
    this.tasks.push(task);
    return () => { task.cancelled = true; };
  };

  advance(milliseconds: number): void {
    this.now += milliseconds;
    for (const task of this.tasks.filter((item) => !item.cancelled && item.at <= this.now)) {
      task.cancelled = true;
      task.callback();
    }
  }

  nextDelay(): number | null {
    const next = this.tasks.filter((item) => !item.cancelled).sort((left, right) => left.at - right.at)[0];
    return next ? next.at - this.now : null;
  }
}

class DeadlockDetectingClient extends EventEmitter {
  usable = true;
  mailbox = { uidValidity: 1n, exists: 1 };
  capabilities: Map<string, boolean>;
  enabled = new Set<string>();
  maxIdleTime = 0;
  fetchAllCalls = 0;
  readonly fetchRanges: string[] = [];
  searchCalls = 0;
  listCalls = 0;
  statusCalls = 0;
  readonly storePaths: string[] = [];
  options = { disableAutoIdle: false };
  fetchGate: Promise<void> | null = null;
  readonly lockFailures = new Set<string>();
  readonly storeFailures = new Set<string>();
  private fetchInProgress = false;
  private idleResolve: (() => void) | null = null;
  private selectedPath: string | null = null;

  constructor(private readonly idleSupported = true, private readonly includeJunk = false, private readonly customMailboxes: Array<{ path: string; name: string; delimiter?: string; specialUse?: string; flags?: Set<string> }> = []) {
    super();
    this.capabilities = new Map(idleSupported ? [["IDLE", true]] : []);
  }

  async connect(): Promise<void> {}
  async logout(): Promise<void> { this.close(); }
  close(): void {
    if (!this.usable) return;
    this.usable = false;
    this.idleResolve?.();
    this.emit("close");
  }
  async idle(): Promise<void> {
    return new Promise((resolve) => { this.idleResolve = resolve; });
  }
  async list() {
    this.listCalls++;
    return [
      { path: "INBOX", name: "INBOX", specialUse: "\\Inbox" },
      ...(this.includeJunk ? [{ path: "Junk", name: "Junk", specialUse: "\\Junk" }] : []),
      ...this.customMailboxes
    ];
  }
  async getMailboxLock(path: string) {
    if (this.lockFailures.has(path)) throw new Error(`cannot select ${path}`);
    this.selectedPath = path;
    return { release: () => { this.selectedPath = null; } };
  }
  async messageFlagsAdd(): Promise<boolean> {
    if (this.selectedPath && this.storeFailures.has(this.selectedPath)) throw new Error(`cannot store ${this.selectedPath}`);
    if (this.selectedPath) this.storePaths.push(this.selectedPath);
    return true;
  }
  async search() {
    this.searchCalls++;
    return [1];
  }
  async *fetch() {
    this.fetchInProgress = true;
    try {
      yield this.message();
    } finally {
      this.fetchInProgress = false;
    }
  }
  async fetchAll(range: string) {
    this.fetchAllCalls++;
    this.fetchRanges.push(range);
    await this.fetchGate;
    return [this.message()];
  }
  async status() {
    this.statusCalls++;
    return { messages: 1, uidNext: 2, uidValidity: 1n, unseen: 1 };
  }
  async fetchOne() {
    if (this.fetchInProgress) throw new Error("nested IMAP command during fetch");
    return { bodyParts: new Map([["1", Buffer.from("Hello from IMAP")]]) };
  }

  private message() {
    return {
      uid: 1,
      flags: new Set<string>(),
      envelope: { subject: "First message", date: new Date("2026-01-01T00:00:00Z"), from: [], to: [] },
      internalDate: new Date("2026-01-01T00:00:00Z"),
      bodyStructure: { part: "1", type: "text/plain", encoding: "7bit", parameters: new Map([["charset", "utf-8"]]) }
    };
  }
}

afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("ImapService", () => {
  it("finishes the metadata fetch before requesting message bodies", async () => {
    const dir = mkdtempSync(join(tmpdir(), "imap2api-imap-"));
    dirs.push(dir);
    const db = new AppDatabase(join(dir, "test.db"), "t".repeat(32));
    const account = db.createAccount({ email: "mail@qq.com", password: "authorization-code" });
    const service = new ImapService(db, new EventBroker(), () => new DeadlockDetectingClient() as unknown as ImapFlow);

    await service.sync(account.id);

    expect(db.listMessages({ view: "all", limit: 50 }).items).toMatchObject([
      { subject: "First message", preview: "Hello from IMAP" }
    ]);
    await service.stop();
    db.close();
  });

  it("fetches only the retained sequence window without SEARCH ALL", async () => {
    const dir = mkdtempSync(join(tmpdir(), "imap2api-window-"));
    dirs.push(dir);
    const db = new AppDatabase(join(dir, "test.db"), "t".repeat(32));
    const account = db.createAccount({ email: "mail@qq.com", password: "authorization-code" });
    const clients: DeadlockDetectingClient[] = [];
    const service = new ImapService(db, new EventBroker(), () => {
      const client = new DeadlockDetectingClient();
      client.mailbox.exists = 100_000;
      clients.push(client);
      return client as unknown as ImapFlow;
    });

    await service.sync(account.id);

    expect(clients[1]?.fetchRanges).toEqual(["99901:*", "99901:*"]);
    expect(clients.reduce((total, client) => total + client.searchCalls, 0)).toBe(0);
    await service.stop();
    db.close();
  });

  it("keeps one IDLE connection per mapped folder", async () => {
    const dir = mkdtempSync(join(tmpdir(), "imap2api-idle-")); dirs.push(dir);
    const db = new AppDatabase(join(dir, "test.db"), "t".repeat(32));
    const account = db.createAccount({ email: "mail@qq.com", password: "authorization-code" });
    const clients: DeadlockDetectingClient[] = [];
    const service = new ImapService(db, new EventBroker(), () => {
      const client = new DeadlockDetectingClient(true, true); clients.push(client); return client as unknown as ImapFlow;
    });

    await service.sync(account.id);

    expect(clients).toHaveLength(3);
    expect(clients.slice(1).every((client) => client.usable && client.maxIdleTime === 29 * 60 * 1000)).toBe(true);
    expect(clients.slice(1).every((client) => client.options.disableAutoIdle === false)).toBe(true);
    expect(db.listAccounts()[0]).toMatchObject({ status: "connected", syncMode: "idle" });
    await service.stop();
    expect(clients.slice(1).every((client) => !client.usable)).toBe(true);
    db.close();
  });

  it("polls at the exact configured interval and reschedules without reconnecting", async () => {
    const dir = mkdtempSync(join(tmpdir(), "imap2api-poll-")); dirs.push(dir);
    const db = new AppDatabase(join(dir, "test.db"), "t".repeat(32));
    const account = db.createAccount({ email: "mail@qq.com", password: "authorization-code" });
    db.updateSettings({ pollIntervalSeconds: 3600 });
    const clients: DeadlockDetectingClient[] = [];
    const scheduler = new ManualPollScheduler();
    const service = new ImapService(db, new EventBroker(), () => {
      const client = new DeadlockDetectingClient(false); clients.push(client); return client as unknown as ImapFlow;
    }, scheduler.schedule);
    await service.sync(account.id);
    const pollingClient = clients[1]!;
    expect(pollingClient.options.disableAutoIdle).toBe(true);
    expect(db.listAccounts()[0]?.syncMode).toBe("polling");

    scheduler.advance(3_599_999);
    expect(pollingClient.statusCalls).toBe(0);
    scheduler.advance(1);
    await vi.waitFor(() => expect(pollingClient.statusCalls).toBe(1));
    await vi.waitFor(() => expect(scheduler.nextDelay()).toBe(3_600_000));

    db.updateSettings({ pollIntervalSeconds: 5 });
    service.applySettings(3600);
    await vi.waitFor(() => expect(scheduler.nextDelay()).toBe(5000));
    scheduler.advance(4999);
    expect(pollingClient.statusCalls).toBe(1);
    scheduler.advance(1);
    await vi.waitFor(() => expect(pollingClient.statusCalls).toBe(2));
    expect(clients).toHaveLength(2);
    await service.stop();
    expect(scheduler.nextDelay()).toBeNull();
    db.close();
  });

  it("discovers selectable mailboxes and preserves configured missing folders", async () => {
    const dir = mkdtempSync(join(tmpdir(), "imap2api-mailboxes-")); dirs.push(dir);
    const db = new AppDatabase(join(dir, "test.db"), "t".repeat(32));
    const account = db.createAccount({ email: "mail@qq.com", password: "authorization-code" });
    db.updateSyncFolders(account.id, [{ path: "Missing/Relay", mode: "idle" }]);
    const custom = [
      { path: "Projects/Relay", name: "Relay", delimiter: "/" },
      { path: "Drafts", name: "Drafts", specialUse: "\\Drafts" },
      { path: "Container", name: "Container", flags: new Set(["\\Noselect"]) }
    ];
    const service = new ImapService(db, new EventBroker(), () => new DeadlockDetectingClient(true, true, custom) as unknown as ImapFlow);

    await expect(service.listMailboxes(account.id)).resolves.toMatchObject({ items: [
      { path: "INBOX", kind: "inbox", selectable: false, available: true },
      { path: "Junk", kind: "junk", selectable: false, available: true },
      { path: "Projects/Relay", kind: "custom", selectable: true, depth: 1, selectedMode: null },
      { path: "Missing/Relay", kind: "custom", selectable: true, available: false, selectedMode: "idle" }
    ] });
    await service.stop();
    db.close();
  });

  it("shares one connection for polling custom folders and keeps IDLE folders independent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "imap2api-custom-sessions-")); dirs.push(dir);
    const db = new AppDatabase(join(dir, "test.db"), "t".repeat(32));
    const account = db.createAccount({ email: "mail@qq.com", password: "authorization-code" });
    db.updateSyncFolders(account.id, [
      { path: "Polling/A", mode: "polling" }, { path: "Polling/B", mode: "polling" }, { path: "Realtime", mode: "idle" }
    ]);
    const custom = [
      { path: "Polling/A", name: "A", delimiter: "/" }, { path: "Polling/B", name: "B", delimiter: "/" },
      { path: "Realtime", name: "Realtime", delimiter: "/" }
    ];
    const clients: DeadlockDetectingClient[] = [];
    const service = new ImapService(db, new EventBroker(), () => {
      const client = new DeadlockDetectingClient(true, false, custom); clients.push(client); return client as unknown as ImapFlow;
    });

    await service.sync(account.id);
    expect(clients).toHaveLength(4);
    expect(clients.filter((client) => client.options.disableAutoIdle)).toHaveLength(1);
    expect(clients.filter((client) => client.usable && !client.options.disableAutoIdle)).toHaveLength(2);
    await service.stop();
    db.close();
  });

  it("serializes duplicate manual syncs and handles mailbox notifications on the persistent session", async () => {
    const dir = mkdtempSync(join(tmpdir(), "imap2api-events-")); dirs.push(dir);
    const db = new AppDatabase(join(dir, "test.db"), "t".repeat(32));
    const account = db.createAccount({ email: "mail@qq.com", password: "authorization-code" });
    const clients: DeadlockDetectingClient[] = [];
    const service = new ImapService(db, new EventBroker(), () => {
      const client = new DeadlockDetectingClient(true, true); clients.push(client); return client as unknown as ImapFlow;
    });
    await service.sync(account.id);
    const inbox = clients[1]!;

    let releaseFetch!: () => void;
    inbox.fetchGate = new Promise<void>((resolve) => { releaseFetch = resolve; });
    const beforeExists = inbox.fetchAllCalls;
    const first = service.sync(account.id);
    await vi.waitFor(() => expect(inbox.fetchAllCalls).toBe(beforeExists + 1));
    expect(service.triggerSync(account.id)).toEqual({ status: "running" });
    for (let index = 0; index < 5; index++) {
      inbox.emit("exists", { path: "INBOX", count: index + 2, prevCount: index + 1 });
      inbox.emit("expunge", { path: "INBOX", seq: 1 });
    }
    const duplicate = service.sync(account.id);
    releaseFetch();
    await Promise.all([first, duplicate]);
    expect(inbox.fetchAllCalls).toBe(beforeExists + 2);
    inbox.fetchGate = null;

    const beforeFlags = inbox.fetchAllCalls;
    inbox.emit("flags", { uid: 1, flags: new Set(["\\Seen"]) });
    await vi.waitFor(() => expect(db.listMessages({ accountId: account.id, view: "all", limit: 50 }).items.find((message) => message.folder === "inbox")?.read).toBe(true));
    expect(inbox.fetchAllCalls).toBe(beforeFlags);
    const beforeExpunge = inbox.fetchAllCalls;
    inbox.emit("expunge", { path: "INBOX", seq: 1 });
    await vi.waitFor(() => expect(inbox.fetchAllCalls).toBeGreaterThan(beforeExpunge));

    await service.stop();
    db.close();
  });

  it("does not let the healthy junk session mask an inbox disconnect", async () => {
    const dir = mkdtempSync(join(tmpdir(), "imap2api-disconnect-")); dirs.push(dir);
    const db = new AppDatabase(join(dir, "test.db"), "t".repeat(32));
    const account = db.createAccount({ email: "mail@qq.com", password: "authorization-code" });
    const clients: DeadlockDetectingClient[] = [];
    const service = new ImapService(db, new EventBroker(), () => {
      const client = new DeadlockDetectingClient(true, true); clients.push(client); return client as unknown as ImapFlow;
    });
    await service.sync(account.id);

    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    clients[1]!.close();
    await vi.advanceTimersByTimeAsync(0);
    expect(db.listAccounts()[0]?.status).toBe("error");
    expect(clients[2]?.usable).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(clients).toHaveLength(4);
    expect(db.listAccounts()[0]).toMatchObject({ status: "connected", syncMode: "idle" });

    await service.stop();
    db.close();
  });

  it.each(["lock", "store"] as const)("keeps successful folders when mark-all-read hits a junk %s failure", async (failure) => {
    const dir = mkdtempSync(join(tmpdir(), "imap2api-read-all-")); dirs.push(dir);
    const db = new AppDatabase(join(dir, "test.db"), "t".repeat(32));
    const account = db.createAccount({ email: "mail@qq.com", password: "authorization-code" });
    let failJunk = false;
    const service = new ImapService(db, new EventBroker(), () => {
      const client = new DeadlockDetectingClient(true, true);
      if (failJunk) client[failure === "lock" ? "lockFailures" : "storeFailures"].add("Junk");
      return client as unknown as ImapFlow;
    });
    await service.sync(account.id);
    failJunk = true;

    await expect(service.markAllRead(account.id)).resolves.toEqual({ count: 1, failedFolders: ["junk"] });
    const messages = db.listMessages({ accountId: account.id, view: "all", limit: 50 }).items;
    expect(messages.find((message) => message.folder === "inbox")?.read).toBe(true);
    expect(messages.find((message) => message.folder === "junk")?.read).toBe(false);

    await service.stop();
    db.close();
  });

  it("marks unread messages in each real custom mailbox path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "imap2api-custom-read-all-")); dirs.push(dir);
    const db = new AppDatabase(join(dir, "test.db"), "t".repeat(32));
    const account = db.createAccount({ email: "mail@qq.com", password: "authorization-code" });
    for (const [mailboxPath, uid] of [["Relay/A", 1], ["Relay/B", 1]] as const) {
      db.upsertMessage({
        accountId: account.id, folder: "inbox", mailboxPath, uid, uidValidity: "1", read: false,
        displayTime: "2026-01-01T00:00:00.000Z",
        content: { subject: mailboxPath, from: [], to: [], cc: [], preview: "", text: "", html: null, attachments: [] }
      });
    }
    const client = new DeadlockDetectingClient();
    const service = new ImapService(db, new EventBroker(), () => client as unknown as ImapFlow);

    await expect(service.markAllRead(account.id)).resolves.toEqual({ count: 2, failedFolders: [] });
    expect(client.storePaths.sort()).toEqual(["Relay/A", "Relay/B"]);
    expect(db.listMessages({ accountId: account.id, view: "unread", limit: 50 }).items).toEqual([]);
    db.close();
  });

  it("does not leave manual synchronization running while discovery retries", async () => {
    const dir = mkdtempSync(join(tmpdir(), "imap2api-discovery-")); dirs.push(dir);
    const db = new AppDatabase(join(dir, "test.db"), "t".repeat(32));
    const account = db.createAccount({ email: "mail@qq.com", password: "authorization-code" });
    const service = new ImapService(db, new EventBroker(), () => {
      const client = new DeadlockDetectingClient();
      client.connect = async () => { throw new Error("offline"); };
      return client as unknown as ImapFlow;
    });

    expect(service.triggerSync(account.id)).toEqual({ status: "started" });
    await Promise.resolve();
    expect(service.triggerSync(account.id)).toEqual({ status: "started" });

    await service.stop();
    db.close();
  });

  it("does not create sessions after discovery is stopped", async () => {
    const dir = mkdtempSync(join(tmpdir(), "imap2api-discovery-stop-")); dirs.push(dir);
    const db = new AppDatabase(join(dir, "test.db"), "t".repeat(32));
    const account = db.createAccount({ email: "mail@qq.com", password: "authorization-code" });
    let releaseConnect!: () => void;
    const connectGate = new Promise<void>((resolve) => { releaseConnect = resolve; });
    const client = new DeadlockDetectingClient();
    client.connect = async () => connectGate;
    const service = new ImapService(db, new EventBroker(), () => client as unknown as ImapFlow);

    service.startAccount(account.id);
    await service.removeAccount(account.id);
    releaseConnect();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(client.listCalls).toBe(0);

    await service.stop();
    db.close();
  });
});
