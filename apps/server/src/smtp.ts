import { Socket } from "node:net";
import nodemailer from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport/index.js";
import { htmlToText } from "html-to-text";
import sanitizeHtml from "sanitize-html";
import type { SendMailInput, SendMailResult } from "@email2api/shared";
import { AppDatabase } from "./database.js";
import { AccountNotFoundError, HttpError, InputError } from "./errors.js";

export interface OutgoingAttachment {
  path: string;
  filename: string;
  contentType: string;
}

type Transport = ReturnType<typeof nodemailer.createTransport<SMTPTransport.SentMessageInfo>>;
export type SmtpTransportFactory = (options: SMTPTransport.Options) => Transport;

interface ActiveTransport {
  transport: Transport;
  socket: Socket;
  closed: boolean;
}

export class SmtpCancelledError extends Error {
  constructor() {
    super("SMTP operation cancelled");
    this.name = "SmtpCancelledError";
  }
}

const OUTGOING_HTML_POLICY: sanitizeHtml.IOptions = {
  allowedTags: [
    "p", "br", "h1", "h2", "h3", "strong", "b", "em", "i", "u", "s", "strike",
    "blockquote", "hr", "ul", "ol", "li", "a", "table", "thead", "tbody", "tfoot", "tr", "th", "td"
  ],
  allowedAttributes: {
    a: ["href", "title"],
    table: ["style"],
    th: ["colspan", "rowspan", "style"],
    td: ["colspan", "rowspan", "style"]
  },
  allowedStyles: {
    table: {
      "border-collapse": [/^collapse$/],
      width: [/^100%$/],
      "table-layout": [/^fixed$/]
    },
    th: {
      border: [/^1px solid #d1d5db$/i],
      padding: [/^6px 8px$/],
      "vertical-align": [/^top$/],
      "background-color": [/^#f3f4f6$/i],
      "text-align": [/^left$/]
    },
    td: {
      border: [/^1px solid #d1d5db$/i],
      padding: [/^6px 8px$/],
      "vertical-align": [/^top$/]
    }
  },
  allowedSchemes: ["http", "https", "mailto"],
  allowProtocolRelative: false,
  disallowedTagsMode: "discard"
};

export class SmtpService {
  private readonly activeTransports = new Set<ActiveTransport>();

  constructor(
    private readonly db: AppDatabase,
    private readonly transportFactory: SmtpTransportFactory = (options) => nodemailer.createTransport<SMTPTransport.SentMessageInfo>(options)
  ) {}

  async test(accountId: string): Promise<void> {
    const account = this.db.getAccount(accountId);
    if (!account) throw new AccountNotFoundError();
    if (!account.smtp) throw new HttpError(400, "SMTP_NOT_CONFIGURED", "该邮箱账号尚未配置 SMTP");
    const active = this.createTransport(account);
    this.activeTransports.add(active);
    try {
      await active.transport.verify();
    } finally {
      this.activeTransports.delete(active);
      this.closeTransport(active);
    }
  }

  async send(input: SendMailInput, attachments: OutgoingAttachment[], signal?: AbortSignal): Promise<SendMailResult> {
    const account = this.db.getAccount(input.accountId);
    if (!account) throw new AccountNotFoundError();
    if (!account.smtp) throw new HttpError(400, "SMTP_NOT_CONFIGURED", "该邮箱账号尚未配置 SMTP");

    const fromAddress = input.fromAddress.trim().toLowerCase();
    if (![account.email, ...account.aliases].includes(fromAddress)) {
      throw new InputError("发件地址不属于所选邮箱账号");
    }

    const html = sanitizeHtml(input.html, OUTGOING_HTML_POLICY);
    const text = htmlToText(html, { wordwrap: false, selectors: [{ selector: "a", options: { hideLinkHrefIfSameAsText: true } }] }).trim();
    if (!text && attachments.length === 0) throw new InputError("正文和附件不能同时为空");

    const senderName = input.senderName?.trim()
      || account.defaultSenderName
      || this.db.getSettings().defaultSenderName
      || undefined;
    const recipients = [...input.to, ...(input.cc ?? []), ...(input.bcc ?? [])];
    const active = this.createTransport(account);
    const cancel = () => this.closeTransport(active);
    this.activeTransports.add(active);
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      if (signal?.aborted) throw new SmtpCancelledError();
      let result: SMTPTransport.SentMessageInfo;
      try {
        result = await active.transport.sendMail({
          from: { address: fromAddress, ...(senderName ? { name: senderName } : {}) },
          envelope: { from: fromAddress, to: recipients },
          to: input.to,
          cc: input.cc,
          bcc: input.bcc,
          subject: input.subject,
          text,
          html,
          attachments: attachments.map((attachment) => ({
            path: attachment.path,
            filename: attachment.filename,
            contentType: attachment.contentType
          }))
        });
      } catch (error) {
        if (signal?.aborted) throw new SmtpCancelledError();
        throw error;
      }
      if (signal?.aborted) throw new SmtpCancelledError();
      const accepted = result.accepted.map(addressValue);
      const rejected = result.rejected.map(addressValue);
      if (!accepted.length) {
        throw new HttpError(502, "SMTP_RECIPIENTS_REJECTED", "SMTP 服务器拒绝了全部收件人", { rejected });
      }
      return { messageId: result.messageId, accepted, rejected };
    } finally {
      signal?.removeEventListener("abort", cancel);
      this.activeTransports.delete(active);
      this.closeTransport(active);
    }
  }

  stop(): void {
    for (const active of this.activeTransports) this.closeTransport(active);
    this.activeTransports.clear();
  }

  private createTransport(account: NonNullable<ReturnType<AppDatabase["getAccount"]>>): ActiveTransport {
    const smtp = account.smtp!;
    const socket = new Socket();
    const transport = this.transportFactory({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      requireTLS: !smtp.secure,
      auth: { user: account.email, pass: account.password },
      tls: { rejectUnauthorized: true },
      socket
    });
    return { transport, socket, closed: false };
  }

  private closeTransport(active: ActiveTransport): void {
    if (active.closed) return;
    active.closed = true;
    active.socket.destroy();
    active.transport.close();
  }
}

function addressValue(value: string | { address: string }): string {
  return typeof value === "string" ? value : value.address;
}
