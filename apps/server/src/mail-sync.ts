import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import sanitizeHtml from "sanitize-html";
import type { Address, FolderKind } from "@imap2api/shared";
import { AppDatabase, type StoredAccount, type StoredMessageContent } from "./database.js";
import { EventBroker } from "./events.js";
import { classifyMail, FORWARDING_HEADER_FIELDS, MAIL_CLASSIFICATION_VERSION, resolveForwardedVia } from "./mail-classifier.js";

interface BodyPartPlan {
  textParts: Array<{ part: string; type: "text/plain" | "text/html"; charset: string; encoding: string }>;
  inlineImages: Array<{ part: string; type: InlineImageType; contentId: string; encoding: string }>;
  attachments: string[];
}

type InlineImageType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

const INLINE_IMAGE_TYPES = new Set<InlineImageType>(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_INLINE_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_INLINE_IMAGES_BYTES = 5 * 1024 * 1024;
const MAIL_HTML_POLICY_VERSION = 2;

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
  const inlineImages: BodyPartPlan["inlineImages"] = [];
  const attachments: string[] = [];
  let inlineImageBytes = 0;
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const part = node as {
      part?: string; type?: string; subtype?: string; encoding?: string; parameters?: unknown;
      id?: string; size?: number; disposition?: string; dispositionParameters?: unknown; childNodes?: unknown[];
    };
    const mime = (part.type?.includes("/") ? part.type : `${part.type ?? ""}/${part.subtype ?? ""}`).toLowerCase();
    const disposition = part.disposition?.toLowerCase() ?? "";
    const filename = getParam(part.dispositionParameters, "filename") ?? getParam(part.parameters, "name");
    const contentId = normalizeContentId(part.id);
    if (part.part && contentId && disposition !== "attachment" && INLINE_IMAGE_TYPES.has(mime as InlineImageType)
      && typeof part.size === "number" && part.size > 0 && part.size <= MAX_INLINE_IMAGE_BYTES && inlineImages.length < 32
      && inlineImageBytes + part.size <= MAX_INLINE_IMAGES_BYTES) {
      inlineImages.push({ part: part.part, type: mime as InlineImageType, contentId, encoding: part.encoding ?? "7bit" });
      inlineImageBytes += part.size;
      if (filename) attachments.push(filename);
    } else if (filename || disposition === "attachment") {
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
  return { textParts: textParts.slice(0, 8), inlineImages, attachments: [...new Set(attachments)] };
}

function normalizeContentId(value?: string): string {
  return (value ?? "").trim().replace(/^cid:/i, "").replace(/^<|>$/g, "").trim().toLowerCase();
}

function replaceCidReferences(value: string, images: ReadonlyMap<string, string>): string {
  const normalizedImages = [...images.entries()].map(([contentId, dataUrl]) => [normalizeContentId(contentId), dataUrl] as const);
  return normalizedImages.sort(([left], [right]) => right.length - left.length).reduce((html, [contentId, dataUrl]) => {
    const escaped = contentId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return html.replace(new RegExp(`cid:${escaped}(?=$|[\\s"'<>\\)])`, "gi"), dataUrl);
  }, value);
}

export function cleanHtml(value: string, inlineImages: ReadonlyMap<string, string> = new Map()): string {
  const localizedImageUrls = new Set(inlineImages.values());
  return sanitizeHtml(replaceCidReferences(value, inlineImages), {
    allowedTags: [
      "a", "address", "article", "aside", "b", "big", "blockquote", "br", "center", "code", "col", "colgroup",
      "dd", "div", "dl", "dt", "em", "figcaption", "figure", "font", "footer", "h1", "h2", "h3", "h4", "h5", "h6",
      "header", "hr", "i", "img", "li", "main", "ol", "p", "pre", "s", "section", "small", "span", "strike",
      "strong", "style", "sub", "sup", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "u", "ul", "body", "html"
    ],
    allowedAttributes: {
      "*": ["class", "id", "style", "title", "dir", "lang", "role", "aria-*"],
      a: ["name", "data-safe-href"],
      blockquote: ["cite"],
      col: ["span", "width"], colgroup: ["span", "width"],
      font: ["color", "face", "size"],
      img: ["src", "data-remote-src", "alt", "width", "height"],
      ol: ["start", "type", "reversed"], li: ["value"],
      table: ["align", "bgcolor", "border", "cellpadding", "cellspacing", "height", "width"],
      tbody: ["align", "valign"], td: ["align", "bgcolor", "colspan", "height", "rowspan", "valign", "width"],
      tfoot: ["align", "valign"], th: ["align", "bgcolor", "colspan", "height", "rowspan", "scope", "valign", "width"],
      thead: ["align", "valign"], tr: ["align", "bgcolor", "height", "valign"]
    },
    allowedSchemes: ["http", "https", "mailto"],
    allowedSchemesByTag: { img: ["data"] },
    allowProtocolRelative: false,
    transformTags: {
      a: (_tag, attrs) => {
        const safeAttrs = { ...attrs };
        const href = safeExternalUrl(safeAttrs.href, new Set(["http:", "https:", "mailto:"]));
        delete safeAttrs.href;
        delete safeAttrs.target;
        delete safeAttrs.rel;
        return { tagName: "a", attribs: { ...safeAttrs, ...(href ? { "data-safe-href": href } : {}) } };
      },
      body: (_tag, attrs) => ({ tagName: "div", attribs: attrs }),
      html: (_tag, attrs) => ({ tagName: "div", attribs: attrs }),
      img: (_tag, attrs) => {
        const src = attrs.src && localizedImageUrls.has(attrs.src) ? attrs.src : undefined;
        const remoteSrc = src ? undefined : safeExternalUrl(attrs.src, new Set(["http:", "https:"]));
        const safeAttrs = { ...attrs };
        delete safeAttrs.src;
        return { tagName: "img", attribs: { ...safeAttrs, ...(src ? { src } : {}), ...(remoteSrc ? { "data-remote-src": remoteSrc } : {}) } };
      }
    },
    nonTextTags: ["script", "style", "textarea", "option", "title"],
    disallowedTagsMode: "discard",
    allowVulnerableTags: true
  });
}

function safeExternalUrl(value: string | undefined, allowedProtocols: ReadonlySet<string>): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value.trim());
    return allowedProtocols.has(parsed.protocol) ? parsed.href : null;
  } catch {
    return null;
  }
}

