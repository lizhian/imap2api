import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { MessageDetail } from "@imap2api/shared";
import { App, buildMessageSrcDoc, formatRelativeDate, hasRemoteImageReferences, MessageDetailView } from "./App";

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
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const json = async () => url.endsWith("/accounts") ? [{
        id: "11111111-1111-4111-8111-111111111111", email: "mail@qq.com", aliases: ["alias@qq.com"], provider: "qq",
        imap: { host: "imap.qq.com", port: 993, secure: true }, hasCredential: true,
        status: "connected", syncMode: "idle", messageCount: 18, unreadCount: 3, lastSyncedAt: "2026-08-07T00:00:00.000Z",
        lastError: null, createdAt: "2026-08-07T00:00:00.000Z", updatedAt: "2026-08-07T00:00:00.000Z"
      }] : url.endsWith("/settings") ? { maxMessagesPerAccount: 100, pollIntervalSeconds: 10 } : { ok: true };
      return { ok: true, status: 200, body: null, json } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    expect(await screen.findByText("IDLE 实时")).toBeInTheDocument();
    expect(screen.getByText("本地缓存").nextElementSibling).toHaveTextContent("18 封 · 3 未读");
    expect(screen.getByText("最近同步").nextElementSibling).toHaveTextContent(/前$/);
    expect(screen.getByText(/1 个别名/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "编辑账号" }));
    expect(await screen.findByRole("dialog", { name: "编辑邮箱" })).not.toHaveClass("modal-box");
    fireEvent.change(await screen.findByLabelText("别名邮箱"), { target: { value: "second@qq.com" } });
    fireEvent.click(screen.getByRole("button", { name: "添加别名" }));
    fireEvent.click(screen.getByRole("button", { name: "移除别名 alias@qq.com" }));
    fireEvent.click(screen.getByRole("button", { name: "保存账号" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringMatching(/\/accounts\//), expect.objectContaining({
      method: "PATCH", body: expect.stringContaining('"aliases":["second@qq.com"]')
    })));
  });

  it("uses sidebar account tabs to filter the message list", async () => {
    sessionStorage.setItem("imap2api-token", "valid-token");
    const account = {
      id: "account-1", email: "operations@example.com", aliases: [], provider: "gmail",
      imap: { host: "imap.gmail.com", port: 993, secure: true }, hasCredential: true,
      status: "connected", syncMode: "idle", messageCount: 12, unreadCount: 7, lastSyncedAt: "2026-08-07T00:00:00.000Z",
      lastError: null, createdAt: "2026-08-07T00:00:00.000Z", updatedAt: "2026-08-07T00:00:00.000Z"
    };
    const eventStream = new ReadableStream<Uint8Array>({ start() {} });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/events")) return { ok: true, status: 200, body: eventStream } as Response;
      const json = async () => url.endsWith("/accounts")
        ? [account]
        : url.includes("/messages?") ? { items: [], nextCursor: null }
          : { ok: true };
      return { ok: true, status: 200, body: null, json } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    expect(await screen.findByRole("tab", { name: /聚合收件箱/ })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: /全部邮箱/ })).not.toBeInTheDocument();
    const accountTab = await screen.findByRole("tab", { name: /operations@example\.com/ });
    fireEvent.click(accountTab);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/messages?view=all&limit=50&accountId=account-1"),
      expect.any(Object)
    ));
    expect(accountTab).toHaveAttribute("aria-selected", "true");
    expect(accountTab).toHaveAccessibleName(/7 封未读/);
    const sidebarSeparator = screen.getByRole("separator", { name: "调整邮箱栏宽度" });
    expect(sidebarSeparator).toHaveAttribute("aria-valuenow", "248");
    fireEvent.keyDown(sidebarSeparator, { key: "ArrowRight" });
    await waitFor(() => expect(sidebarSeparator).toHaveAttribute("aria-valuenow", "256"));
  });

  it("reorders accounts from the drag handle keyboard controls", async () => {
    location.hash = "accounts";
    sessionStorage.setItem("imap2api-token", "valid-token");
    let accounts = [
      {
        id: "11111111-1111-4111-8111-111111111111", email: "first@example.com", aliases: [], provider: "gmail",
        imap: { host: "imap.gmail.com", port: 993, secure: true }, hasCredential: true,
        status: "connected", syncMode: "idle", messageCount: 0, unreadCount: 0, lastSyncedAt: null, lastError: null,
        createdAt: "2026-08-07T00:00:00.000Z", updatedAt: "2026-08-07T00:00:00.000Z"
      },
      {
        id: "22222222-2222-4222-8222-222222222222", email: "second@example.com", aliases: [], provider: "gmail",
        imap: { host: "imap.gmail.com", port: 993, secure: true }, hasCredential: true,
        status: "connected", syncMode: "idle", messageCount: 0, unreadCount: 0, lastSyncedAt: null, lastError: null,
        createdAt: "2026-08-07T00:01:00.000Z", updatedAt: "2026-08-07T00:01:00.000Z"
      }
    ];
    const eventStream = new ReadableStream<Uint8Array>({ start() {} });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/events")) return { ok: true, status: 200, body: eventStream } as Response;
      if (url.endsWith("/accounts/order") && init?.method === "PUT") {
        const accountIds = (JSON.parse(String(init.body)) as { accountIds: string[] }).accountIds;
        accounts = accountIds.map((id) => accounts.find((account) => account.id === id)!);
        return { ok: true, status: 200, body: null, json: async () => accounts } as Response;
      }
      const json = async () => url.endsWith("/accounts") ? accounts
        : url.endsWith("/settings") ? { maxMessagesPerAccount: 100, pollIntervalSeconds: 10 }
          : { ok: true };
      return { ok: true, status: 200, body: null, json } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    const firstHandle = await screen.findByRole("button", { name: "拖动排序 first@example.com" });
    fireEvent.keyDown(firstHandle, { key: "ArrowDown" });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/v1/accounts/order", expect.objectContaining({
      method: "PUT",
      body: JSON.stringify({ accountIds: ["22222222-2222-4222-8222-222222222222", "11111111-1111-4111-8111-111111111111"] })
    })));
    await waitFor(() => expect(screen.getAllByRole("article").map((row) => row.textContent)).toEqual([
      expect.stringContaining("second@example.com"), expect.stringContaining("first@example.com")
    ]));
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

