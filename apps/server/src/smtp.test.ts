import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type SMTPTransport from "nodemailer/lib/smtp-transport/index.js";
import { AppDatabase } from "./database.js";
import { HttpError } from "./errors.js";
import { SmtpCancelledError, SmtpService, type SmtpTransportFactory } from "./smtp.js";

const dirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(sendResult = {
  messageId: "message-id", accepted: ["to@example.com"], rejected: [], pending: [], response: "250 OK", envelope: { from: "mail@gmail.com", to: ["to@example.com"] }
}) {
  const dir = mkdtempSync(join(tmpdir(), "imap2api-smtp-")); dirs.push(dir);
  const db = new AppDatabase(join(dir, "smtp.db"), "s".repeat(32));
  db.updateSettings({ defaultSenderName: "System Sender" });
  const account = db.createAccount({
    email: "mail@gmail.com", password: "app-password", aliases: ["alias@gmail.com"], defaultSenderName: "Account Sender"
  });
  const transport = {
    verify: vi.fn().mockResolvedValue(true),
    sendMail: vi.fn().mockResolvedValue(sendResult),
    close: vi.fn()
  };
  const factory = vi.fn(() => transport) as unknown as SmtpTransportFactory;
  return { db, account, transport, factory, service: new SmtpService(db, factory) };
}

