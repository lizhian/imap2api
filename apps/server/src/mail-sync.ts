import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import sanitizeHtml from "sanitize-html";
import type { Address, FolderKind } from "@imap2api/shared";
import { AppDatabase, type StoredAccount, type StoredMessageContent } from "./database.js";
import { EventBroker } from "./events.js";

interface BodyPartPlan {
  textParts: Array<{ part: string; type: "text/plain" | "text/html"; charset: string; encoding: string }>;
  attachments: string[];
}

interface MailboxChange {
  accountId: string;
  folder: FolderKind;
  addedIds: string[];
  updatedIds: string[];
  deletedIds: string[];
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
      part?: string; type?: string; subtype?: string; encoding?: string; parameters?: unknown;
      disposition?: string; dispositionParameters?: unknown; childNodes?: unknown[];
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

export class MailboxSynchronizer {
  constructor(private readonly db: AppDatabase, private readonly events: EventBroker) {}

  async syncFolder(client: ImapFlow, account: StoredAccount, kind: FolderKind, path: string, max: number): Promise<string> {
    const change: MailboxChange = { accountId: account.id, folder: kind, addedIds: [], updatedIds: [], deletedIds: [] };
    const lock = await client.getMailboxLock(path);
    try {
      const uidValidity = String(client.mailbox && client.mailbox.uidValidity ? client.mailbox.uidValidity : "0");
      const prior = this.db.getFolderState(account.id, kind);
      if (prior && prior.uidValidity !== uidValidity) change.deletedIds.push(...this.db.resetFolder(account.id, kind));
      const exists = client.mailbox ? client.mailbox.exists : 0;
      const start = Math.max(1, exists - max + 1);
      const messages = exists > 0
        ? await client.fetchAll(`${start}:*`, { uid: true, flags: true, envelope: true, internalDate: true, bodyStructure: true })
        : [];
      const recentUids = messages.map((message) => message.uid);
      for (const message of messages) {
        const read = message.flags?.has("\\Seen") ?? false;
        const known = this.db.getKnownMessage(account.id, kind, uidValidity, message.uid);
        if (known) {
          if (known.read !== read) {
            this.db.updateKnownRead(known.id, read);
            change.updatedIds.push(known.id);
          }
          continue;
        }
        const displayTime = this.displayTime(message.envelope?.date, message.internalDate);
        if (!this.db.isInRetentionWindow(account.id, displayTime, kind, message.uid)) continue;
        const content = await this.fetchContent(client, message.uid, message.envelope, planBodyParts(message.bodyStructure));
        const id = this.db.upsertMessage({
          accountId: account.id, folder: kind, mailboxPath: path, uid: message.uid, uidValidity,
          read, displayTime, content
        });
        change.addedIds.push(id);
      }
      change.deletedIds.push(...this.db.removeMissingFolderMessages(account.id, kind, uidValidity, recentUids));
      this.db.setFolderState(account.id, kind, path, uidValidity);
      for (const removed of this.db.enforceRetention(account.id)) {
        if (removed.folder === kind) change.deletedIds.push(removed.id);
        else this.publishChange({ accountId: account.id, folder: removed.folder, addedIds: [], updatedIds: [], deletedIds: [removed.id] });
      }
      this.publishChange(change);
      return uidValidity;
    } finally {
      lock.release();
    }
  }

  publishChange(change: MailboxChange): void {
    const rawAdded = new Set(change.addedIds);
    const rawDeleted = new Set(change.deletedIds);
    const addedIds = [...rawAdded].filter((id) => !rawDeleted.has(id) && this.db.hasMessage(id));
    const updatedIds = [...new Set(change.updatedIds)].filter((id) => !rawDeleted.has(id) && this.db.hasMessage(id));
    const deletedIds = [...rawDeleted].filter((id) => !rawAdded.has(id) && !this.db.hasMessage(id));
    if (!addedIds.length && !updatedIds.length && !deletedIds.length) return;
    this.events.publish({ type: "messages.changed", ...change, addedIds, updatedIds, deletedIds, occurredAt: new Date().toISOString() });
  }

  private displayTime(envelopeDate?: Date | string, internalDate?: Date | string): string {
    const preferred = dateValue(envelopeDate);
    if (Number.isFinite(preferred)) return new Date(preferred).toISOString();
    const fallback = dateValue(internalDate);
    return new Date(Number.isFinite(fallback) ? fallback : Date.now()).toISOString();
  }

  private async fetchContent(client: ImapFlow, uid: number, envelope: unknown, plan: BodyPartPlan): Promise<StoredMessageContent> {
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
      preview: text.replace(/\s+/g, " ").trim().slice(0, 180),
      text, html: sanitized, attachments: plan.attachments
    };
  }
}

function dateValue(value?: Date | string): number {
  return value instanceof Date ? value.getTime() : Date.parse(value ?? "");
}
