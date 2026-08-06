import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import sanitizeHtml from "sanitize-html";
import type { Address } from "@imap2api/shared";
import { AppDatabase, type StoredAccount, type StoredMessageContent } from "./database.js";

type FolderKind = "inbox" | "junk";

interface BodyPartPlan {
  textParts: Array<{ part: string; type: "text/plain" | "text/html"; charset: string; encoding: string }>;
  attachments: string[];
}

const JUNK_NAMES = new Set(["junk", "spam", "bulk mail", "垃圾邮件", "垃圾箱", "广告邮件"]);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeAddresses(values: unknown): Address[] {
  if (!Array.isArray(values)) return [];
  return values.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const value = item as { name?: string; address?: string; mailbox?: string; host?: string };
    const address = value.address ?? (value.mailbox && value.host ? `${value.mailbox}@${value.host}` : "");
    return address ? [{ name: value.name || undefined, address }] : [];
  });
}

function getParam(value: unknown, key: string): string | undefined {
  if (value instanceof Map) return value.get(key) as string | undefined;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const result = record[key] ?? record[key.toLowerCase()] ?? record[key.toUpperCase()];
    return typeof result === "string" ? result : undefined;
  }
  return undefined;
}

function planBodyParts(root: unknown): BodyPartPlan {
  const textParts: BodyPartPlan["textParts"] = [];
  const attachments: string[] = [];
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const part = node as {
      part?: string;
      type?: string;
      subtype?: string;
      encoding?: string;
      parameters?: unknown;
      disposition?: string;
      dispositionParameters?: unknown;
      childNodes?: unknown[];
    };
    const mime = (part.type?.includes("/") ? part.type : `${part.type ?? ""}/${part.subtype ?? ""}`).toLowerCase();
    const disposition = part.disposition?.toLowerCase() ?? "";
    const filename = getParam(part.dispositionParameters, "filename") ?? getParam(part.parameters, "name");
    if (filename || disposition === "attachment") {
      if (filename) attachments.push(filename);
    } else if (part.part && (mime === "text/plain" || mime === "text/html")) {
      textParts.push({
        part: part.part,
        type: mime,
        charset: getParam(part.parameters, "charset") ?? "utf-8",
        encoding: part.encoding ?? "7bit"
      });
    }
    part.childNodes?.forEach(visit);
  };
  visit(root);
  return { textParts: textParts.slice(0, 8), attachments: [...new Set(attachments)] };
}

function cleanHtml(value: string): string {
  return sanitizeHtml(value, {
    allowedTags: ["p", "br", "div", "span", "strong", "b", "em", "i", "u", "s", "blockquote", "pre", "code", "ul", "ol", "li", "table", "thead", "tbody", "tr", "th", "td", "hr", "h1", "h2", "h3", "h4", "a"],
    allowedAttributes: { a: ["href", "title"] },
    allowedSchemes: ["http", "https", "mailto"],
    transformTags: {
      a: (_tag, attrs) => ({ tagName: "a", attribs: { ...attrs, target: "_blank", rel: "noreferrer noopener" } })
    },
    disallowedTagsMode: "discard"
  });
}

function previewOf(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 180);
}

export class ImapService {
  private readonly tasks = new Map<string, Promise<void>>();
  private timer: NodeJS.Timeout | null = null;
  private bootTimer: NodeJS.Timeout | null = null;

  constructor(private readonly db: AppDatabase, private readonly intervalMs: number) {}

