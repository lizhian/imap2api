import { existsSync } from "node:fs";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { pipeline } from "node:stream/promises";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyMultipart from "@fastify/multipart";
import { z, ZodError } from "zod";
import { AppDatabase } from "./database.js";
import { ImapService } from "./imap.js";
import { EventBroker, type PublishedEvent } from "./events.js";
import { AccountNotFoundError, HttpError, InputError, MessageNotFoundError } from "./errors.js";
import { DownloadCancelledError } from "./download-limiter.js";
import type { AppConfig } from "./config.js";
import { SmtpCancelledError, SmtpService, type OutgoingAttachment } from "./smtp.js";

const providerSchema = z.enum(["auto", "qq", "gmail", "icloud", "outlook", "qq-enterprise", "163", "custom"]);
const imapSchema = z.object({
  provider: providerSchema.default("auto"),
  host: z.string().trim().max(255).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  secure: z.boolean().optional()
}).optional();
const smtpSchema = z.object({
  host: z.string().trim().min(1).max(255).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  secure: z.boolean().optional()
}).nullable().optional();
const senderNameSchema = z.string().trim().max(200).refine((value) => !/[\r\n]/u.test(value), "发件人名称不能包含换行");
const aliasesSchema = z.array(z.string().trim().pipe(z.email().max(320)).transform((value) => value.toLowerCase())).max(50).optional();
const remoteImageAllowlistSchema = z.array(
  z.string().trim().pipe(z.email().max(320)).transform((value) => value.toLowerCase())
).max(200).transform((values) => [...new Set(values)]).optional();
const accountCreateSchema = z.object({
  email: z.email().max(320),
  password: z.string().min(1).max(4096),
  aliases: aliasesSchema,
  imap: imapSchema,
  smtp: smtpSchema,
  defaultSenderName: senderNameSchema.nullable().optional()
});
const accountUpdateSchema = z.object({
  email: z.email().max(320).optional(),
  password: z.string().min(1).max(4096).optional(),
  aliases: aliasesSchema,
  imap: imapSchema,
  smtp: smtpSchema,
  defaultSenderName: senderNameSchema.nullable().optional()
}).refine((value) => Object.keys(value).length > 0, "至少提供一个修改字段");
const accountOrderSchema = z.object({
  accountIds: z.array(z.uuid()).max(1000)
}).refine((value) => new Set(value.accountIds).size === value.accountIds.length, "账号排序不能包含重复项");
const syncFoldersSchema = z.object({
  folders: z.array(z.object({
    path: z.string().trim().min(1).max(1000),
    mode: z.enum(["idle", "polling"])
  })).max(20)
}).superRefine((value, context) => {
  if (new Set(value.folders.map((folder) => folder.path)).size !== value.folders.length) {
    context.addIssue({ code: "custom", message: "同步文件夹不能重复", path: ["folders"] });
  }
  if (value.folders.filter((folder) => folder.mode === "idle").length > 5) {
    context.addIssue({ code: "custom", message: "最多可为 5 个自定义文件夹启用 IDLE", path: ["folders"] });
  }
});
const messageListSchema = z.object({
  accountId: z.string().uuid().optional(),
  view: z.enum(["all", "unread", "junk"]).default("all"),
  filter: z.preprocess(
    (value) => value === undefined ? [] : Array.isArray(value) ? value : [value],
    z.array(z.enum(["verification_code", "attachment", "forwarded"])).max(3)
  ).transform((values) => [...new Set(values)]),
  after: z.iso.datetime({ offset: true }).optional(),
  before: z.iso.datetime({ offset: true }).optional(),
  cursor: z.string().max(1000).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(100)
});
const recipientListSchema = z.array(z.string().trim().pipe(z.email().max(320)).transform((value) => value.toLowerCase())).max(100);
const sendMailSchema = z.object({
  accountId: z.uuid(),
  fromAddress: z.string().trim().pipe(z.email().max(320)).transform((value) => value.toLowerCase()),
  senderName: senderNameSchema.optional(),
  to: recipientListSchema,
  cc: recipientListSchema.optional(),
  bcc: recipientListSchema.optional(),
  subject: z.string().max(998).refine((value) => !/[\r\n]/u.test(value), "主题不能包含换行"),
  html: z.string().max(1024 * 1024)
}).superRefine((value, context) => {
  const recipientCount = value.to.length + (value.cc?.length ?? 0) + (value.bcc?.length ?? 0);
  if (recipientCount === 0) context.addIssue({ code: "custom", message: "至少填写一个收件人", path: ["to"] });
  if (recipientCount > 100) context.addIssue({ code: "custom", message: "收件人总数不能超过 100", path: ["to"] });
});

