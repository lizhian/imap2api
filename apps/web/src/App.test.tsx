import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App } from "./App";

afterEach(() => { cleanup(); sessionStorage.clear(); location.hash = ""; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("App authentication", () => {
  it("keeps the token in session storage after verification", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) }));
    render(<App />);
    fireEvent.change(screen.getByLabelText("访问 Token"), { target: { value: "valid-token" } });
    fireEvent.click(screen.getByRole("button", { name: "进入管理" }));
    await waitFor(() => expect(sessionStorage.getItem("imap2api-token")).toBe("valid-token"));
  });

  it("shows a local error for an invalid token", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({ error: { message: "Token 无效" } }) }));
    render(<App />);
    fireEvent.change(screen.getByLabelText("访问 Token"), { target: { value: "wrong" } });
    fireEvent.click(screen.getByRole("button", { name: "进入管理" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Token 无效");
  });

  it("shows the persistent connection mode for an account", async () => {
    location.hash = "accounts";
    sessionStorage.setItem("imap2api-token", "valid-token");
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const json = async () => url.endsWith("/accounts") ? [{
        id: "11111111-1111-4111-8111-111111111111", email: "mail@qq.com", provider: "qq",
        imap: { host: "imap.qq.com", port: 993, secure: true }, hasCredential: true,
        status: "connected", syncMode: "idle", lastSyncedAt: "2026-08-07T00:00:00.000Z",
        lastError: null, createdAt: "2026-08-07T00:00:00.000Z", updatedAt: "2026-08-07T00:00:00.000Z"
      }] : url.endsWith("/settings") ? { maxMessagesPerAccount: 100, pollIntervalSeconds: 10 } : { ok: true };
      return { ok: true, status: 200, body: null, json } as Response;
    }));

    render(<App />);
    expect(await screen.findByText("IDLE 实时")).toBeInTheDocument();
  });

  it("loads and saves both global synchronization settings", async () => {
    location.hash = "settings";
    sessionStorage.setItem("imap2api-token", "valid-token");
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/settings") && init?.method === "PATCH") {
        return { ok: true, status: 200, body: null, json: async () => JSON.parse(String(init.body)) } as Response;
      }
      const json = async () => url.endsWith("/settings")
        ? { maxMessagesPerAccount: 100, pollIntervalSeconds: 10 }
        : url.endsWith("/accounts") ? [] : { ok: true };
      return { ok: true, status: 200, body: null, json } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    const max = await screen.findByLabelText("每个账号最多保留");
    const interval = screen.getByLabelText("无 IDLE 时轮询间隔");
    fireEvent.change(max, { target: { value: "80" } });
    fireEvent.change(interval, { target: { value: "25" } });
    fireEvent.click(screen.getByRole("button", { name: "保存设置" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/v1/settings", expect.objectContaining({
      method: "PATCH", body: JSON.stringify({ maxMessagesPerAccount: 80, pollIntervalSeconds: 25 })
    })));
  });
});
