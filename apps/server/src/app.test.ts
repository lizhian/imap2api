import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "./app.js";
import type { AppConfig } from "./config.js";

const dirs: string[] = [];
const token = "api-test-token-that-is-at-least-32-characters";

function config(): AppConfig {
  const dir = mkdtempSync(join(tmpdir(), "imap2api-api-")); dirs.push(dir);
  return { token, dataDir: dir, databasePath: join(dir, "api.db"), host: "127.0.0.1", port: 0, syncIntervalMs: 60_000, webDistPath: join(dir, "missing") };
}

afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("HTTP API", () => {
  it("protects API routes and never returns credentials", async () => {
    const app = await buildApp(config());
    expect((await app.inject({ method: "GET", url: "/api/v1/accounts" })).statusCode).toBe(401);
    const created = await app.inject({
      method: "POST", url: "/api/v1/accounts",
      headers: { authorization: `Bearer ${token}` },
      payload: { email: "api@gmail.com", password: "top-secret" }
    });
    expect(created.statusCode).toBe(201);
    expect(created.body).not.toContain("top-secret");
    expect(created.json()).toMatchObject({ email: "api@gmail.com", hasCredential: true });
    await app.close();
  });

  it("validates settings and exposes an unauthenticated health check", async () => {
    const app = await buildApp(config());
    expect((await app.inject({ method: "GET", url: "/healthz" })).json()).toEqual({ status: "ok" });
    const response = await app.inject({ method: "PATCH", url: "/api/v1/settings", headers: { authorization: `Bearer ${token}` }, payload: { maxMessagesPerAccount: 0 } });
    expect(response.statusCode).toBe(400);
    await app.close();
  });
});