function authorized(request: FastifyRequest, token: string): boolean {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice(7), "utf8");
  const expected = Buffer.from(token, "utf8");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function sendError(reply: FastifyReply, status: number, code: string, message: string, details?: unknown): FastifyReply {
  return reply.code(status).send({ error: { code, message, ...(details === undefined ? {} : { details }) } });
}

export interface AppDependencies {
  db?: AppDatabase;
  imap?: ImapService;
  smtp?: SmtpService;
  events?: EventBroker;
  eventHeartbeatMs?: number;
}

export async function buildApp(config: AppConfig, dependencies: AppDependencies = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });
  const ownsDatabase = !dependencies.db;
  const db = dependencies.db ?? new AppDatabase(config.databasePath, config.token, config.initialPollIntervalSeconds);
  const events = dependencies.events ?? new EventBroker();
  const imap = dependencies.imap ?? new ImapService(db, events);
  const smtp = dependencies.smtp ?? new SmtpService(db);
  const eventStreams = new Set<FastifyReply["raw"]>();

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) return sendError(reply, 400, "VALIDATION_ERROR", "请求参数无效", error.flatten());
    if (error instanceof InputError) return sendError(reply, 400, "VALIDATION_ERROR", error.message);
    if (error instanceof AccountNotFoundError) return sendError(reply, 404, "ACCOUNT_NOT_FOUND", error.message);
    if (error instanceof MessageNotFoundError) return sendError(reply, 404, "MESSAGE_NOT_FOUND", error.message);
    if (error instanceof HttpError) return sendError(reply, error.statusCode, error.code, error.message, error.details);
    if ((error as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE") {
      return sendError(reply, 409, "ACCOUNT_EXISTS", "该邮箱账号已存在");
    }
    if ((error as { statusCode?: number }).statusCode === 400) {
      return sendError(reply, 400, "VALIDATION_ERROR", "请求参数无效");
    }
    if ((error as { statusCode?: number }).statusCode === 413) {
      return sendError(reply, 413, "ATTACHMENT_TOO_LARGE", "附件超过系统设置的大小上限");
    }
    request.log.error({ err: error }, "Unhandled API error");
    return sendError(reply, 500, "INTERNAL_ERROR", "服务器内部错误");
  });

  app.get("/healthz", async () => ({ status: "ok" }));
  await app.register(fastifyMultipart, { throwFileSizeLimit: true });

  await app.register(async (api) => {
    api.addHook("onRequest", async (request, reply) => {
      if (!authorized(request, config.token)) return sendError(reply, 401, "UNAUTHORIZED", "Bearer Token 无效或缺失");
    });

    api.post("/auth/verify", async () => ({ ok: true }));

    api.get("/accounts", async () => db.listAccounts());
    api.post("/accounts", async (request, reply) => {
      const account = db.createAccount(accountCreateSchema.parse(request.body));
      imap.startAccount(account.id);
      return reply.code(201).send(account);
    });
    api.put("/accounts/order", async (request) => db.reorderAccounts(accountOrderSchema.parse(request.body).accountIds));
    api.patch<{ Params: { id: string } }>("/accounts/:id", async (request, reply) => {
      const previous = db.getAccount(request.params.id);
      if (!previous) throw new AccountNotFoundError();
      const body = accountUpdateSchema.parse(request.body);
      const account = db.updateAccount(request.params.id, body);
      if (!account) throw new AccountNotFoundError();
      if (previous.email !== account.email || JSON.stringify(previous.aliases) !== JSON.stringify(account.aliases)) {
        const storedAccount = db.getAccount(account.id)!;
        for (const reclassified of db.reclassifyAccountMessages(storedAccount)) {
          events.publish({
            type: "messages.changed", accountId: account.id, folder: reclassified.folder,
            addedIds: [], updatedIds: reclassified.ids, deletedIds: [], occurredAt: new Date().toISOString()
          });
        }
      }
      if (body.email !== undefined || body.password !== undefined || body.imap !== undefined) {
        await imap.restartAccount(account.id);
      }
      return account;
    });
    api.delete<{ Params: { id: string } }>("/accounts/:id", async (request, reply) => {
      if (!db.getAccount(request.params.id)) return sendError(reply, 404, "ACCOUNT_NOT_FOUND", "邮箱账号不存在");
      await imap.removeAccount(request.params.id);
      db.deleteAccount(request.params.id);
      return reply.code(204).send();
    });
    api.post<{ Params: { id: string } }>("/accounts/:id/test", async (request, reply) => {
      try {
        await imap.test(request.params.id);
        return { ok: true };
      } catch (error) {
        if (error instanceof AccountNotFoundError) throw error;
        request.log.warn({ err: error, accountId: request.params.id }, "IMAP connection test failed");
        throw new HttpError(502, "IMAP_CONNECTION_FAILED", "IMAP 连接失败");
      }
    });
    api.post<{ Params: { id: string } }>("/accounts/:id/smtp/test", async (request) => {
      try {
        await smtp.test(request.params.id);
        return { ok: true };
      } catch (error) {
        if (error instanceof AccountNotFoundError || error instanceof HttpError) throw error;
        request.log.warn({ err: error, accountId: request.params.id }, "SMTP connection test failed");
        throw new HttpError(502, "SMTP_CONNECTION_FAILED", "SMTP 连接失败");
      }
    });
    api.post<{ Params: { id: string } }>("/accounts/:id/sync", async (request, reply) => {
      return reply.code(202).send(imap.triggerSync(request.params.id));
    });
    api.get<{ Params: { id: string } }>("/accounts/:id/mailboxes", async (request) => {
      try {
        return await imap.listMailboxes(request.params.id);
      } catch (error) {
        if (error instanceof AccountNotFoundError) throw error;
        request.log.warn({ err: error, accountId: request.params.id }, "IMAP mailbox discovery failed");
        throw new HttpError(502, "IMAP_MAILBOX_LIST_FAILED", "无法读取 IMAP 文件夹");
      }
    });
    api.put<{ Params: { id: string } }>("/accounts/:id/sync-folders", async (request) => {
      try {
        return await imap.updateSyncFolders(request.params.id, syncFoldersSchema.parse(request.body).folders);
      } catch (error) {
        if (error instanceof ZodError || error instanceof InputError || error instanceof AccountNotFoundError) throw error;
        request.log.warn({ err: error, accountId: request.params.id }, "IMAP sync folder update failed");
        throw new HttpError(502, "IMAP_SYNC_FOLDER_UPDATE_FAILED", "同步文件夹保存失败");
      }
    });

    api.get("/messages", async (request, reply) => {
      return db.listMessages(messageListSchema.parse(request.query));
    });
    api.post("/messages/send", async (request, reply) => {
      const controller = new AbortController();
      const cancel = () => controller.abort();
      request.raw.once("aborted", cancel);
      reply.raw.once("close", cancel);
      let upload: Awaited<ReturnType<typeof readSendUpload>> | null = null;
      try {
        upload = await readSendUpload(request, db.getSettings().maxAttachmentSizeMb * 1024 * 1024);
        const input = sendMailSchema.parse(JSON.parse(upload.message));
        const result = await smtp.send(input, upload.attachments, controller.signal);
        return reply.code(result.rejected.length ? 207 : 200).send(result);
      } catch (error) {
        if (error instanceof SmtpCancelledError || controller.signal.aborted) return reply;
        if (error instanceof SyntaxError) throw new InputError("邮件参数不是有效的 JSON");
        if (error instanceof ZodError || error instanceof InputError || error instanceof AccountNotFoundError || error instanceof HttpError) throw error;
        request.log.warn({ err: error }, "SMTP send failed");
        throw new HttpError(502, "SMTP_SEND_FAILED", "邮件发送失败");
      } finally {
        request.raw.removeListener("aborted", cancel);
        reply.raw.removeListener("close", cancel);
        if (upload) await rm(upload.tempDir, { recursive: true, force: true });
      }
    });
    api.get<{ Params: { id: string } }>("/messages/:id", async (request, reply) => {
      return db.getMessage(request.params.id) ?? sendError(reply, 404, "MESSAGE_NOT_FOUND", "邮件不存在");
    });
    api.get<{ Params: { id: string; attachmentId: string } }>("/messages/:id/attachments/:attachmentId", async (request, reply) => {
      const controller = new AbortController();
      const cancel = () => controller.abort();
      request.raw.once("aborted", cancel);
      reply.raw.once("close", cancel);
      try {
        const download = await imap.downloadAttachment(request.params.id, request.params.attachmentId, controller.signal);
        if (controller.signal.aborted) return reply;
        reply.header("Content-Type", download.contentType);
        reply.header("Content-Disposition", attachmentContentDisposition(download.filename));
        reply.header("Cache-Control", "private, no-store");
        reply.header("X-Content-Type-Options", "nosniff");
        return reply.send(download.content);
      } catch (error) {
        if (error instanceof DownloadCancelledError || controller.signal.aborted) return reply;
        if (error instanceof HttpError || error instanceof MessageNotFoundError) throw error;
        request.log.warn({ err: error, messageId: request.params.id }, "IMAP attachment download failed");
        throw new HttpError(502, "IMAP_DOWNLOAD_FAILED", "附件下载失败");
      } finally {
        request.raw.removeListener("aborted", cancel);
      }
    });
    api.patch<{ Params: { id: string } }>("/messages/:id/read", async (request, reply) => {
      try {
        const body = z.object({ read: z.boolean() }).parse(request.body);
        await imap.markRead(request.params.id, body.read);
        return { ok: true, read: body.read };
      } catch (error) {
        if (error instanceof ZodError || error instanceof MessageNotFoundError) throw error;
        request.log.warn({ err: error, messageId: request.params.id }, "IMAP read update failed");
        throw new HttpError(502, "IMAP_UPDATE_FAILED", "IMAP 标记失败");
      }
    });
    api.post<{ Params: { id: string } }>("/accounts/:id/messages/read-all", async (request, reply) => {
      try {
        const result = await imap.markAllRead(request.params.id);
        return reply.code(result.failedFolders.length ? 207 : 200).send(result);
      } catch (error) {
        if (error instanceof AccountNotFoundError) throw error;
        request.log.warn({ err: error, accountId: request.params.id }, "IMAP bulk read update failed");
        throw new HttpError(502, "IMAP_UPDATE_FAILED", "IMAP 批量标记失败");
      }
    });

    api.get("/settings", async () => db.getSettings());
    api.patch("/settings", async (request, reply) => {
      const body = z.object({
        maxMessagesPerAccount: z.number().int().min(1).max(10000).optional(),
        pollIntervalSeconds: z.number().int().min(5).max(3600).optional(),
        pageSize: z.number().int().min(10).max(100).optional(),
        maxConcurrentDownloads: z.number().int().min(1).max(10).optional(),
        maxAttachmentSizeMb: z.number().int().min(1).max(1024).optional(),
        autoLoadRemoteImages: z.boolean().optional(),
        remoteImageAllowlist: remoteImageAllowlistSchema,
        defaultSenderName: senderNameSchema.optional()
      }).refine((value) => Object.keys(value).length > 0, "至少提供一个设置字段").parse(request.body);
      const previous = db.getSettings();
      const result = db.updateSettings(body);
      for (const removed of result.deleted) {
        events.publish({
          type: "messages.changed", accountId: removed.accountId, folder: removed.folder,
          addedIds: [], updatedIds: [], deletedIds: removed.ids, occurredAt: new Date().toISOString()
        });
      }
      imap.applySettings(previous.pollIntervalSeconds);
      return result.settings;
    });

    api.get<{ Querystring: { accountId?: string } }>("/events", async (request, reply) => {
      const query = z.object({ accountId: z.string().uuid().optional() }).safeParse(request.query);
      if (!query.success) return sendError(reply, 400, "VALIDATION_ERROR", "accountId 必须是 UUID");
      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no"
      });
      eventStreams.add(reply.raw);
      const send = (published: PublishedEvent) => {
        if (reply.raw.destroyed || reply.raw.writableEnded) return;
        const { type, ...data } = published.event;
        reply.raw.write(`id: ${published.id}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
      };
      send(events.ready());
      const unsubscribe = events.subscribe(send, query.data.accountId);
      const heartbeat = setInterval(() => {
        if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.write(": ping\n\n");
      }, dependencies.eventHeartbeatMs ?? 15_000);
      heartbeat.unref();
      reply.raw.once("close", () => {
        clearInterval(heartbeat);
        unsubscribe();
        eventStreams.delete(reply.raw);
      });
    });
  }, { prefix: "/api/v1" });

  const servesWeb = existsSync(join(config.webDistPath, "index.html"));
  if (servesWeb) {
    await app.register(fastifyStatic, { root: config.webDistPath, wildcard: false });
  }
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/api/")) return sendError(reply, 404, "NOT_FOUND", "接口不存在");
    if (servesWeb) return reply.sendFile("index.html");
    return sendError(reply, 404, "NOT_FOUND", "资源不存在");
  });

  app.addHook("preClose", async () => {
    for (const stream of eventStreams) stream.end();
    eventStreams.clear();
    smtp.stop();
  });

  app.addHook("onClose", async () => {
    await imap.stop();
    if (ownsDatabase) db.close();
  });

  imap.start();
  return app;
}

async function readSendUpload(request: FastifyRequest, maximumBytes: number): Promise<{ message: string; attachments: OutgoingAttachment[]; tempDir: string }> {
  if (!request.isMultipart()) throw new InputError("发信请求必须使用 multipart/form-data");
  const tempDir = await mkdtemp(join(tmpdir(), "email2api-send-"));
  const attachments: OutgoingAttachment[] = [];
  let message = "";
  let totalBytes = 0;
  try {
    for await (const part of request.parts({
      limits: { fieldSize: 1024 * 1024 + 64 * 1024, fields: 1, fileSize: maximumBytes, files: 20, parts: 21 }
    })) {
      if (part.type === "field") {
        if (part.fieldname !== "message" || typeof part.value !== "string" || message) throw new InputError("发信参数字段无效");
        if (part.valueTruncated) throw new InputError("邮件参数超过大小限制");
        message = part.value;
        continue;
      }
      if (part.fieldname !== "attachments") throw new InputError("附件字段无效");
      const path = join(tempDir, randomUUID());
      await pipeline(part.file, createWriteStream(path, { flags: "wx" }));
      if (part.file.truncated) throw new HttpError(413, "ATTACHMENT_TOO_LARGE", "附件超过系统设置的大小上限");
      const size = (await stat(path)).size;
      totalBytes += size;
      if (totalBytes > maximumBytes) throw new HttpError(413, "ATTACHMENT_TOTAL_TOO_LARGE", "附件总大小超过系统设置的大小上限");
      attachments.push({ path, filename: safeUploadFilename(part.filename), contentType: safeUploadContentType(part.mimetype) });
    }
    if (!message) throw new InputError("缺少邮件参数");
    return { message, attachments, tempDir };
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true });
    throw error;
  }
}

function safeUploadFilename(filename: string): string {
  const safe = filename.replace(/[\u0000-\u001f\u007f/\\]/gu, "_").trim() || "attachment";
  return [...safe].slice(0, 255).join("");
}

function safeUploadContentType(value: string): string {
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/iu.test(value) ? value.toLowerCase() : "application/octet-stream";
}

function attachmentContentDisposition(filename: string): string {
  const safeFilename = filename.replace(/[\u0000-\u001f\u007f/\\]/g, "_").trim() || "attachment";
  const normalized = [...safeFilename].slice(0, 255).join("");
  const fallback = normalized.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const encoded = encodeURIComponent(normalized).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