function safeInlineImageDataUrl(type: InlineImageType, content: Buffer): string | null {
  if (!content.length || content.length > MAX_INLINE_IMAGE_BYTES) return null;
  const valid = type === "image/png" ? content.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    : type === "image/jpeg" ? content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff
      : type === "image/gif" ? /^GIF8[79]a$/.test(content.subarray(0, 6).toString("ascii"))
        : content.subarray(0, 4).toString("ascii") === "RIFF" && content.subarray(8, 12).toString("ascii") === "WEBP";
  return valid ? `data:${type};base64,${content.toString("base64")}` : null;
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
        ? await client.fetchAll(`${start}:*`, {
          uid: true, flags: true, envelope: true, internalDate: true, bodyStructure: true,
          headers: [...FORWARDING_HEADER_FIELDS]
        })
        : [];
      const recentUids = messages.map((message) => message.uid);
      for (const message of messages) {
        const read = message.flags?.has("\\Seen") ?? false;
        const known = this.db.getKnownMessage(account.id, kind, uidValidity, message.uid);
        if (known && known.htmlPolicyVersion === MAIL_HTML_POLICY_VERSION) {
          let changed = false;
          if (known.classificationVersion !== MAIL_CLASSIFICATION_VERSION) {
            const env = (message.envelope ?? {}) as { to?: unknown; cc?: unknown };
            const forwardedVia = await resolveForwardedVia({
              accountEmail: account.email, aliases: account.aliases,
              to: normalizeAddresses(env.to), cc: normalizeAddresses(env.cc), headers: message.headers
            });
            changed = this.db.reclassifyMessage(known.id, account, forwardedVia);
          }
          if (known.read !== read) {
            this.db.updateKnownRead(known.id, read);
            changed = true;
          }
          if (changed) change.updatedIds.push(known.id);
          continue;
        }
        const displayTime = this.displayTime(message.envelope?.date, message.internalDate);
        if (!known && !this.db.isInRetentionWindow(account.id, displayTime, kind, message.uid)) continue;
        const content = await this.fetchContent(client, account, message.uid, message.envelope, message.headers, planBodyParts(message.bodyStructure));
        const id = this.db.upsertMessage({
          ...(known ? { id: known.id } : {}),
          accountId: account.id, folder: kind, mailboxPath: path, uid: message.uid, uidValidity,
          read, displayTime, content
        });
        (known ? change.updatedIds : change.addedIds).push(id);
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

  private async fetchContent(client: ImapFlow, account: StoredAccount, uid: number, envelope: unknown, headers: Buffer | undefined, plan: BodyPartPlan): Promise<StoredMessageContent> {
    const env = (envelope ?? {}) as { subject?: string; from?: unknown; to?: unknown; cc?: unknown };
    let text = "";
    let html: string | null = null;
    const inlineImages = new Map<string, string>();
    const requestedParts = [...plan.textParts, ...plan.inlineImages].map((part) => part.part);
    if (requestedParts.length) {
      const fetched = await client.fetchOne(uid, { bodyParts: requestedParts }, { uid: true });
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
        let inlineImageBytes = 0;
        for (const part of plan.inlineImages) {
          const body = fetched.bodyParts.get(part.part);
          if (!body) continue;
          const transferEncoding = fetched.binaryParts?.has(part.part) ? "8bit" : part.encoding;
          const wrapped = Buffer.concat([
            Buffer.from(`Content-Type: ${part.type}\r\nContent-Transfer-Encoding: ${transferEncoding}\r\n\r\n`, "utf8"),
            body
          ]);
          const parsed = await simpleParser(wrapped, { skipHtmlToText: true, skipTextToHtml: true });
          const content = parsed.attachments[0]?.content;
          if (!content || inlineImageBytes + content.length > MAX_INLINE_IMAGES_BYTES) continue;
          const dataUrl = safeInlineImageDataUrl(part.type, content);
          if (!dataUrl) continue;
          inlineImages.set(part.contentId, dataUrl);
          inlineImageBytes += content.length;
        }
      }
    }
    const sanitized = html ? cleanHtml(html, inlineImages) : null;
    if (!text && sanitized) text = sanitizeHtml(sanitized, { allowedTags: [], allowedAttributes: {} });
    text = text.trim();
    const content: StoredMessageContent = {
      htmlPolicyVersion: MAIL_HTML_POLICY_VERSION,
      subject: env.subject?.trim() || "（无主题）",
      from: normalizeAddresses(env.from), to: normalizeAddresses(env.to), cc: normalizeAddresses(env.cc),
      preview: text.replace(/\s+/g, " ").trim().slice(0, 180),
      text, html: sanitized, attachments: plan.attachments
    };
    const forwardedVia = await resolveForwardedVia({
      accountEmail: account.email, aliases: account.aliases, to: content.to, cc: content.cc, headers
    });
    return {
      ...content,
      ...classifyMail({
        accountEmail: account.email, aliases: account.aliases, to: content.to, cc: content.cc,
        text, html: sanitized, forwardedVia
      })
    };
  }
}

function dateValue(value?: Date | string): number {
  return value instanceof Date ? value.getTime() : Date.parse(value ?? "");
}
