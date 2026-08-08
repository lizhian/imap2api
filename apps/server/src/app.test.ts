import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "./app.js";
import type { AppConfig } from "./config.js";
import { EventBroker } from "./events.js";
import { ImapService } from "./imap.js";
import { AppDatabase } from "./database.js";

const dirs: string[] = [];
const token = "api-test-token-that-is-at-least-32-characters";

function config(): AppConfig {
  const dir = mkdtempSync(join(tmpdir(), "imap2api-api-")); dirs.push(dir);
  return { token, dataDir: dir, databasePath: join(dir, "api.db"), host: "127.0.0.1", port: 0, initialPollIntervalSeconds: 10, webDistPath: join(dir, "missing") };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("HTTP API", () => {
  it("protects API routes and never returns credentials", async () => {
    const app = await buildApp(config());
    expect((await app.inject({ method: "GET", url: "/api/v1/accounts" })).statusCode).toBe(401);
    const created = await app.inject({
      method: "POST", url: "/api/v1/accounts",
      headers: { authorization: `Bearer ${token}` },
      payload: { email: "api@gmail.com", aliases: [" Alias@Gmail.com "], password: "top-secret" }
    });
    expect(created.statusCode).toBe(201);
    expect(created.body).not.toContain("top-secret");
    expect(created.json()).toMatchObject({ email: "api@gmail.com", aliases: ["alias@gmail.com"], hasCredential: true, messageCount: 0, unreadCount: 0 });
    const second = await app.inject({
      method: "POST", url: "/api/v1/accounts", headers: { authorization: `Bearer ${token}` },
      payload: { email: "second@gmail.com", password: "top-secret" }
    });
    const ordered = await app.inject({
      method: "PUT", url: "/api/v1/accounts/order", headers: { authorization: `Bearer ${token}` },
      payload: { accountIds: [second.json().id, created.json().id] }
    });
    expect(ordered.statusCode).toBe(200);
    expect(ordered.json().map((account: { id: string }) => account.id)).toEqual([second.json().id, created.json().id]);
    const invalidAlias = await app.inject({
      method: "POST", url: "/api/v1/accounts", headers: { authorization: `Bearer ${token}` },
      payload: { email: "other@gmail.com", aliases: ["other@gmail.com"], password: "top-secret" }
    });
    expect(invalidAlias.statusCode).toBe(400);
    expect(invalidAlias.json()).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
    await app.close();
  });

  it("validates settings and exposes an unauthenticated health check", async () => {
    const applySettings = vi.spyOn(ImapService.prototype, "applySettings");
    const app = await buildApp(config());
    expect((await app.inject({ method: "GET", url: "/healthz" })).json()).toEqual({ status: "ok" });
    const response = await app.inject({ method: "PATCH", url: "/api/v1/settings", headers: { authorization: `Bearer ${token}` }, payload: { maxMessagesPerAccount: 0 } });
    expect(response.statusCode).toBe(400);
    const invalidPageSize = await app.inject({ method: "PATCH", url: "/api/v1/settings", headers: { authorization: `Bearer ${token}` }, payload: { pageSize: 101 } });
    expect(invalidPageSize.statusCode).toBe(400);
    const updated = await app.inject({ method: "PATCH", url: "/api/v1/settings", headers: { authorization: `Bearer ${token}` }, payload: { pollIntervalSeconds: 25 } });
    expect(updated.json()).toEqual({ maxMessagesPerAccount: 100, pollIntervalSeconds: 25, pageSize: 100 });
    expect(applySettings).toHaveBeenCalledWith(10);
    await app.close();
  });

  it("authenticates SSE, filters events by account, and cleans up disconnected subscribers", async () => {
    const events = new EventBroker();
    const app = await buildApp(config(), { events, eventHeartbeatMs: 10 });
    expect((await app.inject({ method: "GET", url: "/api/v1/events" })).statusCode).toBe(401);

    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const accountId = "11111111-1111-4111-8111-111111111111";
    const otherAccountId = "22222222-2222-4222-8222-222222222222";
    const controller = new AbortController();
    const response = await fetch(`${address}/api/v1/events?accountId=${accountId}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: controller.signal
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let stream = "";
    const readUntil = async (value: string) => {
      while (!stream.includes(value)) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error(`SSE stream ended before ${value}`);
        stream += decoder.decode(chunk.value, { stream: true });
      }
    };
    await readUntil("event: ready");
    await readUntil(": ping");
    expect(events.subscriberCount).toBe(1);

    events.publish({
      type: "messages.changed", accountId: otherAccountId, folder: "inbox",
      addedIds: ["ignored"], updatedIds: [], deletedIds: [], occurredAt: new Date().toISOString()
    });
    events.publish({
      type: "messages.changed", accountId, folder: "junk",
      addedIds: ["message-1"], updatedIds: [], deletedIds: [], occurredAt: new Date().toISOString()
    });
    await readUntil("message-1");
    expect(stream).toContain("event: messages.changed");
    expect(stream).not.toContain("ignored");

    await app.close();
    const end = await reader.read();
    expect(end.done).toBe(true);
    await vi.waitFor(() => expect(events.subscriberCount).toBe(0));
  });

  it("reclassifies cached messages and publishes metadata when aliases change", async () => {
    const appConfig = config();
    const db = new AppDatabase(appConfig.databasePath, token);
    const account = db.createAccount({ email: "main@gmail.com", password: "secret" });
    db.upsertMessage({
      accountId: account.id, folder: "inbox", mailboxPath: "INBOX", uid: 1, uidValidity: "1", read: false,
      displayTime: "2026-01-01T00:00:00.000Z",
      content: { subject: "Alias", from: [], to: [{ address: "alias@gmail.com" }], cc: [], preview: "", text: "", html: null, attachments: [], labels: ["forwarded"] }
    });
    const messageId = db.listMessages({ accountId: account.id, view: "all", limit: 50 }).items[0]!.id;
    const events = new EventBroker();
    const publish = vi.spyOn(events, "publish");
    const imap = new ImapService(db, events);
    vi.spyOn(imap, "start").mockImplementation(() => undefined);
    vi.spyOn(imap, "restartAccount").mockResolvedValue(undefined);
    const app = await buildApp(appConfig, { db, imap, events });

    const response = await app.inject({
      method: "PATCH", url: `/api/v1/accounts/${account.id}`,
      headers: { authorization: `Bearer ${token}` }, payload: { aliases: ["alias@gmail.com"] }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ aliases: ["alias@gmail.com"] });
    expect(db.listMessages({ accountId: account.id, view: "all", limit: 50 }).items[0]!.labels).toEqual([]);
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({
      type: "messages.changed", accountId: account.id, folder: "inbox", updatedIds: [messageId]
    }));

    await app.close();
    db.close();
  });

  it("uses consistent status codes for missing resources, partial updates, and internal failures", async () => {
    const appConfig = config();
    const db = new AppDatabase(appConfig.databasePath, token);
    const imap = new ImapService(db);
    const readAll = vi.spyOn(imap, "markAllRead").mockResolvedValue({ count: 2, failedFolders: ["junk"] });
    const app = await buildApp(appConfig, { db, imap });
    const headers = { authorization: `Bearer ${token}` };

    expect((await app.inject({ method: "POST", url: "/api/v1/accounts/11111111-1111-4111-8111-111111111111/test", headers })).statusCode).toBe(404);
    expect((await app.inject({ method: "PATCH", url: "/api/v1/messages/11111111-1111-4111-8111-111111111111/read", headers, payload: { read: true } })).statusCode).toBe(404);
    const partial = await app.inject({ method: "POST", url: "/api/v1/accounts/11111111-1111-4111-8111-111111111111/messages/read-all", headers });
    expect(partial.statusCode).toBe(207);
    expect(partial.json()).toEqual({ count: 2, failedFolders: ["junk"] });
    expect(readAll).toHaveBeenCalledOnce();

    const malformed = await app.inject({
      method: "POST",
      url: "/api/v1/accounts",
      headers: { ...headers, "content-type": "application/json" },
      payload: "{"
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toEqual({ error: { code: "VALIDATION_ERROR", message: "请求参数无效" } });

    const unknown = await app.inject({ method: "GET", url: "/api/v1/unknown", headers });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toEqual({ error: { code: "NOT_FOUND", message: "接口不存在" } });

    vi.spyOn(db, "listAccounts").mockImplementation(() => { throw new Error("database details"); });
    const internal = await app.inject({ method: "GET", url: "/api/v1/accounts", headers });
    expect(internal.statusCode).toBe(500);
    expect(internal.json()).toEqual({ error: { code: "INTERNAL_ERROR", message: "服务器内部错误" } });
    expect(internal.body).not.toContain("database details");

    await app.close();
    db.close();
  });

  it("returns conflict and IMAP gateway errors with the shared error shape", async () => {
    const appConfig = config();
    const db = new AppDatabase(appConfig.databasePath, token);
    const account = db.createAccount({ email: "duplicate@qq.com", password: "secret" });
    const imap = new ImapService(db);
    vi.spyOn(imap, "start").mockImplementation(() => undefined);
    vi.spyOn(imap, "test").mockRejectedValue(new Error("connection refused"));
    const app = await buildApp(appConfig, { db, imap });
    const headers = { authorization: `Bearer ${token}` };

    const duplicate = await app.inject({
      method: "POST",
      url: "/api/v1/accounts",
      headers,
      payload: { email: "duplicate@qq.com", password: "other-secret" }
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toEqual({ error: { code: "ACCOUNT_EXISTS", message: "该邮箱账号已存在" } });

    const connection = await app.inject({ method: "POST", url: `/api/v1/accounts/${account.id}/test`, headers });
    expect(connection.statusCode).toBe(502);
    expect(connection.json()).toMatchObject({ error: { code: "IMAP_CONNECTION_FAILED" } });

    await app.close();
    db.close();
  });

  it("lists and validates per-account synchronization folders", async () => {
    const appConfig = config();
    const db = new AppDatabase(appConfig.databasePath, token);
    const account = db.createAccount({ email: "folders@qq.com", password: "secret" });
    const imap = new ImapService(db);
    vi.spyOn(imap, "start").mockImplementation(() => undefined);
    const list = vi.spyOn(imap, "listMailboxes").mockResolvedValue({ items: [{
      path: "INBOX", name: "INBOX", depth: 0, kind: "inbox", selectable: false,
      available: true, selectedMode: null, cachedMessageCount: 0
    }] });
    const update = vi.spyOn(imap, "updateSyncFolders").mockResolvedValue({ ...account, syncFolderCount: 1 });
    const app = await buildApp(appConfig, { db, imap });
    const headers = { authorization: `Bearer ${token}` };

    const listed = await app.inject({ method: "GET", url: `/api/v1/accounts/${account.id}/mailboxes`, headers });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().items[0]).toMatchObject({ path: "INBOX", selectable: false });
    expect(list).toHaveBeenCalledWith(account.id);

    const invalid = await app.inject({
      method: "PUT", url: `/api/v1/accounts/${account.id}/sync-folders`, headers,
      payload: { folders: Array.from({ length: 6 }, (_, index) => ({ path: `Folder-${index}`, mode: "idle" })) }
    });
    expect(invalid.statusCode).toBe(400);
    expect(update).not.toHaveBeenCalled();

    const saved = await app.inject({
      method: "PUT", url: `/api/v1/accounts/${account.id}/sync-folders`, headers,
      payload: { folders: [{ path: "Forwarded", mode: "polling" }] }
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ syncFolderCount: 1 });
    expect(update).toHaveBeenCalledWith(account.id, [{ path: "Forwarded", mode: "polling" }]);

    await app.close();
    db.close();
  });
});