describe("relative message time", () => {
  const now = new Date("2026-08-07T12:00:00.000Z").getTime();

  it.each([
    [1_000, "1秒前"],
    [60_000, "1分前"],
    [60 * 60_000, "1小时前"],
    [24 * 60 * 60_000, "1天前"],
    [30 * 24 * 60 * 60_000, "1月前"],
    [365 * 24 * 60 * 60_000, "1年前"]
  ])("formats %i milliseconds ago", (elapsed, expected) => {
    expect(formatRelativeDate(new Date(now - elapsed).toISOString(), now)).toBe(expected);
  });
});

describe("mail body isolation", () => {
  it("allows only inline styles and localized images without overriding message typography", () => {
    const html = '<p style="font:20px serif">Hello</p><img data-remote-src="https://images.example.test/a.png"><a href="https://example.test/path" target="_blank">Link</a>';
    const srcDoc = buildMessageSrcDoc(html);
    const loadedSrcDoc = buildMessageSrcDoc(html, true);

    expect(srcDoc).toContain("default-src 'none'");
    expect(srcDoc).toContain("style-src 'unsafe-inline'");
    expect(srcDoc).toContain("img-src data:");
    expect(srcDoc).not.toMatch(/<img[^>]*\ssrc="https:\/\/images\.example\.test\/a\.png"/);
    expect(srcDoc).toContain("connect-src 'none'");
    expect(srcDoc).toContain("form-action 'none'");
    expect(srcDoc).toContain('meta name="referrer" content="no-referrer"');
    expect(srcDoc).toContain('data-safe-href="https://example.test/path"');
    expect(srcDoc).toMatch(/<a[^>]*\shref="#"/);
    expect(srcDoc).not.toMatch(/<a[^>]*\shref="https:/);
    expect(srcDoc).not.toMatch(/<a[^>]*\starget=/);
    expect(loadedSrcDoc).toContain("img-src data: http: https:");
    expect(loadedSrcDoc).toMatch(/<img[^>]*\ssrc="https:\/\/images\.example\.test\/a\.png"/);
    expect(srcDoc).not.toContain("PingFang SC");
    expect(srcDoc).not.toContain("border-collapse:collapse");
  });

  it("detects remote images in CSS", () => {
    const html = '<div style="background:url(https://images.example.test/bg.png)"></div>';
    expect(hasRemoteImageReferences(html)).toBe(true);
  });

  it("loads images only for the selected message and confirms body links", async () => {
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const message: MessageDetail = {
      id: "message-1", accountId: "account-1", accountEmail: "mail@example.test", subject: "Styled",
      from: [{ address: "sender@example.test" }], to: [{ address: "mail@example.test" }], cc: [], preview: "", displayTime: "2026-01-01T00:00:00.000Z",
      folder: "inbox", read: false, hasAttachments: false, attachments: [], labels: [], verificationCode: null, unsubscribeUrl: null, text: "",
      html: '<img data-remote-src="https://images.example.test/a.png"><a data-safe-href="https://example.test/path">Example link</a>'
    };
    const view = render(<MessageDetailView message={message} onBack={vi.fn()} onMark={vi.fn()} />);

    expect(screen.queryByText("收件箱")).not.toBeInTheDocument();
    const frame = screen.getByTitle("邮件正文") as HTMLIFrameElement;
    expect(frame.getAttribute("sandbox")).toBe("allow-same-origin");
    frame.contentDocument!.body.innerHTML = '<a href="#" data-safe-href="https://example.test/path">Example link</a>';
    fireEvent.load(frame);
    fireEvent.click(frame.contentDocument!.querySelector("a")!);
    expect(await screen.findByText('确认打开“Example link”？')).toBeInTheDocument();
    expect(screen.getByText("https://example.test/path")).toBeInTheDocument();
    expect(open).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(open).not.toHaveBeenCalled();

    fireEvent.click(frame.contentDocument!.querySelector("a")!);
    fireEvent.click(await screen.findByRole("button", { name: "打开链接" }));
    expect(open).toHaveBeenCalledWith("https://example.test/path", "_blank", "noopener,noreferrer");

    fireEvent.click(screen.getByRole("button", { name: "加载图片" }));
    await waitFor(() => expect(frame.srcdoc).toContain("img-src data: http: https:"));

    view.rerender(<MessageDetailView message={{ ...message, id: "message-2" }} onBack={vi.fn()} onMark={vi.fn()} />);
    expect(screen.getByRole("button", { name: "加载图片" })).toBeEnabled();
    expect((screen.getByTitle("邮件正文") as HTMLIFrameElement).srcdoc).toContain("img-src data:;");
  });

  it("shows labels, copies verification codes, and confirms unsubscribe links", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const message: MessageDetail = {
      id: "message-actions", accountId: "account-1", accountEmail: "mail@example.test", subject: "Code",
      from: [{ address: "sender@example.test" }], to: [{ address: "mail@example.test" }], cc: [], preview: "",
      displayTime: "2026-01-01T00:00:00.000Z", folder: "inbox", read: false, hasAttachments: false,
      attachments: [], text: "验证码 123456", html: null,
      labels: ["forwarded", "verification_code", "unsubscribe"], verificationCode: "123456", unsubscribeUrl: "https://example.test/unsubscribe"
    };
    const view = render(<MessageDetailView message={message} onBack={vi.fn()} onMark={vi.fn()} />);

    expect(screen.getByText("转发")).toBeInTheDocument();
    expect(screen.getByText("验证码")).toBeInTheDocument();
    expect(screen.getByText("可退订")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "复制 123456" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("123456"));
    expect(screen.getByRole("status")).toHaveTextContent("验证码已复制");

    fireEvent.click(screen.getByRole("button", { name: "快速退订" }));
    expect(await screen.findByText("确认前往 example.test 退订？")).toBeInTheDocument();
    expect(screen.getByRole("alertdialog")).not.toHaveClass("modal-box");
    expect(open).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "打开退订链接" }));
    expect(open).toHaveBeenCalledWith("https://example.test/unsubscribe", "_blank", "noopener,noreferrer");

    view.rerender(<MessageDetailView message={{ ...message, id: "message-actions-2" }} onBack={vi.fn()} onMark={vi.fn()} />);
    expect(screen.getByRole("button", { name: "复制 123456" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("");

    writeText.mockRejectedValueOnce(new Error("clipboard denied"));
    fireEvent.click(screen.getByRole("button", { name: "复制 123456" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("验证码复制失败"));

    view.rerender(<MessageDetailView message={{ ...message, id: "message-actions-3", unsubscribeUrl: "javascript:alert(1)" }} onBack={vi.fn()} onMark={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "快速退订" })).not.toBeInTheDocument();
  });
});