describe("SMTP service", () => {
  it("verifies with the account credential and enforces TLS settings", async () => {
    const { db, account, transport, factory, service } = setup();
    await service.test(account.id);
    expect(factory).toHaveBeenCalledWith(expect.objectContaining({
      host: "smtp.gmail.com", port: 465, secure: true, requireTLS: false,
      auth: { user: "mail@gmail.com", pass: "app-password" }, tls: { rejectUnauthorized: true }
    }));
    expect(transport.verify).toHaveBeenCalledOnce();
    expect(transport.close).toHaveBeenCalledOnce();
    db.close();
  });

  it("sends from an alias, sanitizes HTML and applies the account sender name", async () => {
    const { db, account, transport, service } = setup();
    const result = await service.send({
      accountId: account.id, fromAddress: "alias@gmail.com", to: ["to@example.com"], cc: ["cc@example.com"],
      subject: "Subject", html: '<p>Hello <strong>world</strong><script>alert(1)</script><a href="javascript:bad">bad</a></p>'
    }, [{ path: "/tmp/file", filename: "report.pdf", contentType: "application/pdf" }]);
    expect(result).toEqual({ messageId: "message-id", accepted: ["to@example.com"], rejected: [] });
    expect(transport.sendMail).toHaveBeenCalledWith(expect.objectContaining({
      from: { address: "alias@gmail.com", name: "Account Sender" },
      envelope: { from: "alias@gmail.com", to: ["to@example.com", "cc@example.com"] },
      text: "Hello worldbad",
      html: "<p>Hello <strong>world</strong><a>bad</a></p>",
      attachments: [{ path: "/tmp/file", filename: "report.pdf", contentType: "application/pdf" }]
    }));
    db.close();
  });

  it("returns partial rejection details and rejects an invalid from address", async () => {
    const { db, account, service } = setup({
      messageId: "partial", accepted: ["ok@example.com"], rejected: ["bad@example.com"], pending: [], response: "250 OK",
      envelope: { from: "mail@gmail.com", to: ["ok@example.com", "bad@example.com"] }
    });
    await expect(service.send({
      accountId: account.id, fromAddress: "mail@gmail.com", to: ["ok@example.com", "bad@example.com"], subject: "", html: "<p>Body</p>"
    }, [])).resolves.toEqual({ messageId: "partial", accepted: ["ok@example.com"], rejected: ["bad@example.com"] });
    await expect(service.send({
      accountId: account.id, fromAddress: "other@example.com", to: ["ok@example.com"], subject: "", html: "<p>Body</p>"
    }, [])).rejects.toThrow("发件地址不属于");
    db.close();
  });

  it("returns a structured error when every recipient is rejected", async () => {
    const { db, account, service } = setup({
      messageId: "rejected", accepted: [], rejected: ["bad@example.com"], pending: [], response: "550 rejected",
      envelope: { from: "mail@gmail.com", to: ["bad@example.com"] }
    });
    await expect(service.send({
      accountId: account.id, fromAddress: "mail@gmail.com", to: ["bad@example.com"], subject: "", html: "<p>Body</p>"
    }, [])).rejects.toMatchObject<HttpError>({ statusCode: 502, code: "SMTP_RECIPIENTS_REJECTED" });
    db.close();
  });

  it("closes the transport when a send is cancelled", async () => {
    const { db, account, transport, service } = setup();
    const controller = new AbortController();
    controller.abort();
    await expect(service.send({
      accountId: account.id, fromAddress: "mail@gmail.com", to: ["to@example.com"], subject: "", html: "<p>Body</p>"
    }, [], controller.signal)).rejects.toBeInstanceOf(SmtpCancelledError);
    expect(transport.sendMail).not.toHaveBeenCalled();
    expect(transport.close).toHaveBeenCalledOnce();
    db.close();
  });

  it("destroys the active SMTP socket when a send is cancelled", async () => {
    const dir = mkdtempSync(join(tmpdir(), "imap2api-smtp-")); dirs.push(dir);
    const db = new AppDatabase(join(dir, "smtp.db"), "s".repeat(32));
    const account = db.createAccount({ email: "mail@gmail.com", password: "app-password" });
    let sendStarted: (() => void) | null = null;
    const started = new Promise<void>((resolve) => { sendStarted = resolve; });
    const close = vi.fn();
    let activeSocket: NonNullable<SMTPTransport.Options["socket"]> | null = null;
    const factory = vi.fn((options: SMTPTransport.Options) => {
      activeSocket = options.socket!;
      return {
        verify: vi.fn().mockResolvedValue(true),
        sendMail: vi.fn(() => new Promise((_resolve, reject) => {
          sendStarted?.();
          options.socket!.once("close", () => reject(new Error("socket closed")));
        })),
        close
      };
    }) as unknown as SmtpTransportFactory;
    const service = new SmtpService(db, factory);
    const controller = new AbortController();
    const sending = service.send({
      accountId: account.id, fromAddress: "mail@gmail.com", to: ["to@example.com"], subject: "", html: "<p>Body</p>"
    }, [], controller.signal);
    await started;
    const socket = activeSocket!;

    controller.abort();

    await expect(sending).rejects.toBeInstanceOf(SmtpCancelledError);
    expect(socket.destroyed).toBe(true);
    expect(close).toHaveBeenCalledOnce();
    db.close();
  });

  it("destroys active SMTP sockets when the service stops", async () => {
    const dir = mkdtempSync(join(tmpdir(), "imap2api-smtp-")); dirs.push(dir);
    const db = new AppDatabase(join(dir, "smtp.db"), "s".repeat(32));
    const account = db.createAccount({ email: "mail@gmail.com", password: "app-password" });
    let activeSocket: NonNullable<SMTPTransport.Options["socket"]> | null = null;
    let markStarted: (() => void) | null = null;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const close = vi.fn();
    const factory = vi.fn((options: SMTPTransport.Options) => {
      activeSocket = options.socket!;
      return {
        verify: vi.fn().mockResolvedValue(true),
        sendMail: vi.fn(() => new Promise((_resolve, reject) => {
          markStarted?.();
          options.socket!.once("close", () => reject(new Error("socket closed")));
        })),
        close
      };
    }) as unknown as SmtpTransportFactory;
    const service = new SmtpService(db, factory);
    const sending = service.send({
      accountId: account.id, fromAddress: "mail@gmail.com", to: ["to@example.com"], subject: "", html: "<p>Body</p>"
    }, []);
    await started;
    const socket = activeSocket!;

    service.stop();

    await expect(sending).rejects.toThrow("socket closed");
    expect(socket.destroyed).toBe(true);
    expect(close).toHaveBeenCalledOnce();
    db.close();
  });
});
