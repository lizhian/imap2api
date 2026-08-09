import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Account, MessageDetail, MessageSummary } from "@imap2api/shared";
import { App, buildMessageSrcDoc, canShowFullForwardedVia, formatRelativeDate, hasRemoteImageReferences, MessageDetailView, senderAllowsRemoteImages } from "./App";
import { ApiClient } from "./api";

const detailApi = new ApiClient("valid-token");

afterEach(() => { cleanup(); sessionStorage.clear(); localStorage.clear(); location.hash = ""; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

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
        id: "11111111-1111-4111-8111-111111111111", email: "mail@qq.com", aliases: ["alias@qq.com"], provider: "custom",
        imap: { host: "imap.custom.test", port: 993, secure: true }, smtp: { host: "smtp.custom.test", port: 465, secure: true }, hasCredential: true,
        status: "connected", syncMode: "idle", messageCount: 18, unreadCount: 3, lastSyncedAt: "2026-08-07T00:00:00.000Z",
        lastError: null, createdAt: "2026-08-07T00:00:00.000Z", updatedAt: "2026-08-07T00:00:00.000Z"
      }] : url.endsWith("/settings") ? { maxMessagesPerAccount: 100, pollIntervalSeconds: 10, pageSize: 100 } : { ok: true };
      return { ok: true, status: 200, body: null, json } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    expect(await screen.findByText("IDLE 实时")).toBeInTheDocument();
    expect(screen.getByText("本地缓存").nextElementSibling).toHaveTextContent("18封");
    expect(screen.getByText("未读邮件").nextElementSibling).toHaveTextContent("3封");
    expect(screen.getByText("自定义文件夹").nextElementSibling).toHaveTextContent("0个");
    expect(screen.getByText("最近同步").nextElementSibling).toHaveTextContent(/前$/);
    expect(screen.getByText(/1 个别名/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "编辑账号" }));
    expect(await screen.findByRole("dialog", { name: "编辑邮箱" })).not.toHaveClass("modal-box");
    fireEvent.change(await screen.findByLabelText("别名邮箱"), { target: { value: "second@qq.com" } });
    fireEvent.click(screen.getByRole("button", { name: "添加别名" }));
    fireEvent.click(screen.getByRole("button", { name: "移除别名 alias@qq.com" }));
    fireEvent.keyDown(screen.getByRole("combobox", { name: "邮箱服务商" }), { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("option", { name: "Gmail" }));
    fireEvent.click(screen.getByRole("button", { name: "保存账号" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringMatching(/\/accounts\//), expect.objectContaining({
      method: "PATCH", body: expect.stringContaining('"aliases":["second@qq.com"]')
    })));
    const update = fetchMock.mock.calls.find(([, init]) => init?.method === "PATCH")?.[1] as RequestInit;
    expect(JSON.parse(String(update.body))).toMatchObject({ aliases: ["second@qq.com"], imap: { provider: "gmail" } });
    expect(JSON.parse(String(update.body))).not.toHaveProperty("smtp");
  });

  it("uses sidebar account tabs to filter the message list", async () => {
    sessionStorage.setItem("imap2api-token", "valid-token");
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1000);
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
      expect.stringContaining("/messages?view=all&limit=100&accountId=account-1"),
      expect.any(Object)
    ));
    expect(accountTab).toHaveAttribute("aria-selected", "true");
    expect(accountTab).toHaveAccessibleName(/7 封未读/);
    const sidebarSeparator = screen.getByRole("separator", { name: "调整邮箱栏宽度" });
    const messageListSeparator = screen.getByRole("separator", { name: "调整邮件列表宽度" });
    expect(sidebarSeparator).toHaveAttribute("aria-valuenow", "200");
    expect(messageListSeparator).toHaveAttribute("aria-valuenow", "320");
    fireEvent.keyDown(sidebarSeparator, { key: "ArrowRight" });
    fireEvent.keyDown(messageListSeparator, { key: "ArrowRight" });
    await waitFor(() => expect(sidebarSeparator).toHaveAttribute("aria-valuenow", "208"));
    await waitFor(() => expect(messageListSeparator).toHaveAttribute("aria-valuenow", "328"));
    expect(JSON.parse(localStorage.getItem("imap2api-layout-widths") ?? "{}")).toEqual({ sidebar: 208, messageList: 328 });
  });

  it("restores valid column widths and ignores a damaged layout record", async () => {
    sessionStorage.setItem("imap2api-token", "valid-token");
    localStorage.setItem("imap2api-layout-widths", JSON.stringify({ sidebar: 232, messageList: 408 }));
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1000);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/events")) return { ok: true, status: 200, body: new ReadableStream<Uint8Array>({ start() {} }) } as Response;
      const json = async () => url.endsWith("/accounts") ? []
        : url.endsWith("/settings") ? { maxMessagesPerAccount: 100, pollIntervalSeconds: 10, pageSize: 100 }
          : url.includes("/messages?") ? { items: [], nextCursor: null }
            : { ok: true };
      return { ok: true, status: 200, body: null, json } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const mounted = render(<App />);
    expect(await screen.findByRole("separator", { name: "调整邮箱栏宽度" })).toHaveAttribute("aria-valuenow", "232");
    expect(screen.getByRole("separator", { name: "调整邮件列表宽度" })).toHaveAttribute("aria-valuenow", "408");

    mounted.unmount();
    localStorage.setItem("imap2api-layout-widths", "{damaged");
    render(<App />);
    expect(await screen.findByRole("separator", { name: "调整邮箱栏宽度" })).toHaveAttribute("aria-valuenow", "200");
    expect(screen.getByRole("separator", { name: "调整邮件列表宽度" })).toHaveAttribute("aria-valuenow", "320");
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
        : url.endsWith("/settings") ? { maxMessagesPerAccount: 100, pollIntervalSeconds: 10, pageSize: 100 }
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

  it("configures custom folder polling or IDLE and confirms cached folder removal", async () => {
    location.hash = "accounts";
    sessionStorage.setItem("imap2api-token", "valid-token");
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    const account = {
      id: "11111111-1111-4111-8111-111111111111", email: "folders@example.com", aliases: [], provider: "custom",
      imap: { host: "imap.example.com", port: 993, secure: true }, hasCredential: true,
      status: "connected", syncMode: "idle", messageCount: 2, unreadCount: 2, syncFolderCount: 1,
      lastSyncedAt: null, lastError: null, createdAt: "2026-08-07T00:00:00.000Z", updatedAt: "2026-08-07T00:00:00.000Z"
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const json = async () => url.endsWith("/accounts") ? [account]
        : url.endsWith("/settings") ? { maxMessagesPerAccount: 100, pollIntervalSeconds: 10, pageSize: 100 }
          : url.endsWith("/mailboxes") ? { items: [
            { path: "INBOX", name: "INBOX", depth: 0, kind: "inbox", selectable: false, available: true, selectedMode: null, cachedMessageCount: 0 },
            { path: "Relay/Old", name: "Old", depth: 1, kind: "custom", selectable: true, available: true, selectedMode: "polling", cachedMessageCount: 2 },
            { path: "Relay/New", name: "New", depth: 1, kind: "custom", selectable: true, available: true, selectedMode: null, cachedMessageCount: 0 }
          ] } : { ...account, syncFolderCount: 1 };
      return { ok: true, status: 200, body: null, json } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "设置同步文件夹" }));
    const dialog = await screen.findByRole("dialog", { name: "同步文件夹" });
    expect(within(dialog).getByRole("checkbox", { name: /INBOX/ })).toBeDisabled();
    fireEvent.click(within(dialog).getByRole("checkbox", { name: /Old/ }));
    fireEvent.click(within(dialog).getByRole("checkbox", { name: /New/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "IDLE" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "保存配置" }));
    const confirm = await screen.findByRole("alertdialog");
    fireEvent.click(within(confirm).getByRole("button", { name: "移除并保存" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/accounts/11111111-1111-4111-8111-111111111111/sync-folders",
      expect.objectContaining({ method: "PUT", body: JSON.stringify({ folders: [{ path: "Relay/New", mode: "idle" }] }) })
    ));
  });

  it("loads and saves global synchronization and pagination settings", async () => {
    location.hash = "settings";
    sessionStorage.setItem("imap2api-token", "valid-token");
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/settings") && init?.method === "PATCH") {
        return { ok: true, status: 200, body: null, json: async () => JSON.parse(String(init.body)) } as Response;
      }
      const json = async () => url.endsWith("/settings")
        ? { maxMessagesPerAccount: 100, pollIntervalSeconds: 10, pageSize: 100, maxConcurrentDownloads: 3, maxAttachmentSizeMb: 100, remoteImageAllowlist: ["images@example.com"], defaultSenderName: "System Sender" }
        : url.endsWith("/accounts") ? [] : { ok: true };
      return { ok: true, status: 200, body: null, json } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    const max = await screen.findByLabelText("每个账号最多保留");
    const interval = screen.getByLabelText("无 IDLE 时轮询间隔");
    const pageSize = screen.getByLabelText("邮件列表每页显示");
    const maxConcurrentDownloads = screen.getByLabelText("附件并发下载");
    const maxAttachmentSize = screen.getByLabelText("单附件大小上限");
    const remoteImageSender = screen.getByLabelText("自动加载图片发件人");
    const defaultSenderName = screen.getByLabelText("默认发件人名称");
    expect(screen.getByText("images@example.com")).toBeInTheDocument();
    fireEvent.change(max, { target: { value: "80" } });
    fireEvent.change(interval, { target: { value: "25" } });
    fireEvent.change(pageSize, { target: { value: "60" } });
    fireEvent.change(maxConcurrentDownloads, { target: { value: "4" } });
    fireEvent.change(maxAttachmentSize, { target: { value: "200" } });
    fireEvent.change(remoteImageSender, { target: { value: "Trusted@Example.com" } });
    fireEvent.change(defaultSenderName, { target: { value: "Operations" } });
    fireEvent.click(screen.getByRole("button", { name: "移除图片白名单 images@example.com" }));
    fireEvent.click(screen.getByRole("button", { name: "保存设置" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/v1/settings", expect.objectContaining({
      method: "PATCH", body: JSON.stringify({
        maxMessagesPerAccount: 80, pollIntervalSeconds: 25, pageSize: 60, maxConcurrentDownloads: 4, maxAttachmentSizeMb: 200,
        remoteImageAllowlist: ["trusted@example.com"], defaultSenderName: "Operations"
      })
    })));
  });

  it("composes rich mail with an alias and multipart attachments", async () => {
    location.hash = "compose";
    sessionStorage.setItem("imap2api-token", "valid-token");
    const account = {
      id: "11111111-1111-4111-8111-111111111111", email: "sender@gmail.com", aliases: ["alias@gmail.com"], provider: "gmail",
      imap: { host: "imap.gmail.com", port: 993, secure: true }, smtp: { host: "smtp.gmail.com", port: 465, secure: true },
      defaultSenderName: "Account Sender", hasCredential: true, status: "connected", syncMode: "idle", messageCount: 0, unreadCount: 0,
      syncFolderCount: 0, lastSyncedAt: null, lastError: null, createdAt: "2026-08-07T00:00:00.000Z", updatedAt: "2026-08-07T00:00:00.000Z"
    };
    const systemNameAccount = {
      ...account,
      id: "22222222-2222-4222-8222-222222222222", email: "other@gmail.com", aliases: [], defaultSenderName: null
    };
    const eventStream = new ReadableStream<Uint8Array>({ start() {} });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/events")) return { ok: true, status: 200, body: eventStream } as Response;
      if (url.endsWith("/messages/send")) return {
        ok: true, status: 200, body: null, json: async () => ({ messageId: "sent", accepted: ["to@example.com"], rejected: [] })
      } as Response;
      const json = async () => url.endsWith("/accounts") ? [account, systemNameAccount]
        : url.endsWith("/settings") ? { maxMessagesPerAccount: 100, pollIntervalSeconds: 10, pageSize: 100, maxConcurrentDownloads: 3, maxAttachmentSizeMb: 25, remoteImageAllowlist: [], defaultSenderName: "System Sender" }
          : { ok: true };
      return { ok: true, status: 200, body: null, json } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    expect(await screen.findByRole("heading", { name: "写信" })).toBeInTheDocument();
    expect(screen.getByLabelText("发件人名称")).toHaveValue("Account Sender");
    expect(screen.getByRole("group", { name: "发件人" })).toHaveTextContent("Account Sendersender@gmail.com");
    expect(screen.getByLabelText("发件人名称").compareDocumentPosition(screen.getByRole("listbox", { name: "发件人邮箱" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["sender@gmail.com", "alias@gmail.com", "other@gmail.com"]);
    expect(screen.queryByRole("textbox", { name: "抄送" })).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "密送" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "抄送" }));
    fireEvent.click(screen.getByRole("button", { name: "密送" }));
    expect(screen.getByRole("textbox", { name: "抄送" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "密送" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "项目列表" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "项目列表" })).toHaveAttribute("aria-pressed", "true"));
    fireEvent.change(screen.getByLabelText("发件人名称"), { target: { value: "Temporary Sender" } });
    expect(screen.getByRole("group", { name: "发件人" })).toHaveTextContent("Temporary Sendersender@gmail.com");
    fireEvent.click(screen.getByRole("option", { name: "other@gmail.com" }));
    await waitFor(() => expect(screen.getByLabelText("发件人名称")).toHaveValue("System Sender"));
    expect(screen.getByRole("group", { name: "发件人" })).toHaveTextContent("System Senderother@gmail.com");
    fireEvent.click(screen.getByRole("option", { name: "alias@gmail.com" }));
    await waitFor(() => expect(screen.getByLabelText("发件人名称")).toHaveValue("Account Sender"));
    expect(screen.getByRole("group", { name: "发件人" })).toHaveTextContent("Account Senderalias@gmail.com");
    const toInput = screen.getByLabelText("收件人");
    fireEvent.change(toInput, { target: { value: "to@example.com,move@example.com,remove@example.com" } });
    expect(screen.getByRole("listitem", { name: "收件人 to@example.com" })).toBeInTheDocument();
    expect(screen.getByRole("listitem", { name: "收件人 move@example.com" })).toBeInTheDocument();
    fireEvent.blur(toInput);
    expect(screen.getByRole("listitem", { name: "收件人 remove@example.com" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "删除收件人 remove@example.com" }));
    expect(screen.queryByRole("listitem", { name: "收件人 remove@example.com" })).not.toBeInTheDocument();
    const dragData = new Map<string, string>();
    const dataTransfer = {
      effectAllowed: "none", dropEffect: "none",
      getData: (type: string) => dragData.get(type) ?? "",
      setData: (type: string, value: string) => { dragData.set(type, value); }
    } as unknown as DataTransfer;
    fireEvent.dragStart(screen.getByRole("listitem", { name: "收件人 move@example.com" }), { dataTransfer });
    fireEvent.dragOver(screen.getByRole("group", { name: "抄送地址" }), { dataTransfer });
    fireEvent.drop(screen.getByRole("group", { name: "抄送地址" }), { dataTransfer });
    expect(screen.queryByRole("listitem", { name: "收件人 move@example.com" })).not.toBeInTheDocument();
    expect(screen.getByRole("listitem", { name: "抄送 move@example.com" })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "密送" }), { target: { value: "hidden@example.com" } });
    fireEvent.blur(screen.getByRole("textbox", { name: "密送" }));
    fireEvent.click(screen.getByRole("button", { name: "抄送" }));
    fireEvent.click(screen.getByRole("button", { name: "密送" }));
    expect(screen.queryByRole("textbox", { name: "抄送" })).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "密送" })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("主题"), { target: { value: "Report" } });
    const attachment = new File(["pdf"], "report.pdf", { type: "application/pdf" });
    fireEvent.change(document.querySelector('input[type="file"]')!, { target: { files: [attachment] } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/v1/messages/send", expect.objectContaining({ method: "POST", body: expect.any(FormData) })));
    const sendCall = fetchMock.mock.calls.find(([input]) => String(input).endsWith("/messages/send"))!;
    const init = sendCall[1] as RequestInit;
    expect(init.headers).toEqual({ Authorization: "Bearer valid-token" });
    const form = init.body as FormData;
    expect(JSON.parse(String(form.get("message")))).toMatchObject({
      accountId: account.id, fromAddress: "alias@gmail.com", senderName: "Account Sender",
      to: ["to@example.com"], cc: ["move@example.com"], bcc: ["hidden@example.com"], subject: "Report"
    });
    expect((form.getAll("attachments")[0] as File).name).toBe("report.pdf");
  });

  it("shows a retry state when compose settings fail to load", async () => {
    location.hash = "compose";
    sessionStorage.setItem("imap2api-token", "valid-token");
    const account = {
      id: "11111111-1111-4111-8111-111111111111", email: "sender@gmail.com", aliases: [], provider: "gmail",
      imap: { host: "imap.gmail.com", port: 993, secure: true }, smtp: { host: "smtp.gmail.com", port: 465, secure: true },
      defaultSenderName: null, hasCredential: true, status: "connected", syncMode: "idle", messageCount: 0, unreadCount: 0,
      syncFolderCount: 0, lastSyncedAt: null, lastError: null, createdAt: "2026-08-07T00:00:00.000Z", updatedAt: "2026-08-07T00:00:00.000Z"
    };
    const eventStream = new ReadableStream<Uint8Array>({ start() {} });
    let settingsAttempts = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/events")) return { ok: true, status: 200, body: eventStream } as Response;
      if (url.endsWith("/settings") && settingsAttempts++ === 0) return {
        ok: false, status: 503, body: null, json: async () => ({ error: { code: "UNAVAILABLE", message: "设置暂时不可用" } })
      } as Response;
      const json = async () => url.endsWith("/accounts") ? [account]
        : url.endsWith("/settings") ? { maxMessagesPerAccount: 100, pollIntervalSeconds: 10, pageSize: 100, maxConcurrentDownloads: 3, maxAttachmentSizeMb: 25, remoteImageAllowlist: [], defaultSenderName: "" }
          : { ok: true };
      return { ok: true, status: 200, body: null, json } as Response;
    }));

    render(<App />);
    expect(await screen.findByText("写信设置加载失败")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重新加载" }));
    expect(await screen.findByRole("heading", { name: "写信" })).toBeInTheDocument();
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

describe("forwarding mailbox fit", () => {
  it("uses the full address only when the measured remaining width can contain it", () => {
    expect(canShowFullForwardedVia(620, 80, 260)).toBe(true);
    expect(canShowFullForwardedVia(360, 80, 290)).toBe(false);
    expect(canShowFullForwardedVia(620, 420, 360)).toBe(false);
  });
});

describe("message list interactions", () => {
  const account = (id: string, email: string): Account => ({
    id, email, aliases: [], provider: "gmail", imap: { host: "imap.gmail.com", port: 993, secure: true },
    smtp: { host: "smtp.gmail.com", port: 465, secure: true }, defaultSenderName: null,
    hasCredential: true, status: "connected", syncMode: "idle", messageCount: 1, unreadCount: 1, syncFolderCount: 0,
    lastSyncedAt: "2026-08-07T00:00:00.000Z", lastError: null,
    createdAt: "2026-08-07T00:00:00.000Z", updatedAt: "2026-08-07T00:00:00.000Z"
  });
  const summary: MessageSummary = {
    id: "message-1", accountId: "account-1", accountEmail: "first@example.com", subject: "Unread subject",
    from: [{ address: "sender@example.com" }], preview: "Unread preview", displayTime: "2026-08-07T00:00:00.000Z",
    folder: "inbox", read: false, hasAttachments: false, labels: [], forwardedVia: null
  };
  const detail: MessageDetail = {
    ...summary, to: [{ address: "first@example.com" }], cc: [], attachments: [], text: "Message body", html: null,
    verificationCode: null, unsubscribeUrl: null
  };

  it("shows the current page, total pages and filtered message total", async () => {
    sessionStorage.setItem("imap2api-token", "valid-token");
    const eventStream = new ReadableStream<Uint8Array>({ start() {} });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/events")) return { ok: true, status: 200, body: eventStream } as Response;
      const json = async () => url.endsWith("/accounts") ? [account("account-1", "first@example.com")]
        : url.endsWith("/settings") ? { maxMessagesPerAccount: 100, pollIntervalSeconds: 10, pageSize: 100 }
          : url.includes("/messages?") ? { items: [summary], nextCursor: url.includes("cursor=") ? null : "page-2", total: 245 }
            : { ok: true };
      return { ok: true, status: 200, body: null, json } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    expect(await screen.findByText("第 1 / 3 页")).toBeInTheDocument();
    expect(screen.getByText("共 245 封 · 每页 100 封")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    expect(await screen.findByText("第 2 / 3 页")).toBeInTheDocument();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/messages?view=all&limit=100&cursor=page-2", expect.any(Object)
    ));
  });

  it("opens an unread message without refreshing the list and marks it as read", async () => {
    sessionStorage.setItem("imap2api-token", "valid-token");
    let eventController!: ReadableStreamDefaultController<Uint8Array>;
    const eventStream = new ReadableStream<Uint8Array>({ start(controller) { eventController = controller; } });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/events")) return { ok: true, status: 200, body: eventStream } as Response;
      const json = async () => url.endsWith("/accounts") ? [account("account-1", "first@example.com")]
        : url.endsWith("/settings") ? { maxMessagesPerAccount: 100, pollIntervalSeconds: 10, pageSize: 100 }
          : url.includes("/messages?") ? { items: [summary], nextCursor: null }
            : url.endsWith("/messages/message-1") ? detail
              : url.endsWith("/messages/message-1/read") && init?.method === "PATCH" ? { ok: true }
                : { ok: true };
      return { ok: true, status: 200, body: null, json } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    const row = await screen.findByRole("button", { name: /Unread subject/ });
    const initialListRequests = fetchMock.mock.calls.filter(([input]) => String(input).includes("/messages?")).length;
    fireEvent.click(row);

    expect(await screen.findByRole("heading", { name: "Unread subject" })).toBeInTheDocument();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/v1/messages/message-1/read", expect.objectContaining({
      method: "PATCH", body: JSON.stringify({ read: true })
    })));
    await act(async () => {
      eventController.enqueue(new TextEncoder().encode(`event: messages.changed\ndata: ${JSON.stringify({
        accountId: "account-1", folder: "inbox", addedIds: [], updatedIds: ["message-1"], deletedIds: [],
        occurredAt: "2026-08-07T00:01:00.000Z"
      })}\n\n`));
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
    expect(fetchMock.mock.calls.filter(([input]) => String(input).includes("/messages?")).length).toBe(initialListRequests);
    await act(async () => {
      eventController.enqueue(new TextEncoder().encode(`event: messages.changed\ndata: ${JSON.stringify({
        accountId: "account-1", folder: "inbox", addedIds: ["message-2"], updatedIds: [], deletedIds: [],
        occurredAt: "2026-08-07T00:02:00.000Z"
      })}\n\n`));
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
    expect(fetchMock.mock.calls.filter(([input]) => String(input).includes("/messages?")).length).toBe(initialListRequests + 1);
    const detailRequests = fetchMock.mock.calls.filter(([input]) => String(input).endsWith("/messages/message-1")).length;
    fireEvent.click(row);
    expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith("/messages/message-1")).length).toBe(detailRequests);
  });

  it("allows all cached mail to be marked as read from the aggregate inbox", async () => {
    sessionStorage.setItem("imap2api-token", "valid-token");
    const accounts = [account("account-1", "first@example.com"), account("account-2", "second@example.com")];
    const eventStream = new ReadableStream<Uint8Array>({ start() {} });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/events")) return { ok: true, status: 200, body: eventStream } as Response;
      const json = async () => url.endsWith("/accounts") ? accounts
        : url.endsWith("/settings") ? { maxMessagesPerAccount: 100, pollIntervalSeconds: 10, pageSize: 100 }
          : url.includes("/messages?") ? { items: [summary], nextCursor: null }
            : url.includes("/messages/read-all") ? { count: 1, failedFolders: [] }
              : { ok: true };
      return { ok: true, status: 200, body: null, json } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    const markAllButton = await screen.findByRole("button", { name: "全部已读" });
    await waitFor(() => expect(markAllButton).toBeEnabled());
    fireEvent.click(markAllButton);
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "全部已读" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/v1/accounts/account-1/messages/read-all", expect.objectContaining({ method: "POST" })));
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/accounts/account-2/messages/read-all", expect.objectContaining({ method: "POST" }));
  });

  it("collapses content filters only when their measured buttons do not fit", async () => {
    sessionStorage.setItem("imap2api-token", "valid-token");
    const widths = new WeakMap<HTMLElement, number>();
    const resizeCallbacks: ResizeObserverCallback[] = [];
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) { return widths.get(this) ?? 0; });
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) { return widths.get(this) ?? 0; });
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: ResizeObserverCallback) { resizeCallbacks.push(callback); }
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/events")) return { ok: true, status: 200, body: new ReadableStream<Uint8Array>({ start() {} }) } as Response;
      const json = async () => url.endsWith("/accounts") ? [account("account-1", "first@example.com")]
        : url.endsWith("/settings") ? { maxMessagesPerAccount: 100, pollIntervalSeconds: 10, pageSize: 100 }
          : url.includes("/messages?") ? { items: [], nextCursor: null }
            : { ok: true };
      return { ok: true, status: 200, body: null, json } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    const viewGroup = await screen.findByRole("tablist", { name: "邮件视图" });
    const filterBar = viewGroup.parentElement as HTMLElement;
    const contentFilters = document.querySelector<HTMLElement>('[aria-label="邮件内容筛选"]')!;
    widths.set(filterBar, 400);
    widths.set(viewGroup, 180);
    widths.set(contentFilters, 160);

    act(() => resizeCallbacks.forEach((callback) => callback([], {} as ResizeObserver)));
    expect(contentFilters).not.toHaveAttribute("aria-hidden");
    expect(screen.queryByRole("button", { name: /更多筛选/ })).not.toBeInTheDocument();

    widths.set(filterBar, 330);
    act(() => resizeCallbacks.forEach((callback) => callback([], {} as ResizeObserver)));
    expect(within(viewGroup).getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["全部", "未读", "垃圾箱"]);
    expect(contentFilters).toHaveAttribute("aria-hidden", "true");
    const moreFilters = screen.getByRole("button", { name: "更多筛选，已选 0 项" });
    fireEvent.keyDown(moreFilters, { key: "Enter" });
    expect(moreFilters.closest("details")).toHaveAttribute("open");
    fireEvent.pointerDown(document.body);
    expect(moreFilters.closest("details")).not.toHaveAttribute("open");

    widths.set(filterBar, 400);
    act(() => resizeCallbacks.forEach((callback) => callback([], {} as ResizeObserver)));
    expect(contentFilters).not.toHaveAttribute("aria-hidden");
    expect(screen.queryByRole("button", { name: /更多筛选/ })).not.toBeInTheDocument();
  });

  it("combines a message view with multiple content filters and refreshes in place", async () => {
    sessionStorage.setItem("imap2api-token", "valid-token");
    const eventStream = new ReadableStream<Uint8Array>({ start() {} });
    let resolveRefresh: (() => void) | null = null;
    let blockRefresh = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/events")) return { ok: true, status: 200, body: eventStream } as Response;
      if (url.includes("filter=attachment") && blockRefresh) {
        await new Promise<void>((resolve) => { resolveRefresh = resolve; });
      }
      const json = async () => url.endsWith("/accounts") ? [account("account-1", "first@example.com")]
        : url.endsWith("/settings") ? { maxMessagesPerAccount: 100, pollIntervalSeconds: 10, pageSize: 100 }
          : url.includes("/messages?") ? { items: [{ ...summary, labels: ["verification_code"] }], nextCursor: null }
            : { ok: true };
      return { ok: true, status: 200, body: null, json } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    expect(await screen.findByText("Unread subject")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "未读" }));
    fireEvent.click(screen.getByRole("button", { name: "验证码" }));
    fireEvent.click(screen.getByRole("button", { name: "附件" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/messages?view=unread&limit=100&filter=verification_code&filter=attachment", expect.any(Object)
    ));
    expect(screen.getByRole("tab", { name: "未读" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("button", { name: "验证码" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "附件" })).toHaveAttribute("aria-pressed", "true");
    blockRefresh = true;
    fireEvent.click(screen.getByRole("button", { name: "刷新邮件列表" }));
    expect(screen.getByText("Unread subject")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("正在刷新邮件列表");
    await waitFor(() => expect(resolveRefresh).not.toBeNull());
    (resolveRefresh as (() => void) | null)?.();
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(""));
  });

  it("keeps the full forwarding mailbox available when the compact label falls back", async () => {
    sessionStorage.setItem("imap2api-token", "valid-token");
    const eventStream = new ReadableStream<Uint8Array>({ start() {} });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/events")) return { ok: true, status: 200, body: eventStream } as Response;
      const json = async () => url.endsWith("/accounts") ? [account("account-1", "first@example.com")]
        : url.endsWith("/settings") ? { maxMessagesPerAccount: 100, pollIntervalSeconds: 10, pageSize: 100 }
          : url.includes("/messages?") ? {
            items: [{ ...summary, labels: ["forwarded"], forwardedVia: "relay@domain-b.test" }], nextCursor: null
          } : { ok: true };
      return { ok: true, status: 200, body: null, json } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    const label = await screen.findByLabelText("经由邮箱 relay@domain-b.test");
    expect(label).toHaveAttribute("title", "经由邮箱 relay@domain-b.test");
    expect(label).toHaveTextContent("转发");
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

  it("automatically loads remote images only for an exact whitelisted sender", () => {
    const message: MessageDetail = {
      id: "message-trusted", accountId: "account-1", accountEmail: "mail@example.test", subject: "Trusted images",
      from: [{ address: "Sender@Example.test" }], to: [{ address: "mail@example.test" }], cc: [], preview: "", displayTime: "2026-01-01T00:00:00.000Z",
      folder: "junk", read: true, hasAttachments: false, attachments: [], labels: [], forwardedVia: null,
      verificationCode: null, unsubscribeUrl: null, text: "", html: '<img data-remote-src="https://images.example.test/a.png">'
    };
    expect(senderAllowsRemoteImages(message.from, [" sender@example.TEST "])).toBe(true);
    expect(senderAllowsRemoteImages(message.from, ["other@example.test"])).toBe(false);
    const view = render(<MessageDetailView api={detailApi} message={message} remoteImageAllowlist={[" sender@example.TEST "]} onBack={vi.fn()} onMark={vi.fn()} />);

    expect((screen.getByTitle("邮件正文") as HTMLIFrameElement).srcdoc).toContain("img-src data: http: https:");
    expect(screen.getByRole("button", { name: "图片已加载" })).toBeDisabled();
    expect(screen.queryByText("垃圾箱")).not.toBeInTheDocument();

    view.rerender(<MessageDetailView api={detailApi} message={{ ...message, id: "message-untrusted" }} remoteImageAllowlist={["other@example.test"]} onBack={vi.fn()} onMark={vi.fn()} />);
    expect((screen.getByTitle("邮件正文") as HTMLIFrameElement).srcdoc).toContain("img-src data:;");
    expect(screen.getByRole("button", { name: "加载图片" })).toBeEnabled();
  });

  it("loads images only for the selected message and confirms body links", async () => {
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const message: MessageDetail = {
      id: "message-1", accountId: "account-1", accountEmail: "mail@example.test", subject: "Styled",
      from: [{ address: "sender@example.test" }], to: [{ address: "mail@example.test" }], cc: [], preview: "", displayTime: "2026-01-01T00:00:00.000Z",
      folder: "inbox", read: false, hasAttachments: false, attachments: [], labels: [], forwardedVia: null, verificationCode: null, unsubscribeUrl: null, text: "",
      html: '<img data-remote-src="https://images.example.test/a.png"><a data-safe-href="https://example.test/path">Example link</a>'
    };
    const view = render(<MessageDetailView api={detailApi} message={message} onBack={vi.fn()} onMark={vi.fn()} />);

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

    view.rerender(<MessageDetailView api={detailApi} message={{ ...message, id: "message-2" }} onBack={vi.fn()} onMark={vi.fn()} />);
    expect(screen.getByRole("button", { name: "加载图片" })).toBeEnabled();
    expect((screen.getByTitle("邮件正文") as HTMLIFrameElement).srcdoc).toContain("img-src data:;");
  });

  it("collapses detail metadata while scrolling either body type and resets for another message", () => {
    const message: MessageDetail = {
      id: "message-scroll", accountId: "account-1", accountEmail: "mail@example.test", subject: "Scrollable message",
      from: [{ address: "sender@example.test" }], to: [{ address: "mail@example.test" }], cc: [{ address: "copy@example.test" }], preview: "",
      displayTime: "2026-01-01T00:00:00.000Z", folder: "inbox", read: true, hasAttachments: true,
      attachments: [{ id: "attachment-1", filename: "invoice.pdf", contentType: "application/pdf", size: 2048 }], labels: [], forwardedVia: null, verificationCode: null, unsubscribeUrl: null,
      text: "Long message body", html: null
    };
    const view = render(<MessageDetailView api={detailApi} message={message} onBack={vi.fn()} onMark={vi.fn()} />);
    const metadata = screen.getByText("发件人").closest("dl")!.parentElement!;
    const textBody = screen.getByText("Long message body");

    expect(metadata).toHaveAttribute("aria-hidden", "false");
    Object.defineProperty(textBody, "scrollTop", { configurable: true, value: 40 });
    fireEvent.scroll(textBody);
    expect(metadata).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByRole("heading", { name: "Scrollable message" })).toBeVisible();

    Object.defineProperty(textBody, "scrollTop", { configurable: true, value: 20 });
    fireEvent.scroll(textBody);
    expect(metadata).toHaveAttribute("aria-hidden", "false");

    view.rerender(<MessageDetailView api={detailApi} message={{ ...message, id: "message-html", text: "", html: "<p>HTML body</p>" }} onBack={vi.fn()} onMark={vi.fn()} />);
    const frame = screen.getByTitle("邮件正文") as HTMLIFrameElement;
    fireEvent.load(frame);
    Object.defineProperty(frame.contentDocument!.documentElement, "scrollTop", { configurable: true, value: 40 });
    fireEvent.scroll(frame.contentDocument!);
    expect(metadata).toHaveAttribute("aria-hidden", "true");

    view.rerender(<MessageDetailView api={detailApi} message={{ ...message, id: "message-next" }} onBack={vi.fn()} onMark={vi.fn()} />);
    expect(metadata).toHaveAttribute("aria-hidden", "false");
  });

  it("downloads, cancels and retries attachments while keeping legacy entries visible", async () => {
    const api = new ApiClient("valid-token");
    const downloadSignals: AbortSignal[] = [];
    const download = vi.spyOn(api, "download")
      .mockImplementationOnce((_path, signal) => {
        downloadSignals.push(signal);
        return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }));
      })
      .mockImplementationOnce(async (_path, _signal, onStarted) => {
        onStarted?.();
        return new Blob(["pdf-content"], { type: "application/pdf" });
      })
      .mockRejectedValueOnce(new Error("IMAP offline"));
    const NativeURL = URL;
    const createObjectURL = vi.fn(() => "blob:attachment");
    const revokeObjectURL = vi.fn();
    class DownloadURL extends NativeURL {}
    Object.assign(DownloadURL, { createObjectURL, revokeObjectURL });
    vi.stubGlobal("URL", DownloadURL);
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    const message: MessageDetail = {
      id: "message-download", accountId: "account-1", accountEmail: "mail@example.test", subject: "Attachments",
      from: [{ address: "sender@example.test" }], to: [{ address: "mail@example.test" }], cc: [], preview: "",
      displayTime: "2026-01-01T00:00:00.000Z", folder: "inbox", read: true, hasAttachments: true,
      attachments: [
        { id: "attachment-1", filename: "invoice.pdf", contentType: "application/pdf", size: 2048 },
        { id: null, filename: "legacy.txt", contentType: "application/octet-stream", size: null }
      ], labels: [], forwardedVia: null, verificationCode: null, unsubscribeUrl: null, text: "Body", html: null
    };
    render(<MessageDetailView api={api} message={message} onBack={vi.fn()} onMark={vi.fn()} />);

    expect(screen.getByRole("button", { name: "legacy.txt，同步后可下载" })).toBeDisabled();
    expect(screen.getByText("2.0 KB")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "下载 invoice.pdf" }));
    expect(await screen.findByText("等待中")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "取消下载 invoice.pdf" }));
    expect(downloadSignals[0]?.aborted).toBe(true);
    await waitFor(() => expect(screen.queryByText("等待中")).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "下载 invoice.pdf" }));
    await waitFor(() => expect(screen.getByText("已下载")).toBeInTheDocument());
    expect(download).toHaveBeenNthCalledWith(2, "/messages/message-download/attachments/attachment-1", expect.any(AbortSignal), expect.any(Function));
    expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:attachment");
    expect(click).toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "下载 invoice.pdf" }));
    expect(await screen.findByText("失败 · 重试")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重试下载 invoice.pdf" })).toBeEnabled();
  });

  it("shows labels, copies verification codes, and confirms unsubscribe links", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const message: MessageDetail = {
      id: "message-actions", accountId: "account-1", accountEmail: "mail@example.test", subject: "Code",
      from: [{ name: "Sender", address: "sender@example.test" }], to: [{ address: "mail@example.test" }], cc: [{ name: "Copy", address: "copy@example.test" }], preview: "",
      displayTime: "2026-01-01T00:00:00.000Z", folder: "inbox", read: false, hasAttachments: false,
      attachments: [], text: "验证码 123456", html: null,
      labels: ["forwarded", "verification_code", "unsubscribe"], forwardedVia: "relay@domain-b.test",
      verificationCode: "123456", unsubscribeUrl: "https://example.test/unsubscribe"
    };
    const view = render(<MessageDetailView api={detailApi} message={message} onBack={vi.fn()} onMark={vi.fn()} />);

    expect(screen.getByText("relay@domain-b.test")).toBeInTheDocument();
    expect(screen.queryByText("转发")).not.toBeInTheDocument();
    expect(screen.queryByText("验证码")).not.toBeInTheDocument();
    expect(view.container.querySelector('[data-label="unsubscribe"]')).toBeNull();
    expect(screen.getByRole("button", { name: "标记为已读" }).querySelector(".lucide-mail")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "复制邮箱地址 sender@example.test" }).querySelector(".lucide-copy")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "复制经由邮箱 relay@domain-b.test" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("relay@domain-b.test"));
    expect(screen.getByRole("button", { name: "复制经由邮箱 relay@domain-b.test" })).toHaveAttribute("data-copy-state", "copied");
    expect(screen.getByRole("button", { name: "复制经由邮箱 relay@domain-b.test" }).querySelector(".lucide-check")).toBeInTheDocument();
    expect(screen.getByText("已复制")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("relay@domain-b.test 已复制");

    fireEvent.click(screen.getByRole("button", { name: "复制邮箱地址 sender@example.test" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("sender@example.test"));
    expect(screen.getByRole("button", { name: "复制邮箱地址 sender@example.test" })).toHaveAttribute("data-copy-state", "copied");
    expect(screen.getByRole("button", { name: "复制邮箱地址 mail@example.test" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "复制邮箱地址 copy@example.test" })).toBeInTheDocument();

    writeText.mockRejectedValueOnce(new Error("clipboard denied"));
    fireEvent.click(screen.getByRole("button", { name: "复制邮箱地址 copy@example.test" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("copy@example.test 复制失败"));
    expect(screen.getByRole("button", { name: "复制邮箱地址 copy@example.test" })).toHaveAttribute("data-copy-state", "error");

    fireEvent.click(screen.getByRole("button", { name: "复制 123456" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("123456"));
    expect(screen.getByRole("status")).toHaveTextContent("验证码已复制");

    fireEvent.click(screen.getByRole("button", { name: "退订" }));
    expect(await screen.findByText("确认前往 example.test 退订？")).toBeInTheDocument();
    expect(screen.getByRole("alertdialog")).not.toHaveClass("modal-box");
    expect(open).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "打开退订链接" }));
    expect(open).toHaveBeenCalledWith("https://example.test/unsubscribe", "_blank", "noopener,noreferrer");

    view.rerender(<MessageDetailView api={detailApi} message={{ ...message, id: "message-actions-2" }} onBack={vi.fn()} onMark={vi.fn()} />);
    expect(screen.getByRole("button", { name: "复制 123456" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("");

    writeText.mockRejectedValueOnce(new Error("clipboard denied"));
    fireEvent.click(screen.getByRole("button", { name: "复制 123456" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("验证码复制失败"));

    view.rerender(<MessageDetailView api={detailApi} message={{ ...message, id: "message-actions-3", read: true, unsubscribeUrl: "javascript:alert(1)" }} onBack={vi.fn()} onMark={vi.fn()} />);
    expect(screen.getByRole("button", { name: "标记为未读" }).querySelector(".lucide-mail-open")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "退订" })).not.toBeInTheDocument();
  });
});
