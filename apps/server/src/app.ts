import { existsSync } from "node:fs";
import { join } from "node:path";
import { timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import fastifyStatic from "@fastify/static";
import { z, ZodError } from "zod";
import { AppDatabase } from "./database.js";
import { ImapService } from "./imap.js";
import { EventBroker, type PublishedEvent } from "./events.js";
import { AccountNotFoundError, HttpError, InputError, MessageNotFoundError } from "./errors.js";
import type { AppConfig } from "./config.js";

const providerSchema = z.enum(["auto", "qq", "gmail", "icloud", "outlook", "qq-enterprise", "163", "custom"]);
const imapSchema = z.object({
  provider: providerSchema.default("auto"),
  host: z.string().trim().max(255).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  secure: z.boolean().optional()
}).optional();
const aliasesSchema = z.array(z.string().trim().pipe(z.email().max(320)).transform((value) => value.toLowerCase())).max(50).optional();
const accountCreateSchema = z.object({
  email: z.email().max(320),
  password: z.string().min(1).max(4096),
  aliases: aliasesSchema,
  imap: imapSchema
});
const accountUpdateSchema = z.object({
  email: z.email().max(320).optional(),
  password: z.string().min(1).max(4096).optional(),
  aliases: aliasesSchema,
  imap: imapSchema
}).refine((value) => Object.keys(value).length > 0, "至少提供一个修改字段");
const accountOrderSchema = z.object({
  accountIds: z.array(z.uuid()).max(1000)
}).refine((value) => new Set(value.accountIds).size === value.accountIds.length, "账号排序不能包含重复项");
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
  limit: z.coerce.number().int().min(1).max(100).default(50)
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
  events?: EventBroker;
  eventHeartbeatMs?: number;
}

export async function buildApp(config: AppConfig, dependencies: AppDependencies = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });
  const ownsDatabase = !dependencies.db;
  const db = dependencies.db ?? new AppDatabase(config.databasePath, config.token, config.initialPollIntervalSeconds);
  const events = dependencies.events ?? new EventBroker();
  const imap = dependencies.imap ?? new ImapService(db, events);
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
    request.log.error({ err: error }, "Unhandled API error");
    return sendError(reply, 500, "INTERNAL_ERROR", "服务器内部错误");
  });

  app.get("/healthz", async () => ({ status: "ok" }));

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
      const account = db.updateAccount(request.params.id, accountUpdateSchema.parse(request.body));
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
      await imap.restartAccount(account.id);
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
    api.post<{ Params: { id: string } }>("/accounts/:id/sync", async (request, reply) => {
      return reply.code(202).send(imap.triggerSync(request.params.id));
    });

    api.get("/messages", async (request, reply) => {
      return db.listMessages(messageListSchema.parse(request.query));
    });
    api.get<{ Params: { id: string } }>("/messages/:id", async (request, reply) => {
      return db.getMessage(request.params.id) ?? sendError(reply, 404, "MESSAGE_NOT_FOUND", "邮件不存在");
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
        pollIntervalSeconds: z.number().int().min(5).max(3600).optional()
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
  });

  app.addHook("onClose", async () => {
    await imap.stop();
    if (ownsDatabase) db.close();
  });

  imap.start();
  return app;
}
