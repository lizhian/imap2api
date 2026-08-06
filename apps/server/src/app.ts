import { existsSync } from "node:fs";
import { join } from "node:path";
import { timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import fastifyStatic from "@fastify/static";
import { z, ZodError } from "zod";
import { AppDatabase } from "./database.js";
import { ImapService } from "./imap.js";
import type { AppConfig } from "./config.js";

const providerSchema = z.enum(["auto", "qq", "gmail", "icloud", "outlook", "qq-enterprise", "163", "custom"]);
const imapSchema = z.object({
  provider: providerSchema.default("auto"),
  host: z.string().trim().max(255).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  secure: z.boolean().optional()
}).optional();
const accountCreateSchema = z.object({
  email: z.email().max(320),
  password: z.string().min(1).max(4096),
  imap: imapSchema
});
const accountUpdateSchema = z.object({
  email: z.email().max(320).optional(),
  password: z.string().min(1).max(4096).optional(),
  imap: imapSchema
}).refine((value) => Object.keys(value).length > 0, "至少提供一个修改字段");
const messageListSchema = z.object({
  accountId: z.string().uuid().optional(),
  view: z.enum(["all", "unread", "junk"]).default("all"),
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
}

export async function buildApp(config: AppConfig, dependencies: AppDependencies = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });
  const ownsDatabase = !dependencies.db;
  const db = dependencies.db ?? new AppDatabase(config.databasePath, config.token);
  const imap = dependencies.imap ?? new ImapService(db, config.syncIntervalMs);

  app.get("/healthz", async () => ({ status: "ok" }));

  await app.register(async (api) => {
    api.addHook("onRequest", async (request, reply) => {
      if (!authorized(request, config.token)) return sendError(reply, 401, "UNAUTHORIZED", "Bearer Token 无效或缺失");
    });

    api.post("/auth/verify", async () => ({ ok: true }));

    api.get("/accounts", async () => db.listAccounts());
    api.post("/accounts", async (request, reply) => {
      try {
        const account = db.createAccount(accountCreateSchema.parse(request.body));
        return reply.code(201).send(account);
      } catch (error) {
        if (error instanceof ZodError) return sendError(reply, 400, "VALIDATION_ERROR", "账号信息无效", error.flatten());
        if (String(error).includes("UNIQUE constraint")) return sendError(reply, 409, "ACCOUNT_EXISTS", "该邮箱账号已存在");
        return sendError(reply, 400, "ACCOUNT_INVALID", error instanceof Error ? error.message : "无法创建账号");
      }
    });
    api.patch<{ Params: { id: string } }>("/accounts/:id", async (request, reply) => {
      try {
        const account = db.updateAccount(request.params.id, accountUpdateSchema.parse(request.body));
        return account ?? sendError(reply, 404, "ACCOUNT_NOT_FOUND", "邮箱账号不存在");
      } catch (error) {
        if (error instanceof ZodError) return sendError(reply, 400, "VALIDATION_ERROR", "账号信息无效", error.flatten());
        if (String(error).includes("UNIQUE constraint")) return sendError(reply, 409, "ACCOUNT_EXISTS", "该邮箱账号已存在");
        return sendError(reply, 400, "ACCOUNT_INVALID", error instanceof Error ? error.message : "无法更新账号");
      }
    });
    api.delete<{ Params: { id: string } }>("/accounts/:id", async (request, reply) => {
      if (!db.deleteAccount(request.params.id)) return sendError(reply, 404, "ACCOUNT_NOT_FOUND", "邮箱账号不存在");
      return reply.code(204).send();
    });
    api.post<{ Params: { id: string } }>("/accounts/:id/test", async (request, reply) => {
      try {
        await imap.test(request.params.id);
        return { ok: true };
      } catch (error) {
        return sendError(reply, 502, "IMAP_CONNECTION_FAILED", error instanceof Error ? error.message : "IMAP 连接失败");
      }
    });
    api.post<{ Params: { id: string } }>("/accounts/:id/sync", async (request, reply) => {
      if (!db.getAccount(request.params.id)) return sendError(reply, 404, "ACCOUNT_NOT_FOUND", "邮箱账号不存在");
      const alreadyRunning = imap.isSyncing(request.params.id);
      if (!alreadyRunning) void imap.sync(request.params.id).catch(() => undefined);
      return reply.code(202).send({ status: alreadyRunning ? "running" : "started" });
    });

    api.get("/messages", async (request, reply) => {
      try {
        return db.listMessages(messageListSchema.parse(request.query));
      } catch (error) {
        return sendError(reply, 400, "INVALID_QUERY", error instanceof Error ? error.message : "查询参数无效");
      }
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
        if (error instanceof ZodError) return sendError(reply, 400, "VALIDATION_ERROR", "read 必须是布尔值");
        if (error instanceof Error && error.message === "邮件不存在") return sendError(reply, 404, "MESSAGE_NOT_FOUND", error.message);
        return sendError(reply, 502, "IMAP_UPDATE_FAILED", error instanceof Error ? error.message : "IMAP 标记失败");
      }
    });
    api.post<{ Params: { id: string } }>("/accounts/:id/messages/read-all", async (request, reply) => {
      try {
        const result = await imap.markAllRead(request.params.id);
        return reply.code(result.failedFolders.length ? 207 : 200).send(result);
      } catch (error) {
        return sendError(reply, 502, "IMAP_UPDATE_FAILED", error instanceof Error ? error.message : "批量标记失败");
      }
    });

    api.get("/settings", async () => db.getSettings());
    api.patch("/settings", async (request, reply) => {
      try {
        const body = z.object({ maxMessagesPerAccount: z.number().int().min(1).max(10000) }).parse(request.body);
        return db.updateSettings(body.maxMessagesPerAccount);
      } catch (error) {
        return sendError(reply, 400, "VALIDATION_ERROR", "邮件缓存上限必须是 1 到 10000 的整数");
      }
    });
  }, { prefix: "/api/v1" });

  if (existsSync(join(config.webDistPath, "index.html"))) {
    await app.register(fastifyStatic, { root: config.webDistPath, wildcard: false });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/")) return sendError(reply, 404, "NOT_FOUND", "接口不存在");
      return reply.sendFile("index.html");
    });
  }

  app.addHook("onClose", async () => {
    imap.stop();
    if (ownsDatabase) db.close();
  });

  imap.start();
  return app;
}