  start(): void {
    this.timer = setInterval(() => void this.syncAll(), this.intervalMs);
    this.timer.unref();
    this.bootTimer = setTimeout(() => void this.syncAll(), 1000);
    this.bootTimer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.bootTimer) clearTimeout(this.bootTimer);
  }

  isSyncing(accountId: string): boolean {
    return this.tasks.has(accountId);
  }

  async test(accountId: string): Promise<void> {
    const account = this.requireAccount(accountId);
    this.db.setAccountStatus(accountId, "connecting", null);
    const client = this.createClient(account);
    try {
      await client.connect();
      this.db.setAccountStatus(accountId, "connected", null);
    } catch (error) {
      this.db.setAccountStatus(accountId, "error", errorMessage(error));
      throw error;
    } finally {
      if (client.usable) await client.logout().catch(() => undefined);
    }
  }

  sync(accountId: string): Promise<void> {
    const active = this.tasks.get(accountId);
    if (active) return active;
    const task = this.performSync(accountId).finally(() => this.tasks.delete(accountId));
    this.tasks.set(accountId, task);
    return task;
  }

  async markRead(messageId: string, read: boolean): Promise<void> {
    const transport = this.db.getMessageTransport(messageId);
    if (!transport) throw new Error("邮件不存在");
    const account = this.requireAccount(transport.accountId);
    const client = this.createClient(account);
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
    } finally {
      if (client.usable) await client.logout().catch(() => undefined);
    }
  }

  async markAllRead(accountId: string): Promise<{ count: number; failedFolders: FolderKind[] }> {
    const account = this.requireAccount(accountId);
    const rows = this.db.getUnreadTransports(accountId);
    if (!rows.length) return { count: 0, failedFolders: [] };
    const client = this.createClient(account);
    const failedFolders: FolderKind[] = [];
    let count = 0;
    try {
      await client.connect();
      for (const kind of ["inbox", "junk"] as const) {
        const group = rows.filter((row) => row.folder === kind);
        if (!group.length) continue;
        const lock = await client.getMailboxLock(group[0]!.mailboxPath);
        try {
          await client.messageFlagsAdd(group.map((row) => row.uid), ["\\Seen"], { uid: true });
          for (const row of group) this.db.updateKnownRead(row.id, true);
          count += group.length;
        } catch {
          failedFolders.push(kind);
        } finally {
          lock.release();
        }
      }
      return { count, failedFolders };
    } finally {
      if (client.usable) await client.logout().catch(() => undefined);
    }
  }

  private async syncAll(): Promise<void> {
    await Promise.allSettled(this.db.listAccounts().map((account) => this.sync(account.id)));
  }

  private async performSync(accountId: string): Promise<void> {
    const account = this.requireAccount(accountId);
    this.db.setAccountStatus(accountId, "connecting", null);
    const client = this.createClient(account);
    try {
      await client.connect();
      const mailboxes = await client.list();
      const inbox = mailboxes.find((box) => box.path.toUpperCase() === "INBOX" || box.specialUse === "\\Inbox");
      const junk = mailboxes.find((box) => box.specialUse === "\\Junk") ?? mailboxes.find((box) => JUNK_NAMES.has(box.name.toLowerCase()) || JUNK_NAMES.has(box.path.toLowerCase()));
      if (!inbox) throw new Error("IMAP 服务器未返回收件箱");
      const max = this.db.getSettings().maxMessagesPerAccount;
      await this.syncFolder(client, account, "inbox", inbox.path, max);
      if (junk) await this.syncFolder(client, account, "junk", junk.path, max);
      else this.db.resetFolder(accountId, "junk");
      this.db.enforceRetention(accountId);
      this.db.setAccountStatus(accountId, junk ? "connected" : "warning", junk ? null : "未找到垃圾邮箱文件夹", true);
    } catch (error) {
      this.db.setAccountStatus(accountId, "error", errorMessage(error));
      throw error;
    } finally {
      if (client.usable) await client.logout().catch(() => undefined);
    }
  }

  private async syncFolder(client: ImapFlow, account: StoredAccount, kind: FolderKind, path: string, max: number): Promise<void> {
    const lock = await client.getMailboxLock(path);
    try {
      const uidValidity = String(client.mailbox && client.mailbox.uidValidity ? client.mailbox.uidValidity : "0");
      const prior = this.db.getFolderState(account.id, kind);
      if (prior && prior.uidValidity !== uidValidity) this.db.resetFolder(account.id, kind);
      const allUids = await client.search({ all: true }, { uid: true });
      const recentUids = (allUids || []).slice(-max);
      if (recentUids.length) {
        for await (const message of client.fetch(recentUids, { uid: true, flags: true, envelope: true, internalDate: true, bodyStructure: true }, { uid: true })) {
          const read = message.flags?.has("\\Seen") ?? false;
          const known = this.db.getKnownMessage(account.id, kind, uidValidity, message.uid);
          if (known) {
            if (known.read !== read) this.db.updateKnownRead(known.id, read);
            continue;
          }
          const plan = planBodyParts(message.bodyStructure);
          const content = await this.fetchContent(client, message.uid, message.envelope, plan);
          const displayTime = new Date(message.envelope?.date ?? message.internalDate ?? Date.now()).toISOString();
          this.db.upsertMessage({
            accountId: account.id, folder: kind, mailboxPath: path, uid: message.uid, uidValidity,
            read, displayTime, content
          });
        }
      }
      this.db.removeMissingFolderMessages(account.id, kind, uidValidity, recentUids);
      this.db.setFolderState(account.id, kind, path, uidValidity);
    } finally {
      lock.release();
    }
  }

  private async fetchContent(client: ImapFlow, uid: number, envelope: ImapFlow["mailbox"] extends never ? never : unknown, plan: BodyPartPlan): Promise<StoredMessageContent> {
    const env = (envelope ?? {}) as { subject?: string; from?: unknown; to?: unknown; cc?: unknown };
    let text = "";
    let html: string | null = null;
    if (plan.textParts.length) {
      const fetched = await client.fetchOne(uid, { bodyParts: plan.textParts.map((part) => part.part) }, { uid: true });
      if (fetched && fetched.bodyParts) {
        for (const part of plan.textParts) {
          const body = fetched.bodyParts.get(part.part);
          if (!body) continue;
          const transferEncoding = fetched.binaryParts?.has(part.part) ? "8bit" : part.encoding;
          const wrapped = Buffer.concat([
            Buffer.from(`Content-Type: ${part.type}; charset=${JSON.stringify(part.charset)}\r\nContent-Transfer-Encoding: ${transferEncoding}\r\n\r\n`, "utf8"),
            body
          ]);
          const parsed = await simpleParser(wrapped, { skipHtmlToText: true, skipTextToHtml: true });
          if (part.type === "text/plain" && parsed.text) text += `${parsed.text}\n`;
          if (part.type === "text/html" && parsed.html) html = `${html ?? ""}${parsed.html}`;
        }
      }
    }
    const sanitized = html ? cleanHtml(html) : null;
    if (!text && sanitized) text = sanitizeHtml(sanitized, { allowedTags: [], allowedAttributes: {} });
    text = text.trim();
    return {
      subject: env.subject?.trim() || "（无主题）",
      from: normalizeAddresses(env.from), to: normalizeAddresses(env.to), cc: normalizeAddresses(env.cc),
      preview: previewOf(text), text, html: sanitized, attachments: plan.attachments
    };
  }

  private createClient(account: StoredAccount): ImapFlow {
    const client = new ImapFlow({
      host: account.imap.host,
      port: account.imap.port,
      secure: account.imap.secure,
      auth: { user: account.email, pass: account.password },
      logger: false,
      disableAutoIdle: true
    });
    // ImapFlow may emit a socket error independently of a rejected operation.
    // The active operation still records the failure on the account.
    client.on("error", () => undefined);
    return client;
  }

  private requireAccount(id: string): StoredAccount {
    const account = this.db.getAccount(id);
    if (!account) throw new Error("邮箱账号不存在");
    return account;
  }
}
