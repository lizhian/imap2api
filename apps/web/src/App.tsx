import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent as ReactDragEvent, type FormEvent, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import * as AlertDialog from "@radix-ui/react-alert-dialog";
import * as Select from "@radix-ui/react-select";
import * as Tooltip from "@radix-ui/react-tooltip";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  Archive, ArrowLeft, Check, ChevronDown, ChevronLeft, ChevronRight, CircleAlert, CircleCheck,
  Cloud, Copy, Download, Edit3, ExternalLink, Eye, EyeOff, FileText, Folder, FolderCog, Forward, GripVertical, Image as ImageIcon, Inbox, KeyRound, LogOut, Mail, MailOpen,
  Paperclip, Plus, RefreshCw, SearchX, Send, Settings as SettingsIcon, ShieldCheck,
  SlidersHorizontal, SquarePen, Trash2, UserRound, X
} from "lucide-react";
import type { Account, AccountInput, AccountOrderUpdate, AccountUpdate, Address, MailboxListResponse, MessageDetail, MessageLabel, MessageListResponse, MessageSecondaryFilter, MessageSummary, MessageView, ProviderId, ServerEvent, Settings, SyncFolderConfig } from "@email2api/shared";
import { ApiClient } from "./api";
import { Button, EmptyState, IconButton, Spinner } from "./components";
import styles from "./styles.module.css";

const ComposePage = lazy(() => import("./ComposePage").then((module) => ({ default: module.ComposePage })));

const SESSION_KEY = "email2api-token";
const LAYOUT_WIDTHS_KEY = "email2api-layout-widths";
const SIDEBAR_MIN_WIDTH = 200;
const SIDEBAR_MAX_WIDTH = 360;
const MESSAGE_LIST_MIN_WIDTH = 320;
const DETAIL_MIN_WIDTH = 360;
const PROVIDERS: Array<{ value: ProviderId; label: string }> = [
  { value: "auto", label: "自动识别" }, { value: "qq", label: "QQ 邮箱" },
  { value: "gmail", label: "Gmail" }, { value: "icloud", label: "iCloud" },
  { value: "outlook", label: "Outlook" }, { value: "qq-enterprise", label: "QQ 企业邮箱" },
  { value: "163", label: "163 邮箱" }, { value: "custom", label: "自定义" }
];
const MESSAGE_LABELS: Record<MessageLabel, { text: string; icon: typeof Forward }> = {
  forwarded: { text: "转发", icon: Forward },
  verification_code: { text: "验证码", icon: KeyRound },
  unsubscribe: { text: "退订", icon: ExternalLink }
};
const MESSAGE_VIEWS: Array<{ value: MessageView; label: string }> = [
  { value: "all", label: "全部" }, { value: "unread", label: "未读" }, { value: "junk", label: "垃圾箱" }
];
const MESSAGE_SECONDARY_FILTERS: Array<{ value: MessageSecondaryFilter; label: string; icon: typeof Forward }> = [
  { value: "verification_code", label: "验证码", icon: KeyRound },
  { value: "attachment", label: "附件", icon: Paperclip },
  { value: "forwarded", label: "转发", icon: Forward }
];

type Page = "messages" | "compose" | "accounts" | "settings";
type LayoutWidthName = "sidebar" | "messageList";
type StoredLayoutWidths = Partial<Record<LayoutWidthName, number>>;

function clampWidth(value: number, min: number, max: number): number {
  return Math.min(Math.max(min, max), Math.max(min, value));
}

function readStoredLayoutWidths(): StoredLayoutWidths {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(LAYOUT_WIDTHS_KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const record = parsed as Record<string, unknown>;
    return {
      ...(typeof record.sidebar === "number" && Number.isFinite(record.sidebar) ? { sidebar: record.sidebar } : {}),
      ...(typeof record.messageList === "number" && Number.isFinite(record.messageList) ? { messageList: record.messageList } : {})
    };
  } catch {
    return {};
  }
}

function sidebarMaxWidth(): number {
  return Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, window.innerWidth - 680));
}

function initialSidebarWidth(): number {
  return clampWidth(readStoredLayoutWidths().sidebar ?? SIDEBAR_MIN_WIDTH, SIDEBAR_MIN_WIDTH, sidebarMaxWidth());
}

function initialMessageListWidth(): number {
  const stored = readStoredLayoutWidths();
  const sidebar = clampWidth(stored.sidebar ?? SIDEBAR_MIN_WIDTH, SIDEBAR_MIN_WIDTH, sidebarMaxWidth());
  const max = Math.max(MESSAGE_LIST_MIN_WIDTH, window.innerWidth - sidebar - DETAIL_MIN_WIDTH);
  return clampWidth(stored.messageList ?? MESSAGE_LIST_MIN_WIDTH, MESSAGE_LIST_MIN_WIDTH, max);
}

function storeLayoutWidth(name: LayoutWidthName, value: number): void {
  try {
    localStorage.setItem(LAYOUT_WIDTHS_KEY, JSON.stringify({ ...readStoredLayoutWidths(), [name]: value }));
  } catch {
    // Layout preferences must not prevent the application from working when storage is unavailable.
  }
}

function formatDate(value: string | null, compact = false): string {
  if (!value) return "尚未同步";
  const date = new Date(value);
  return new Intl.DateTimeFormat("zh-CN", compact
    ? { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }
    : { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }
  ).format(date);
}

export function formatRelativeDate(value: string, now = Date.now()): string {
  const elapsedSeconds = Math.max(1, Math.floor((now - new Date(value).getTime()) / 1000));
  if (elapsedSeconds < 60) return `${elapsedSeconds}秒前`;
  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) return `${elapsedMinutes}分前`;
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return `${elapsedHours}小时前`;
  const elapsedDays = Math.floor(elapsedHours / 24);
  if (elapsedDays < 30) return `${elapsedDays}天前`;
  if (elapsedDays < 365) return `${Math.floor(elapsedDays / 30)}月前`;
  return `${Math.floor(elapsedDays / 365)}年前`;
}

function senderLabel(message: MessageSummary): string {
  const sender = message.from[0];
  return sender?.name || sender?.address || "未知发件人";
}

export function senderAllowsRemoteImages(from: Address[], allowlist: string[]): boolean {
  const allowed = new Set(allowlist.map((address) => address.trim().toLowerCase()));
  return from.some((sender) => allowed.has(sender.address.trim().toLowerCase()));
}

export function canShowFullForwardedVia(metaWidth: number, senderNaturalWidth: number, fullMetaWidth: number): boolean {
  if (metaWidth <= 0 || fullMetaWidth <= 0) return false;
  const senderReserve = Math.min(senderNaturalWidth, Math.max(72, metaWidth * 0.42));
  return fullMetaWidth + 8 <= metaWidth - senderReserve;
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

function ResizeHandle({ value, min, max, label, onChange }: { value: number; min: number; max: () => number; label: string; onChange: (value: number) => void }) {
  const drag = useRef<{ pointerId: number; startX: number; startValue: number } | null>(null);
  const clamp = (next: number) => Math.min(Math.max(min, max()), Math.max(min, next));
  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    drag.current = { pointerId: event.pointerId, startX: event.clientX, startValue: value };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current || drag.current.pointerId !== event.pointerId) return;
    onChange(clamp(drag.current.startValue + event.clientX - drag.current.startX));
  };
  const handlePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const step = event.shiftKey ? 32 : 8;
    if (event.key === "Home") onChange(min);
    else if (event.key === "End") onChange(Math.max(min, max()));
    else onChange(clamp(value + (event.key === "ArrowLeft" ? -step : step)));
  };
  return <div className={styles.resizeHandle} role="separator" aria-label={label} aria-orientation="vertical" aria-valuemin={min} aria-valuemax={Math.max(min, max())} aria-valuenow={Math.round(value)} tabIndex={0} onKeyDown={handleKeyDown} onPointerDown={handlePointerDown} onPointerMove={handlePointerMove} onPointerUp={handlePointerUp} onPointerCancel={handlePointerUp}><span aria-hidden="true" /></div>;
}

export function App() {
  const [token, setToken] = useState(() => sessionStorage.getItem(SESSION_KEY) ?? "");
  const [verified, setVerified] = useState(false);
  const [checking, setChecking] = useState(Boolean(token));

  useEffect(() => {
    if (!token) { setChecking(false); setVerified(false); return; }
    const api = new ApiClient(token);
    setChecking(true);
    api.request<{ ok: true }>("/auth/verify", { method: "POST" })
      .then(() => setVerified(true))
      .catch(() => { sessionStorage.removeItem(SESSION_KEY); setToken(""); setVerified(false); })
      .finally(() => setChecking(false));
  }, [token]);

  if (checking) return <div className={styles.boot}><Spinner label="正在验证 Token" /></div>;
  if (!verified) return <Login onLogin={(value) => { sessionStorage.setItem(SESSION_KEY, value); setToken(value); }} />;
  return <AuthenticatedApp token={token} onLogout={() => { sessionStorage.removeItem(SESSION_KEY); setToken(""); }} />;
}

function Login({ onLogin }: { onLogin: (token: string) => void }) {
  const [value, setValue] = useState("");
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true); setError("");
    try {
      await new ApiClient(value).request("/auth/verify", { method: "POST" });
      onLogin(value);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "验证失败");
    } finally { setBusy(false); }
  };

  return (
    <main className={styles.loginPage}>
      <motion.form initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.24 }} className={`card bg-base-100 ${styles.loginPanel}`} onSubmit={submit}>
        <div className={styles.brandMark}><Mail size={20} strokeWidth={2} /></div>
        <h1>email2api</h1>
        <div className={styles.field}>
          <label htmlFor="token">访问 Token</label>
          <div className={styles.passwordField}>
            <input className="input input-sm" id="token" value={value} onChange={(event) => setValue(event.target.value)} type={visible ? "text" : "password"} autoFocus autoComplete="current-password" required />
            <IconButton type="button" label={visible ? "隐藏 Token" : "显示 Token"} onClick={() => setVisible((state) => !state)}>{visible ? <EyeOff size={17} /> : <Eye size={17} />}</IconButton>
          </div>
        </div>
        {error && <p className={styles.formError} role="alert"><CircleAlert size={15} />{error}</p>}
        <Button className={styles.fullButton} variant="primary" disabled={busy || !value}>{busy ? <Spinner label="正在登录" /> : <><KeyRound size={16} />进入管理</>}</Button>
      </motion.form>
    </main>
  );
}

function AuthenticatedApp({ token, onLogout }: { token: string; onLogout: () => void }) {
  const api = useMemo(() => new ApiClient(token), [token]);
  const [page, setPage] = useState<Page>(() => {
    const hash = location.hash.slice(1);
    return hash === "compose" || hash === "accounts" || hash === "settings" ? hash : "messages";
  });
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [activeAccountId, setActiveAccountId] = useState("");
  const [messageRevision, setMessageRevision] = useState(0);
  const [eventConnection, setEventConnection] = useState<"connecting" | "connected" | "reconnecting">("connecting");
  const [sidebarWidth, setSidebarWidth] = useState(initialSidebarWidth);
  const [notice, setNotice] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const localMessageUpdates = useRef(new Map<string, number>());
  const reducedMotion = useReducedMotion();

  const loadAccounts = useCallback(async () => {
    try { setAccounts(await api.request<Account[]>("/accounts")); }
    catch (error) { setNotice({ kind: "error", text: error instanceof Error ? error.message : "账号加载失败" }); }
  }, [api]);

  const reorderAccounts = useCallback(async (accountIds: string[]) => {
    const previous = accounts;
    const byId = new Map(accounts.map((account) => [account.id, account]));
    const optimistic = accountIds.map((id) => byId.get(id)).filter((account): account is Account => Boolean(account));
    if (optimistic.length !== accounts.length) throw new Error("账号排序数据无效");
    setAccounts(optimistic);
    try {
      const input: AccountOrderUpdate = { accountIds };
      setAccounts(await api.request<Account[]>("/accounts/order", { method: "PUT", body: JSON.stringify(input) }));
    } catch (error) {
      setAccounts(previous);
      throw error;
    }
  }, [accounts, api]);

  const registerLocalMessageUpdate = useCallback((messageId: string) => {
    localMessageUpdates.current.set(messageId, Date.now() + 5_000);
  }, []);
  const cancelLocalMessageUpdate = useCallback((messageId: string) => {
    localMessageUpdates.current.delete(messageId);
  }, []);
  const consumeLocalMessageEcho = useCallback((event: Extract<ServerEvent, { type: "messages.changed" }>) => {
    const now = Date.now();
    for (const [messageId, expiresAt] of localMessageUpdates.current) {
      if (expiresAt <= now) localMessageUpdates.current.delete(messageId);
    }
    if (event.addedIds.length || event.deletedIds.length || !event.updatedIds.length) return false;
    const localOnly = event.updatedIds.every((messageId) => localMessageUpdates.current.has(messageId));
    event.updatedIds.forEach((messageId) => localMessageUpdates.current.delete(messageId));
    return localOnly;
  }, []);

  useEffect(() => {
    void loadAccounts();
    const controller = new AbortController();
    let messageRefresh: ReturnType<typeof setTimeout> | null = null;
    const refreshMessages = () => {
      if (messageRefresh) clearTimeout(messageRefresh);
      messageRefresh = setTimeout(() => {
        messageRefresh = null;
        setMessageRevision((value) => value + 1);
      }, 100);
    };
    void (async () => {
      let retry = 0;
      while (!controller.signal.aborted) {
        try {
          await api.subscribe((event: ServerEvent) => {
            retry = 0;
            if (event.type === "ready") {
              setEventConnection("connected");
              void loadAccounts();
              refreshMessages();
            } else if (event.type === "account.changed") {
              void loadAccounts();
            } else if (event.type === "messages.changed") {
              void loadAccounts();
              if (!consumeLocalMessageEcho(event)) refreshMessages();
            }
          }, controller.signal);
        } catch {
          if (controller.signal.aborted) break;
          setEventConnection("reconnecting");
          const delays = [1000, 2000, 5000, 10_000, 30_000];
          await abortableDelay(delays[Math.min(retry++, delays.length - 1)]!, controller.signal);
        }
      }
    })();
    return () => {
      controller.abort();
      if (messageRefresh) clearTimeout(messageRefresh);
    };
  }, [api, consumeLocalMessageEcho, loadAccounts]);

  useEffect(() => {
    if (activeAccountId && !accounts.some((account) => account.id === activeAccountId)) setActiveAccountId("");
  }, [accounts, activeAccountId]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 3800);
    return () => clearTimeout(timer);
  }, [notice]);

  const navigate = (next: Page) => { location.hash = next; setPage(next); };
  const openMailbox = (accountId: string) => { setActiveAccountId(accountId); navigate("messages"); };
  const updateSidebarWidth = useCallback((value: number) => {
    setSidebarWidth(value);
    storeLayoutWidth("sidebar", value);
  }, []);
  const totalUnread = accounts.reduce((sum, account) => sum + (account.unreadCount ?? 0), 0);
  const connectionBadge = eventConnection === "connected"
    ? { badge: "badge-success", status: "status-success", label: "服务正常" }
    : eventConnection === "reconnecting"
      ? { badge: "badge-warning", status: "status-warning", label: "正在重连" }
      : { badge: "badge-info", status: "status-info", label: "连接中" };

  return (
    <div className={`${styles.appShell} bg-base-200 text-base-content`} style={{ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties}>
      <aside className={`${styles.sidebar} bg-base-100`}>
        <div className={styles.sidebarBrand}><span className={styles.brandMark}><Mail size={18} /></span><strong>email2api</strong><span className={`status status-xs ${connectionBadge.status}`} aria-label={connectionBadge.label} /></div>
        <nav className={`tabs ${styles.accountTabs}`} role="tablist" aria-label="邮箱账号">
          <button role="tab" aria-selected={page === "messages" && !activeAccountId} className={`tab ${page === "messages" && !activeAccountId ? "tab-active" : ""} ${styles.accountTab} ${styles.accountTabWithIcon}`} onClick={() => openMailbox("")}>
            <span className={styles.accountTabIcon}><Inbox size={16} /></span><span className={`${styles.accountTabText} ${styles.aggregateTabText}`}><strong>聚合收件箱</strong><small className={styles.unreadCount} aria-label={`${totalUnread} 封未读`}>{totalUnread} 未读</small></span>
          </button>
          {accounts.map((account) => <button key={account.id} role="tab" aria-selected={page === "messages" && activeAccountId === account.id} className={`tab ${page === "messages" && activeAccountId === account.id ? "tab-active" : ""} ${styles.accountTab}`} onClick={() => openMailbox(account.id)}>
            <span className={styles.accountTabText}><strong>{account.email}</strong><span className={styles.accountTabSubline}><small>{account.status === "connected" ? "已连接" : account.status === "connecting" ? "同步中" : account.status === "warning" ? "有警告" : account.status === "error" ? "连接错误" : "等待连接"}</small><small className={styles.unreadCount} aria-label={`${account.unreadCount ?? 0} 封未读`}>{account.unreadCount ?? 0} 未读</small></span></span>
          </button>)}
        </nav>
        <nav className={`menu menu-sm ${styles.utilityNav}`} aria-label="管理导航">
          <li><NavButton active={page === "compose"} icon={<SquarePen size={17} />} label="写信" onClick={() => navigate("compose")} /></li>
          <li><NavButton active={page === "accounts"} icon={<UserRound size={17} />} label="账号管理" onClick={() => navigate("accounts")} /></li>
          <li><NavButton active={page === "settings"} icon={<SettingsIcon size={17} />} label="系统设置" onClick={() => navigate("settings")} /></li>
        </nav>
        <button className={`btn btn-ghost btn-sm ${styles.logoutButton}`} onClick={onLogout}><LogOut size={17} />退出</button>
      </aside>
      <ResizeHandle value={sidebarWidth} min={SIDEBAR_MIN_WIDTH} max={sidebarMaxWidth} label="调整邮箱栏宽度" onChange={updateSidebarWidth} />
      <div className={styles.mainColumn}>
        <main className={`${styles.mainContent} ${page === "messages" || page === "compose" ? styles.messageContent : ""}`}>
          <AnimatePresence mode="wait" initial={false}>
            <motion.div key={page} className={`${styles.pageFrame} ${page === "messages" || page === "compose" ? styles.messageFrame : ""}`} initial={reducedMotion ? { opacity: 0 } : { opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={reducedMotion ? { opacity: 0 } : { opacity: 0, y: -4 }} transition={{ duration: reducedMotion ? 0.08 : 0.2 }}>
              {page === "messages" && <MessagesPage api={api} accounts={accounts} accountId={activeAccountId} onAccountChange={setActiveAccountId} revision={messageRevision} onLocalMessageUpdate={registerLocalMessageUpdate} onLocalMessageUpdateFailed={cancelLocalMessageUpdate} onNotice={setNotice} />}
              {page === "compose" && <Suspense fallback={<div className={styles.centerState}><Spinner /></div>}><ComposePage api={api} accounts={accounts} onNotice={setNotice} /></Suspense>}
              {page === "accounts" && <AccountsPage api={api} accounts={accounts} reload={loadAccounts} reorder={reorderAccounts} onNotice={setNotice} />}
              {page === "settings" && <SettingsPage api={api} onNotice={setNotice} />}
            </motion.div>
          </AnimatePresence>
        </main>
      </div>
      <nav className={styles.mobileNav} aria-label="移动端主导航">
        <NavButton active={page === "messages"} icon={<Inbox size={19} />} label="邮件" onClick={() => navigate("messages")} />
        <NavButton active={page === "compose"} icon={<SquarePen size={19} />} label="写信" onClick={() => navigate("compose")} />
        <NavButton active={page === "accounts"} icon={<UserRound size={19} />} label="账号" onClick={() => navigate("accounts")} />
        <NavButton active={page === "settings"} icon={<SettingsIcon size={19} />} label="设置" onClick={() => navigate("settings")} />
        <NavButton active={false} icon={<LogOut size={19} />} label="退出" onClick={onLogout} />
      </nav>
      <AnimatePresence>{notice && <motion.div role="status" aria-live="polite" className={`alert alert-soft ${notice.kind === "success" ? "alert-success" : "alert-error"} ${styles.notice}`} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 4 }}>{notice.kind === "success" ? <CircleCheck size={17} /> : <CircleAlert size={17} />}{notice.text}</motion.div>}</AnimatePresence>
    </div>
  );
}

function NavButton({ active, icon, label, onClick }: { active: boolean; icon: ReactNode; label: string; onClick: () => void }) {
  return <button className={`${active ? "menu-active" : ""} ${styles.navButton}`} aria-current={active ? "page" : undefined} onClick={onClick}>{icon}<span>{label}</span></button>;
}

function AccountsPage({ api, accounts, reload, reorder, onNotice }: { api: ApiClient; accounts: Account[]; reload: () => Promise<void>; reorder: (accountIds: string[]) => Promise<void>; onNotice: (notice: { kind: "success" | "error"; text: string }) => void }) {
  const [editing, setEditing] = useState<Account | "new" | null>(null);
  const [folderAccount, setFolderAccount] = useState<Account | null>(null);
  const [deleting, setDeleting] = useState<Account | null>(null);
  const [localSyncing, setLocalSyncing] = useState<Set<string>>(new Set());
  const [pollIntervalSeconds, setPollIntervalSeconds] = useState(10);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [reordering, setReordering] = useState(false);
  const [now, setNow] = useState(Date.now());

  useEffect(() => { void api.request<Settings>("/settings").then((value) => setPollIntervalSeconds(value.pollIntervalSeconds)); }, [api]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const sync = async (account: Account) => {
    setLocalSyncing((set) => new Set(set).add(account.id));
    try {
      await api.request(`/accounts/${account.id}/sync`, { method: "POST" });
      onNotice({ kind: "success", text: `${account.email} 已开始同步` });
      setTimeout(() => void reload(), 500);
    } catch (error) { onNotice({ kind: "error", text: error instanceof Error ? error.message : "同步失败" }); }
    finally { setTimeout(() => setLocalSyncing((set) => { const next = new Set(set); next.delete(account.id); return next; }), 1200); }
  };

  const test = async (account: Account) => {
    onNotice({ kind: "success", text: `正在测试 ${account.email}` });
    try { await api.request(`/accounts/${account.id}/test`, { method: "POST" }); onNotice({ kind: "success", text: "IMAP 连接成功" }); }
    catch (error) { onNotice({ kind: "error", text: error instanceof Error ? error.message : "连接失败" }); }
    finally { await reload(); }
  };

  const testSmtp = async (account: Account) => {
    onNotice({ kind: "success", text: `正在测试 ${account.email} 的 SMTP` });
    try { await api.request(`/accounts/${account.id}/smtp/test`, { method: "POST" }); onNotice({ kind: "success", text: "SMTP 连接成功" }); }
    catch (error) { onNotice({ kind: "error", text: error instanceof Error ? error.message : "SMTP 连接失败" }); }
  };

  const remove = async () => {
    if (!deleting) return;
    try { await api.request(`/accounts/${deleting.id}`, { method: "DELETE" }); onNotice({ kind: "success", text: "邮箱账号和本地缓存已删除" }); setDeleting(null); await reload(); }
    catch (error) { onNotice({ kind: "error", text: error instanceof Error ? error.message : "删除失败" }); }
  };

  const orderedIds = (sourceId: string, targetId: string): string[] | null => {
    const ids = accounts.map((account) => account.id);
    const sourceIndex = ids.indexOf(sourceId); const targetIndex = ids.indexOf(targetId);
    if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return null;
    ids.splice(targetIndex, 0, ids.splice(sourceIndex, 1)[0]!);
    return ids;
  };

  const persistOrder = async (accountIds: string[]) => {
    setReordering(true);
    try { await reorder(accountIds); onNotice({ kind: "success", text: "账号顺序已保存" }); }
    catch (error) { onNotice({ kind: "error", text: error instanceof Error ? error.message : "账号排序失败" }); }
    finally { setReordering(false); setDraggingId(null); setDropTargetId(null); }
  };

  const moveByKeyboard = (accountId: string, offset: -1 | 1) => {
    const index = accounts.findIndex((account) => account.id === accountId);
    const target = accounts[index + offset];
    if (!target || reordering) return;
    const next = orderedIds(accountId, target.id);
    if (next) void persistOrder(next);
  };

  const startDragging = (event: ReactDragEvent<HTMLElement>, accountId: string) => {
    setDraggingId(accountId); setDropTargetId(null);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", accountId);
  };

  const dropAccount = (event: ReactDragEvent<HTMLElement>, targetId: string) => {
    event.preventDefault();
    const sourceId = draggingId ?? event.dataTransfer.getData("text/plain");
    const next = orderedIds(sourceId, targetId);
    if (next) void persistOrder(next);
    else { setDraggingId(null); setDropTargetId(null); }
  };

  return (
    <section className={styles.section}>
      <div className={styles.sectionToolbar}><div><h2>已连接账号</h2><p>{accounts.length} 个邮箱</p></div><Button variant="primary" onClick={() => setEditing("new")}><Plus size={16} />添加邮箱</Button></div>
      {accounts.length === 0 ? <EmptyState icon={<Cloud size={28} />} title="还没有邮箱账号" action={<Button variant="primary" onClick={() => setEditing("new")}><Plus size={16} />添加邮箱</Button>} /> :
        <div className={`list ${styles.accountList}`}>
          {accounts.map((account) => {
            const syncing = localSyncing.has(account.id) || account.status === "connecting";
            const providerLabel = PROVIDERS.find((provider) => provider.value === account.provider)?.label ?? account.provider;
            const syncModeLabel = account.syncMode === "idle" ? "IDLE 实时" : account.syncMode === "polling" ? `每 ${pollIntervalSeconds} 秒轮询` : "正在检测同步模式";
            return <article key={account.id} onDragOver={(event) => { if (draggingId && draggingId !== account.id) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; setDropTargetId(account.id); } }} onDrop={(event) => dropAccount(event, account.id)} className={`list-row ${styles.accountRow} ${syncing ? styles.syncing : ""} ${draggingId === account.id ? styles.accountRowDragging : ""} ${dropTargetId === account.id ? styles.accountRowDropTarget : ""}`}>
              <span className={styles.dragHandle} draggable={accounts.length > 1 && !reordering} onDragStart={(event) => startDragging(event, account.id)} onDragEnd={() => { setDraggingId(null); setDropTargetId(null); }}>
                <IconButton label={`拖动排序 ${account.email}`} disabled={reordering || accounts.length < 2} onKeyDown={(event) => { if (event.key === "ArrowUp" || event.key === "ArrowDown") { event.preventDefault(); moveByKeyboard(account.id, event.key === "ArrowUp" ? -1 : 1); } }}><GripVertical size={17} /></IconButton>
              </span>
              <div className={styles.accountOverview}>
                <div className={styles.accountIdentity}><span className={styles.mailAvatar}><Mail size={18} /></span><div><strong>{account.email}</strong><span>{providerLabel} · {account.imap.host} · {account.aliases.length} 个别名</span></div></div>
                <div className={styles.accountConnection}><Status status={syncing ? "connecting" : account.status} /><small>{syncModeLabel}</small>{account.lastError && <span className={styles.accountError} title={account.lastError}>{account.lastError}</span>}</div>
              </div>
              <dl className={styles.accountStats} aria-label={`${account.email} 邮箱统计`}>
                <div><dt>本地缓存</dt><dd>{account.messageCount ?? 0}<small>封</small></dd></div>
                <div><dt>未读邮件</dt><dd>{account.unreadCount ?? 0}<small>封</small></dd></div>
                <div><dt>自定义文件夹</dt><dd>{account.syncFolderCount ?? 0}<small>个</small></dd></div>
                <div><dt>最近同步</dt><dd><time dateTime={account.lastSyncedAt ?? undefined} title={formatDate(account.lastSyncedAt)}>{account.lastSyncedAt ? formatRelativeDate(account.lastSyncedAt, now) : "尚未同步"}</time></dd></div>
              </dl>
              <div className={styles.rowActions}>
                <IconButton label="测试连接" onClick={() => void test(account)}><ShieldCheck size={17} /></IconButton>
                <IconButton label="测试 SMTP" disabled={!account.smtp} onClick={() => void testSmtp(account)}><Send size={17} /></IconButton>
                <IconButton label="立即同步" disabled={syncing} onClick={() => void sync(account)}><RefreshCw className={syncing ? styles.rotating : ""} size={17} /></IconButton>
                <IconButton label="设置同步文件夹" onClick={() => setFolderAccount(account)}><FolderCog size={17} /></IconButton>
                <IconButton label="编辑账号" onClick={() => setEditing(account)}><Edit3 size={17} /></IconButton>
                <IconButton label="删除账号" className={styles.dangerIcon} onClick={() => setDeleting(account)}><Trash2 size={17} /></IconButton>
              </div>
              {syncing && <span className={styles.syncRail} aria-hidden="true" />}
            </article>;
          })}
        </div>}
      <AccountDialog open={editing !== null} account={editing === "new" ? null : editing} api={api} onOpenChange={(open) => !open && setEditing(null)} onSaved={async (message) => { setEditing(null); onNotice({ kind: "success", text: message }); await reload(); }} />
      <SyncFoldersDialog open={Boolean(folderAccount)} account={folderAccount} api={api} onOpenChange={(open) => !open && setFolderAccount(null)} onSaved={async () => { setFolderAccount(null); onNotice({ kind: "success", text: "同步文件夹已更新" }); await reload(); }} />
      <ConfirmDialog open={Boolean(deleting)} title="删除邮箱账号？" description={deleting ? `将永久删除 ${deleting.email} 的配置和本地邮件缓存，不影响 IMAP 服务器邮件。` : ""} confirmLabel="删除账号" danger onOpenChange={(open) => !open && setDeleting(null)} onConfirm={() => void remove()} />
    </section>
  );
}

function SyncFoldersDialog({ open, account, api, onOpenChange, onSaved }: { open: boolean; account: Account | null; api: ApiClient; onOpenChange: (open: boolean) => void; onSaved: () => void }) {
  const [data, setData] = useState<MailboxListResponse | null>(null);
  const [selected, setSelected] = useState<Map<string, SyncFolderConfig["mode"]>>(new Map());
  const [loading, setLoading] = useState(false); const [saving, setSaving] = useState(false);
  const [error, setError] = useState(""); const [confirmRemoval, setConfirmRemoval] = useState(false);

  const load = useCallback(async () => {
    if (!account) return;
    setLoading(true); setError("");
    try {
      const result = await api.request<MailboxListResponse>(`/accounts/${account.id}/mailboxes`);
      setData(result);
      setSelected(new Map(result.items.filter((item) => item.kind === "custom" && item.selectedMode).map((item) => [item.path, item.selectedMode!] as const)));
    } catch (reason) { setError(reason instanceof Error ? reason.message : "文件夹读取失败"); }
    finally { setLoading(false); }
  }, [account, api]);

  useEffect(() => { if (open) void load(); else { setData(null); setError(""); setConfirmRemoval(false); } }, [open, load]);

  const setFolder = (path: string, enabled: boolean, defaultMode: SyncFolderConfig["mode"] = "polling") => {
    setSelected((current) => {
      const next = new Map(current);
      if (enabled) next.set(path, defaultMode); else next.delete(path);
      return next;
    });
  };
  const setMode = (path: string, mode: SyncFolderConfig["mode"]) => setSelected((current) => new Map(current).set(path, mode));
  const persist = async () => {
    if (!account) return;
    setSaving(true); setError("");
    try {
      await api.request(`/accounts/${account.id}/sync-folders`, {
        method: "PUT", body: JSON.stringify({ folders: [...selected].map(([path, mode]) => ({ path, mode })) })
      });
      onSaved();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "同步文件夹保存失败"); }
    finally { setSaving(false); setConfirmRemoval(false); }
  };
  const requestSave = () => {
    const removesCache = data?.items.some((item) => item.kind === "custom" && item.selectedMode && !selected.has(item.path) && item.cachedMessageCount > 0);
    if (removesCache) setConfirmRemoval(true); else void persist();
  };
  const customCount = selected.size;
  const idleCount = [...selected.values()].filter((mode) => mode === "idle").length;

  return <><Dialog.Root open={open} onOpenChange={onOpenChange}><Dialog.Portal><Dialog.Overlay className={styles.overlay} /><Dialog.Content className={`${styles.dialog} ${styles.folderDialog}`}>
    <div className={styles.dialogHeader}><div><Dialog.Title>同步文件夹</Dialog.Title><Dialog.Description>{account?.email} · 收件箱和垃圾箱始终同步</Dialog.Description></div><Dialog.Close asChild><IconButton label="关闭"><X size={18} /></IconButton></Dialog.Close></div>
    {loading ? <div className={styles.folderState}><Spinner label="正在读取文件夹" /></div> : error && !data ? <div className={styles.folderState}><p className={styles.formError} role="alert"><CircleAlert size={15} />{error}</p><Button onClick={() => void load()}><RefreshCw size={16} />重试</Button></div> : data ? <>
      <div className={styles.folderSummary}><span>已选 {customCount}/20</span><span>IDLE {idleCount}/5</span></div>
      <div className={styles.folderList} role="group" aria-label="可同步的 IMAP 文件夹">
        {data.items.map((item) => {
          const checked = item.kind !== "custom" || selected.has(item.path);
          const mode = selected.get(item.path);
          const disableSelect = item.kind !== "custom" || (!checked && ((!item.available && !item.selectedMode) || customCount >= 20));
          return <div className={`${styles.folderRow} ${!item.available ? styles.folderMissing : ""}`} key={`${item.kind}:${item.path}`} style={{ "--folder-indent": `${Math.min(item.depth, 4) * 14}px` } as CSSProperties}>
            <label className={styles.folderChoice} title={item.path}>
              <input className="checkbox checkbox-sm" type="checkbox" checked={checked} disabled={disableSelect} onChange={(event) => setFolder(item.path, event.target.checked, item.selectedMode ?? "polling")} />
              <Folder size={16} /><span><strong>{item.name}</strong><small>{item.path}{!item.available ? " · 远端已缺失" : item.cachedMessageCount ? ` · 已缓存 ${item.cachedMessageCount} 封` : ""}</small></span>
            </label>
            {item.kind === "custom" && checked ? <div className={`join ${styles.folderMode}`} aria-label={`${item.path} 同步模式`}>
              <button type="button" className={`btn btn-xs join-item ${mode === "idle" ? styles.folderModeActive : ""}`} disabled={mode !== "idle" && idleCount >= 5} aria-pressed={mode === "idle"} onClick={() => setMode(item.path, "idle")}>IDLE</button>
              <button type="button" className={`btn btn-xs join-item ${mode === "polling" ? styles.folderModeActive : ""}`} aria-pressed={mode === "polling"} onClick={() => setMode(item.path, "polling")}>轮询</button>
            </div> : item.kind !== "custom" ? <span className={styles.folderFixed}>系统管理</span> : null}
          </div>;
        })}
        {!data.items.length && <div className={styles.folderState}>没有可同步的文件夹</div>}
      </div>
      {error && <p className={styles.formError} role="alert"><CircleAlert size={15} />{error}</p>}
      <div className={styles.dialogFooter}><Dialog.Close asChild><Button type="button">取消</Button></Dialog.Close><Button variant="primary" disabled={saving} onClick={requestSave}>{saving ? <Spinner label="正在保存" /> : "保存配置"}</Button></div>
    </> : null}
  </Dialog.Content></Dialog.Portal></Dialog.Root>
  <ConfirmDialog open={confirmRemoval} title="移除本地文件夹缓存？" description="取消同步会删除这些文件夹的本地邮件缓存，不会删除 IMAP 服务器上的邮件。" confirmLabel="移除并保存" danger onOpenChange={setConfirmRemoval} onConfirm={() => void persist()} /></>;
}

function Status({ status }: { status: Account["status"] }) {
  const labels = { pending: "等待连接", connecting: "同步中", connected: "已连接", warning: "有警告", error: "连接错误" };
  const Icon = status === "connected" ? CircleCheck : status === "warning" || status === "error" ? CircleAlert : RefreshCw;
  const color = status === "connected" ? "badge-success" : status === "warning" ? "badge-warning" : status === "error" ? "badge-error" : "badge-neutral";
  return <span className={`badge badge-soft badge-sm ${color} ${styles.status} ${styles[`status_${status}`]}`}><Icon size={14} className={status === "connecting" ? styles.rotating : ""} />{labels[status]}</span>;
}

function AccountDialog({ open, account, api, onOpenChange, onSaved }: { open: boolean; account: Account | null; api: ApiClient; onOpenChange: (open: boolean) => void; onSaved: (message: string) => void }) {
  const [email, setEmail] = useState(""); const [password, setPassword] = useState("");
  const [aliases, setAliases] = useState<string[]>([]); const [aliasInput, setAliasInput] = useState("");
  const [provider, setProvider] = useState<ProviderId>("auto"); const [host, setHost] = useState("");
  const [port, setPort] = useState("993"); const [secure, setSecure] = useState(true);
  const [smtpHost, setSmtpHost] = useState(""); const [smtpPort, setSmtpPort] = useState("465"); const [smtpSecure, setSmtpSecure] = useState(true);
  const [defaultSenderName, setDefaultSenderName] = useState("");
  const [advanced, setAdvanced] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setEmail(account?.email ?? ""); setPassword(""); setAliases(account?.aliases ?? []); setAliasInput(""); setProvider(account?.provider ?? "auto");
    setHost(account?.imap.host ?? ""); setPort(String(account?.imap.port ?? 993)); setSecure(account?.imap.secure ?? true);
    setSmtpHost(account?.smtp?.host ?? ""); setSmtpPort(String(account?.smtp?.port ?? 465)); setSmtpSecure(account?.smtp?.secure ?? true);
    setDefaultSenderName(account?.defaultSenderName ?? "");
    setAdvanced(account?.provider === "custom"); setError("");
  }, [open, account]);

  const addAliases = (raw = aliasInput): boolean => {
    const values = raw.split(/[\n,]/u).map((value) => value.trim().toLowerCase()).filter(Boolean);
    if (!values.length) return true;
    const invalid = values.find((value) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value));
    if (invalid) { setError(`别名邮箱格式无效：${invalid}`); return false; }
    if (values.some((value) => value === email.trim().toLowerCase())) { setError("别名邮箱不能与主邮箱相同"); return false; }
    const next = [...aliases, ...values];
    if (new Set(next).size !== next.length) { setError("别名邮箱不能重复"); return false; }
    if (next.length > 50) { setError("最多配置 50 个别名邮箱"); return false; }
    setAliases(next); setAliasInput(""); setError("");
    return true;
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError("");
    let submittedAliases = aliases;
    if (aliasInput.trim()) {
      if (!addAliases()) { setBusy(false); return; }
      submittedAliases = [...aliases, ...aliasInput.split(/[\n,]/u).map((value) => value.trim().toLowerCase()).filter(Boolean)];
    }
    const imap = { provider, ...(advanced && host ? { host } : {}), ...(advanced ? { port: Number(port), secure } : {}) };
    const smtp = advanced ? (smtpHost.trim() ? { host: smtpHost, port: Number(smtpPort), secure: smtpSecure } : null) : undefined;
    try {
      if (account) {
        const body: AccountUpdate = {};
        const normalizedEmail = email.trim().toLowerCase();
        const normalizedSenderName = defaultSenderName.trim() || null;
        if (normalizedEmail !== account.email) body.email = normalizedEmail;
        if (JSON.stringify(submittedAliases) !== JSON.stringify(account.aliases)) body.aliases = submittedAliases;
        if (provider !== account.provider || (advanced && (host.trim() !== account.imap.host || Number(port) !== account.imap.port || secure !== account.imap.secure))) body.imap = imap;
        if (smtp !== undefined && JSON.stringify(smtp) !== JSON.stringify(account.smtp)) body.smtp = smtp;
        if (normalizedSenderName !== account.defaultSenderName) body.defaultSenderName = normalizedSenderName;
        if (password) body.password = password;
        if (!Object.keys(body).length) { onSaved("邮箱账号未修改"); return; }
        await api.request(`/accounts/${account.id}`, { method: "PATCH", body: JSON.stringify(body) });
        onSaved("邮箱账号已更新");
      } else {
        const body: AccountInput = { email, aliases: submittedAliases, password, imap, defaultSenderName: defaultSenderName.trim() || null, ...(smtp !== undefined ? { smtp } : {}) };
        await api.request("/accounts", { method: "POST", body: JSON.stringify(body) });
        onSaved("邮箱账号已添加");
      }
    } catch (reason) { setError(reason instanceof Error ? reason.message : "保存失败"); }
    finally { setBusy(false); }
  };

  const changeProvider = (value: ProviderId) => {
    setProvider(value);
    setAdvanced(value === "custom");
    setSmtpHost(""); setSmtpPort("465"); setSmtpSecure(true);
  };

  return <Dialog.Root open={open} onOpenChange={onOpenChange}><Dialog.Portal><Dialog.Overlay className={styles.overlay} /><Dialog.Content className={styles.dialog}>
    <div className={styles.dialogHeader}><div><Dialog.Title>{account ? "编辑邮箱" : "添加邮箱"}</Dialog.Title><Dialog.Description>{account ? "留空密码将保留现有授权码" : "使用邮箱密码或服务商授权码连接"}</Dialog.Description></div><Dialog.Close asChild><IconButton label="关闭"><X size={18} /></IconButton></Dialog.Close></div>
    <form className={styles.accountForm} onSubmit={submit}>
      <div className={`fieldset ${styles.field}`}><label className="fieldset-legend" htmlFor="account-email">邮箱地址</label><input className="input input-sm" id="account-email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} required autoFocus /></div>
      <div className={`fieldset ${styles.field}`}><label className="fieldset-legend" htmlFor="account-alias">别名邮箱</label><div className={styles.aliasInput}><input className="input input-sm" id="account-alias" type="email" value={aliasInput} onChange={(event) => setAliasInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === ",") { event.preventDefault(); addAliases(); } }} placeholder="alias@example.com" /><IconButton type="button" label="添加别名" onClick={() => addAliases()}><Plus size={17} /></IconButton></div>{aliases.length > 0 && <div className={styles.aliasList}>{aliases.map((alias) => <span className="badge badge-ghost badge-sm" key={alias}>{alias}<button type="button" aria-label={`移除别名 ${alias}`} onClick={() => setAliases((values) => values.filter((value) => value !== alias))}><X size={14} /></button></span>)}</div>}</div>
      <div className={`fieldset ${styles.field}`}><label className="fieldset-legend" htmlFor="account-password">密码 / 授权码</label><input className="input input-sm" id="account-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} required={!account} autoComplete="new-password" placeholder={account ? "留空表示不修改" : "请输入授权码"} /></div>
      <div className={`fieldset ${styles.field}`}><label className="fieldset-legend" htmlFor="account-provider">邮箱服务商</label><Select.Root value={provider} onValueChange={(value) => changeProvider(value as ProviderId)} disabled={busy}>
        <Select.Trigger className={styles.providerSelectTrigger} id="account-provider"><Select.Value /><Select.Icon className={styles.providerSelectIcon}><ChevronDown size={16} /></Select.Icon></Select.Trigger>
        <Select.Portal><Select.Content className={styles.providerSelectContent} position="popper" sideOffset={5} collisionPadding={12}><Select.Viewport className={styles.providerSelectViewport}>
          {PROVIDERS.map((item) => <Select.Item className={styles.providerSelectItem} key={item.value} value={item.value}><Select.ItemText>{item.label}</Select.ItemText><Select.ItemIndicator className={styles.providerSelectIndicator}><Check size={15} /></Select.ItemIndicator></Select.Item>)}
        </Select.Viewport></Select.Content></Select.Portal>
      </Select.Root></div>
      <div className={`fieldset ${styles.field}`}><label className="fieldset-legend" htmlFor="account-sender-name">默认发件人名称</label><input className="input input-sm" id="account-sender-name" maxLength={200} value={defaultSenderName} onChange={(event) => setDefaultSenderName(event.target.value)} placeholder="继承系统设置" /></div>
      <button type="button" className={styles.disclosure} onClick={() => setAdvanced((value) => !value)} aria-expanded={advanced}><SlidersHorizontal size={16} />高级 IMAP / SMTP 配置<span>{advanced ? "收起" : "展开"}</span></button>
      {advanced && <motion.div className={styles.advancedFields} initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }}>
        <div className={styles.advancedHeading}>IMAP</div>
        <div className={`fieldset ${styles.field}`}><label className="fieldset-legend" htmlFor="imap-host">主机</label><input className="input input-sm" id="imap-host" value={host} onChange={(event) => setHost(event.target.value)} placeholder="imap.example.com" required={provider === "custom"} /></div>
        <div className={`fieldset ${styles.field}`}><label className="fieldset-legend" htmlFor="imap-port">端口</label><input className="input input-sm" id="imap-port" type="number" min="1" max="65535" value={port} onChange={(event) => setPort(event.target.value)} /></div>
        <label className={styles.checkbox}><span>隐式 TLS</span><input className="toggle toggle-sm" type="checkbox" checked={secure} onChange={(event) => setSecure(event.target.checked)} /></label>
        <div className={styles.advancedHeading}>SMTP</div>
        <div className={`fieldset ${styles.field}`}><label className="fieldset-legend" htmlFor="smtp-host">主机</label><input className="input input-sm" id="smtp-host" value={smtpHost} onChange={(event) => setSmtpHost(event.target.value)} placeholder="smtp.example.com" /></div>
        <div className={`fieldset ${styles.field}`}><label className="fieldset-legend" htmlFor="smtp-port">端口</label><input className="input input-sm" id="smtp-port" type="number" min="1" max="65535" value={smtpPort} onChange={(event) => setSmtpPort(event.target.value)} /></div>
        <label className={styles.checkbox}><span>隐式 TLS</span><input className="toggle toggle-sm" type="checkbox" checked={smtpSecure} onChange={(event) => setSmtpSecure(event.target.checked)} /></label>
      </motion.div>}
      {error && <p className={styles.formError} role="alert"><CircleAlert size={15} />{error}</p>}
      <div className={styles.dialogFooter}><Dialog.Close asChild><Button type="button">取消</Button></Dialog.Close><Button variant="primary" disabled={busy}>{busy ? <Spinner label="正在保存" /> : "保存账号"}</Button></div>
    </form>
  </Dialog.Content></Dialog.Portal></Dialog.Root>;
}

function MessagesPage({ api, accounts, accountId, onAccountChange, revision, onLocalMessageUpdate, onLocalMessageUpdateFailed, onNotice }: { api: ApiClient; accounts: Account[]; accountId: string; onAccountChange: (accountId: string) => void; revision: number; onLocalMessageUpdate: (messageId: string) => void; onLocalMessageUpdateFailed: (messageId: string) => void; onNotice: (notice: { kind: "success" | "error"; text: string }) => void }) {
  const [view, setView] = useState<MessageView>("all");
  const [secondaryFilters, setSecondaryFilters] = useState<MessageSecondaryFilter[]>([]);
  const [items, setItems] = useState<MessageSummary[]>([]); const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selected, setSelected] = useState<string | null>(null); const [detail, setDetail] = useState<MessageDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false); const [cursor, setCursor] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null); const [history, setHistory] = useState<Array<string | null>>([]);
  const [total, setTotal] = useState(0);
  const [pageSize, setPageSize] = useState<number | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);
  const [listWidth, setListWidth] = useState(initialMessageListWidth);
  const [compactFilters, setCompactFilters] = useState(false);
  const [autoLoadRemoteImages, setAutoLoadRemoteImages] = useState(false);
  const [remoteImageAllowlist, setRemoteImageAllowlist] = useState<string[]>([]);
  const [now, setNow] = useState(Date.now());
  const workspaceRef = useRef<HTMLElement | null>(null);
  const filterBarRef = useRef<HTMLDivElement | null>(null);
  const viewGroupRef = useRef<HTMLDivElement | null>(null);
  const secondaryFilterGroupRef = useRef<HTMLDivElement | null>(null);
  const secondaryFilterWidthRef = useRef(0);
  const filterDropdownRef = useRef<HTMLDetailsElement | null>(null);

  useEffect(() => {
    api.request<Settings>("/settings")
      .then((value) => { setPageSize(value.pageSize ?? 100); setAutoLoadRemoteImages(value.autoLoadRemoteImages ?? false); setRemoteImageAllowlist(value.remoteImageAllowlist ?? []); })
      .catch((error) => { setPageSize(100); setAutoLoadRemoteImages(false); setRemoteImageAllowlist([]); onNotice({ kind: "error", text: error instanceof Error ? error.message : "分页设置加载失败" }); });
  }, [api, onNotice]);

  const load = useCallback(async (background = false) => {
    if (pageSize === null) return;
    if (background) setRefreshing(true); else setLoading(true);
    const query = new URLSearchParams({ view, limit: String(pageSize) });
    secondaryFilters.forEach((filter) => query.append("filter", filter));
    if (accountId) query.set("accountId", accountId); if (cursor) query.set("cursor", cursor);
    try { const result = await api.request<MessageListResponse>(`/messages?${query}`); setItems(result.items); setNextCursor(result.nextCursor); setTotal(result.total ?? result.items.length); }
    catch (error) { onNotice({ kind: "error", text: error instanceof Error ? error.message : "邮件加载失败" }); }
    finally { if (background) setRefreshing(false); else setLoading(false); }
  }, [accountId, api, cursor, onNotice, pageSize, revision, secondaryFilters, view]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { setCursor(null); setHistory([]); setSelected(null); setDetail(null); }, [accountId, secondaryFilters, view]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    const closeFilterDropdown = (event: PointerEvent) => {
      const dropdown = filterDropdownRef.current;
      if (!dropdown?.open || (event.target instanceof Node && dropdown.contains(event.target))) return;
      dropdown.removeAttribute("open");
    };
    document.addEventListener("pointerdown", closeFilterDropdown, true);
    return () => document.removeEventListener("pointerdown", closeFilterDropdown, true);
  }, []);
  useLayoutEffect(() => {
    const filterBar = filterBarRef.current;
    const viewGroup = viewGroupRef.current;
    const secondaryGroup = secondaryFilterGroupRef.current;
    if (!filterBar || !viewGroup || !secondaryGroup) return;
    const measure = () => {
      const availableWidth = filterBar.clientWidth;
      if (secondaryGroup.offsetWidth > 0) secondaryFilterWidthRef.current = secondaryGroup.offsetWidth;
      const requiredWidth = viewGroup.offsetWidth + secondaryFilterWidthRef.current + 5;
      if (availableWidth <= 0 || viewGroup.offsetWidth <= 0 || secondaryFilterWidthRef.current <= 0) return;
      const shouldCompact = requiredWidth > availableWidth;
      if (!shouldCompact) filterDropdownRef.current?.removeAttribute("open");
      setCompactFilters(shouldCompact);
    };
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(filterBar);
    observer.observe(viewGroup);
    observer.observe(secondaryGroup);
    return () => observer.disconnect();
  }, []);

  const mark = async (message: MessageSummary | MessageDetail, read: boolean) => {
    onLocalMessageUpdate(message.id);
    try { await api.request(`/messages/${message.id}/read`, { method: "PATCH", body: JSON.stringify({ read }) }); setItems((rows) => rows.map((row) => row.id === message.id ? { ...row, read } : row)); setDetail((value) => value?.id === message.id ? { ...value, read } : value); }
    catch (error) { onLocalMessageUpdateFailed(message.id); onNotice({ kind: "error", text: error instanceof Error ? error.message : "标记失败" }); }
  };

  const openMessage = async (message: MessageSummary) => {
    if (selected === message.id && (detailLoading || detail?.id === message.id)) return;
    setSelected(message.id); setDetailLoading(true);
    try {
      const value = await api.request<MessageDetail>(`/messages/${message.id}`);
      setDetail(value); setDetailLoading(false);
      if (!message.read) await mark(value, true);
    } catch (error) { onNotice({ kind: "error", text: error instanceof Error ? error.message : "邮件详情加载失败" }); }
    finally { setDetailLoading(false); }
  };

  const markAll = async () => {
    const targetAccountIds = accountId ? [accountId] : accounts.map((account) => account.id);
    if (!targetAccountIds.length) return;
    const outcomes = await Promise.all(targetAccountIds.map(async (targetAccountId) => {
      try {
        const result = await api.request<{ count: number; failedFolders: string[] }>(`/accounts/${targetAccountId}/messages/read-all`, { method: "POST" });
        return { targetAccountId, result, error: null };
      } catch (error) { return { targetAccountId, result: null, error }; }
    }));
    const successful = outcomes.filter((outcome) => outcome.result);
    const count = successful.reduce((total, outcome) => total + (outcome.result?.count ?? 0), 0);
    const hasFailures = outcomes.some((outcome) => outcome.error || outcome.result?.failedFolders.length);
    if (!successful.length) {
      const firstError = outcomes.find((outcome) => outcome.error)?.error;
      onNotice({ kind: "error", text: firstError instanceof Error ? firstError.message : "全部已读失败" });
      return;
    }
    onNotice({ kind: hasFailures ? "error" : "success", text: hasFailures ? `已处理 ${count} 封，部分账号或文件夹失败` : `已标记 ${count} 封邮件` });
    setConfirmAll(false); await load();
  };

  const canMarkAll = items.some((item) => !item.read) || (accountId
    ? (accounts.find((account) => account.id === accountId)?.unreadCount ?? 0) > 0
    : accounts.some((account) => account.unreadCount > 0));
  const toggleSecondaryFilter = (filter: MessageSecondaryFilter) => {
    setSecondaryFilters((current) => current.includes(filter)
      ? current.filter((value) => value !== filter)
      : [...current, filter]);
  };
  const updateListWidth = useCallback((value: number) => {
    setListWidth(value);
    storeLayoutWidth("messageList", value);
  }, []);
  const currentPage = history.length + 1;
  const totalPages = Math.max(1, Math.ceil(total / (pageSize ?? 100)));

  return <section ref={workspaceRef} className={styles.mailWorkspace} style={{ "--mail-list-width": `${listWidth}px` } as CSSProperties}>
    <div className={`${styles.mailListPane} ${selected ? styles.mobileHidden : ""}`}>
      <div className={styles.mailControls}>
        <select className={`select select-sm ${styles.mobileAccountSelect}`} aria-label="筛选邮箱账号" value={accountId} onChange={(event) => onAccountChange(event.target.value)}><option value="">聚合收件箱</option>{accounts.map((account) => <option key={account.id} value={account.id}>{account.email}</option>)}</select>
        <div ref={filterBarRef} className={styles.filterBar}>
          <div ref={viewGroupRef} className={`join ${styles.viewGroup}`} role="tablist" aria-label="邮件视图">{MESSAGE_VIEWS.map((item) => <button key={item.value} role="tab" aria-selected={view === item.value} className={`join-item btn btn-sm ${styles.viewButton} ${view === item.value ? `btn-primary btn-active ${styles.viewButtonActive}` : ""}`} onClick={() => setView(item.value)}>{item.label}</button>)}</div>
          <div ref={secondaryFilterGroupRef} className={`join ${styles.secondaryFilterGroup} ${compactFilters ? styles.secondaryFilterGroupHidden : ""}`} aria-label="邮件内容筛选" aria-hidden={compactFilters || undefined}>{MESSAGE_SECONDARY_FILTERS.map((item) => <button key={item.value} type="button" tabIndex={compactFilters ? -1 : undefined} aria-pressed={secondaryFilters.includes(item.value)} className={`join-item btn btn-sm ${styles.secondaryFilterButton} ${secondaryFilters.includes(item.value) ? styles.secondaryFilterButtonActive : ""}`} onClick={() => toggleSecondaryFilter(item.value)}>{item.label}</button>)}</div>
          <details ref={filterDropdownRef} className={`dropdown dropdown-end ${styles.filterDropdown} ${compactFilters ? styles.filterDropdownVisible : ""}`} aria-hidden={!compactFilters || undefined}>
            <summary role="button" tabIndex={compactFilters ? undefined : -1} className={`btn btn-sm ${styles.filterDropdownTrigger}`} aria-label={`更多筛选，已选 ${secondaryFilters.length} 项`} onKeyDown={(event) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              event.currentTarget.parentElement?.toggleAttribute("open");
            }}><SlidersHorizontal size={15} />{secondaryFilters.length > 0 && <span>{secondaryFilters.length}</span>}</summary>
            <ul className={`menu dropdown-content ${styles.filterMenu}`} aria-label="更多筛选选项">{MESSAGE_SECONDARY_FILTERS.map((item) => {
              const FilterIcon = item.icon;
              return <li key={item.value}><label><input className="checkbox checkbox-sm" type="checkbox" checked={secondaryFilters.includes(item.value)} onChange={() => toggleSecondaryFilter(item.value)} /><FilterIcon size={15} />{item.label}</label></li>;
            })}</ul>
          </details>
        </div>
        <IconButton label="刷新邮件列表" disabled={loading || refreshing} onClick={() => void load(true)}><RefreshCw size={17} className={refreshing ? styles.rotating : ""} /></IconButton>
        <IconButton label="全部已读" disabled={!canMarkAll} onClick={() => setConfirmAll(true)}><MailOpen size={17} /></IconButton>
        <span className={styles.srOnly} role="status" aria-live="polite">{refreshing ? "正在刷新邮件列表" : ""}</span>
      </div>
      <div className={styles.messageList} aria-busy={loading}>
        {loading ? <div className={styles.centerState}><Spinner /></div> : items.length === 0 ? <EmptyState icon={<SearchX size={27} />} title="没有符合条件的邮件" /> : items.map((message) => <button key={message.id} className={`list-row ${styles.messageRow} ${selected === message.id ? styles.messageSelected : ""} ${message.read ? styles.messageRead : ""}`} onClick={() => void openMessage(message)}>
          <span className={styles.unreadDot} aria-label={message.read ? "已读" : "未读"} />
          <span className={styles.messageMain}><MessageMeta message={message} now={now} /><span className={styles.messageSubject}>{message.subject}</span><span className={styles.messagePreview}>{message.preview || "无正文预览"}</span></span>
        </button>)}
      </div>
      <div className={styles.pagination}><Button variant="quiet" disabled={!history.length} onClick={() => { const previous = [...history]; const value = previous.pop() ?? null; setHistory(previous); setCursor(value); }}><ChevronLeft size={16} />上一页</Button><span className={styles.paginationInfo} aria-label={`第 ${currentPage} / ${totalPages} 页，共 ${total} 封，每页 ${pageSize ?? 100} 封`}><strong>第 {currentPage} / {totalPages} 页</strong><span>共 {total} 封 · 每页 {pageSize ?? 100} 封</span></span><Button variant="quiet" disabled={!nextCursor} onClick={() => { setHistory((values) => [...values, cursor]); setCursor(nextCursor); }} >下一页<ChevronRight size={16} /></Button></div>
    </div>
    <ResizeHandle value={listWidth} min={MESSAGE_LIST_MIN_WIDTH} max={() => Math.max(MESSAGE_LIST_MIN_WIDTH, (workspaceRef.current?.clientWidth ?? window.innerWidth) - DETAIL_MIN_WIDTH)} label="调整邮件列表宽度" onChange={updateListWidth} />
    <div className={`${styles.detailPane} ${selected ? styles.detailVisible : ""}`}>
      {detailLoading ? <div className={styles.centerState}><Spinner label="正在读取邮件" /></div> : detail ? <MessageDetailView api={api} message={detail} autoLoadRemoteImages={autoLoadRemoteImages} remoteImageAllowlist={remoteImageAllowlist} onBack={() => { setSelected(null); setDetail(null); }} onMark={(read) => void mark(detail, read)} /> : <EmptyState icon={<FileText size={28} />} title="选择一封邮件查看内容" />}
    </div>
    <ConfirmDialog open={confirmAll} title="将缓存邮件全部标记为已读？" description={accountId ? "操作会同步更新当前账号已缓存的收件箱和垃圾箱邮件。" : "操作会同步更新所有账号已缓存的收件箱和垃圾箱邮件。"} confirmLabel="全部已读" onOpenChange={setConfirmAll} onConfirm={() => void markAll()} />
  </section>;
}

function MessageMeta({ message, now }: { message: MessageSummary; now: number }) {
  const metaRef = useRef<HTMLSpanElement | null>(null);
  const signalsRef = useRef<HTMLSpanElement | null>(null);
  const timeRef = useRef<HTMLTimeElement | null>(null);
  const probeRef = useRef<HTMLSpanElement | null>(null);
  const senderProbeRef = useRef<HTMLSpanElement | null>(null);
  const [showForwardedVia, setShowForwardedVia] = useState(false);

  useLayoutEffect(() => {
    const meta = metaRef.current;
    if (!meta || !message.forwardedVia || !message.labels.includes("forwarded")) {
      setShowForwardedVia(false);
      return;
    }
    const measure = () => {
      const signals = signalsRef.current;
      const time = timeRef.current;
      const probe = probeRef.current;
      const senderProbe = senderProbeRef.current;
      if (!signals || !time || !probe || !senderProbe) return;
      const labels = signals.querySelector<HTMLElement>(`:scope > .${styles.messageLabelsCompact}`);
      const labelItems = labels ? [...labels.querySelectorAll<HTMLElement>(":scope > [data-label]")] : [];
      const otherLabelsWidth = labelItems.filter((item) => item.dataset.label !== "forwarded")
        .reduce((total, item) => total + item.offsetWidth, 0);
      const labelGap = labelItems.length > 1 ? (labelItems.length - 1) * 5 : 0;
      const outsideSignals = [...signals.children].filter((item) => item !== labels) as HTMLElement[];
      const signalsWidth = otherLabelsWidth + probe.offsetWidth + labelGap
        + outsideSignals.reduce((total, item) => total + item.getBoundingClientRect().width, 0)
        + Math.max(0, outsideSignals.length) * 5;
      const fullMetaWidth = signalsWidth + time.offsetWidth + 5;
      setShowForwardedVia(canShowFullForwardedVia(meta.clientWidth, senderProbe.offsetWidth, fullMetaWidth));
    };
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(meta);
    return () => observer.disconnect();
  }, [message.forwardedVia, message.hasAttachments, message.folder, message.labels]);

  return <span className={styles.messageMeta} ref={metaRef}>
    <strong>{senderLabel(message)}</strong>
    <span className={styles.messageMetaRight}>
      <span className={styles.messageSignals} ref={signalsRef}>
        {message.labels.length > 0 && <MessageLabels labels={message.labels} forwardedVia={message.forwardedVia} compact showForwardedVia={showForwardedVia} />}
        {message.hasAttachments && <Paperclip size={14} aria-label="包含附件" />}
        {message.folder === "junk" && <Archive size={14} aria-label="垃圾箱" />}
      </span>
      <time ref={timeRef} dateTime={message.displayTime} title={formatDate(message.displayTime)}>{formatRelativeDate(message.displayTime, now)}</time>
    </span>
    <span ref={senderProbeRef} className={styles.senderWidthProbe} data-sender={senderLabel(message)} aria-hidden="true" />
    {message.forwardedVia && message.labels.includes("forwarded") && <span ref={probeRef} className={`badge badge-soft badge-xs ${styles.forwardedViaProbe}`} data-email={message.forwardedVia} aria-hidden="true"><Forward size={11} /></span>}
  </span>;
}

type AttachmentDownloadStatus = "waiting" | "downloading" | "completed" | "error";

export function formatAttachmentSize(size: number | null): string | null {
  if (size === null || !Number.isFinite(size) || size < 0) return null;
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(size < 10 * 1024 ? 1 : 0)} KB`;
  return `${(size / (1024 * 1024)).toFixed(size < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

export function MessageDetailView({ api, message, autoLoadRemoteImages = false, remoteImageAllowlist = [], onBack, onMark }: { api: ApiClient; message: MessageDetail; autoLoadRemoteImages?: boolean; remoteImageAllowlist?: string[]; onBack: () => void; onMark: (read: boolean) => void }) {
  const [remoteImagesForMessage, setRemoteImagesForMessage] = useState<string | null>(null);
  const [pendingLink, setPendingLink] = useState<{ url: string; label: string } | null>(null);
  const [unsubscribePending, setUnsubscribePending] = useState(false);
  const [copyState, setCopyState] = useState<"copied" | "error" | null>(null);
  const [addressCopyState, setAddressCopyState] = useState<{ target: string; address: string; status: "copied" | "error" } | null>(null);
  const [metadataCollapsed, setMetadataCollapsed] = useState(false);
  const [attachmentDownloads, setAttachmentDownloads] = useState<Record<string, AttachmentDownloadStatus>>({});
  const lastBodyScrollTop = useRef(0);
  const frameCleanupRef = useRef<(() => void) | null>(null);
  const addressCopyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const addressCopyRequestRef = useRef(0);
  const attachmentControllersRef = useRef(new Map<string, AbortController>());
  const attachmentTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const reducedMotion = useReducedMotion();
  const metadataTransition = { duration: reducedMotion ? 0 : 0.14, ease: [0.23, 1, 0.32, 1] as const };
  const bodyLayoutTransition = { layout: { duration: reducedMotion ? 0 : 0.18, ease: [0.23, 1, 0.32, 1] as const } };
  const hasRemoteImages = useMemo(() => hasRemoteImageReferences(message.html ?? ""), [message.html]);
  const senderAutoLoadsRemoteImages = useMemo(() => senderAllowsRemoteImages(message.from, remoteImageAllowlist), [message.from, remoteImageAllowlist]);
  const remoteImagesLoaded = autoLoadRemoteImages || senderAutoLoadsRemoteImages || remoteImagesForMessage === message.id;
  const srcDoc = useMemo(() => message.html ? buildMessageSrcDoc(message.html, remoteImagesLoaded) : "", [message.html, remoteImagesLoaded]);
  useEffect(() => {
    setPendingLink(null);
    setUnsubscribePending(false);
    setCopyState(null);
    setAddressCopyState(null);
    addressCopyRequestRef.current += 1;
    if (addressCopyTimerRef.current) clearTimeout(addressCopyTimerRef.current);
    addressCopyTimerRef.current = null;
    setMetadataCollapsed(false);
    setAttachmentDownloads({});
    for (const controller of attachmentControllersRef.current.values()) controller.abort();
    attachmentControllersRef.current.clear();
    for (const timer of attachmentTimersRef.current.values()) clearTimeout(timer);
    attachmentTimersRef.current.clear();
    lastBodyScrollTop.current = 0;
    return () => {
      frameCleanupRef.current?.();
      frameCleanupRef.current = null;
      if (addressCopyTimerRef.current) clearTimeout(addressCopyTimerRef.current);
      for (const controller of attachmentControllersRef.current.values()) controller.abort();
      attachmentControllersRef.current.clear();
      for (const timer of attachmentTimersRef.current.values()) clearTimeout(timer);
      attachmentTimersRef.current.clear();
    };
  }, [message.id]);
  const handleBodyScroll = useCallback((scrollTop: number) => {
    const previousScrollTop = lastBodyScrollTop.current;
    lastBodyScrollTop.current = scrollTop;
    if (scrollTop <= 8) {
      setMetadataCollapsed(false);
    } else if (scrollTop > 24 && scrollTop > previousScrollTop) {
      setMetadataCollapsed(true);
    } else if (scrollTop < previousScrollTop) {
      setMetadataCollapsed(false);
    }
  }, []);
  const handleFrameLoad = (frame: HTMLIFrameElement) => {
    frameCleanupRef.current?.();
    const document = frame.contentDocument;
    if (!document) return;
    const handleClick = (event: MouseEvent) => {
      const anchor = (event.target as Element | null)?.closest?.("a[data-safe-href]") as HTMLAnchorElement | null;
      if (!anchor) return;
      event.preventDefault();
      event.stopPropagation();
      const url = safeMessageLinkUrl(anchor.getAttribute("data-safe-href") ?? "");
      if (url) setPendingLink({ url, label: (anchor.textContent?.replace(/\s+/g, " ").trim() || url).slice(0, 160) });
    };
    const handleScroll = () => handleBodyScroll(document.scrollingElement?.scrollTop ?? document.documentElement.scrollTop ?? document.body.scrollTop);
    document.addEventListener("click", handleClick);
    document.addEventListener("scroll", handleScroll);
    handleScroll();
    frameCleanupRef.current = () => {
      document.removeEventListener("click", handleClick);
      document.removeEventListener("scroll", handleScroll);
    };
  };
  const openPendingLink = () => {
    const url = pendingLink ? safeMessageLinkUrl(pendingLink.url) : null;
    if (url) window.open(url, "_blank", "noopener,noreferrer");
    setPendingLink(null);
  };
  const copyVerificationCode = async () => {
    addressCopyRequestRef.current += 1;
    if (addressCopyTimerRef.current) clearTimeout(addressCopyTimerRef.current);
    addressCopyTimerRef.current = null;
    setAddressCopyState(null);
    if (!message.verificationCode || !navigator.clipboard) { setCopyState("error"); return; }
    try { await navigator.clipboard.writeText(message.verificationCode); setCopyState("copied"); }
    catch { setCopyState("error"); }
  };
  const copyAddress = async (target: string, address: string) => {
    const request = ++addressCopyRequestRef.current;
    setCopyState(null);
    if (addressCopyTimerRef.current) clearTimeout(addressCopyTimerRef.current);
    addressCopyTimerRef.current = null;
    setAddressCopyState(null);
    const showFeedback = (status: "copied" | "error") => {
      if (request !== addressCopyRequestRef.current) return;
      setAddressCopyState({ target, address, status });
      addressCopyTimerRef.current = setTimeout(() => {
        setAddressCopyState((current) => current?.target === target && current.address === address ? null : current);
        addressCopyTimerRef.current = null;
      }, status === "copied" ? 1600 : 2600);
    };
    if (!navigator.clipboard?.writeText) { showFeedback("error"); return; }
    try {
      await navigator.clipboard.writeText(address);
      showFeedback("copied");
    } catch {
      showFeedback("error");
    }
  };
  const addressList = (values: MessageDetail["to"], group: "from" | "to" | "cc") => values.length > 0 ? values.map((item, index) => {
    const target = `${group}-${index}`;
    const status = addressCopyState?.target === target ? addressCopyState.status : null;
    const title = status === "copied" ? `已复制 ${item.address}` : status === "error" ? `复制失败，点击重试 ${item.address}` : `点击复制 ${item.address}`;
    const Icon = status === "copied" ? Check : status === "error" ? CircleAlert : Copy;
    return <span className={styles.addressEntry} key={`${item.address}-${index}`}>{index > 0 && ", "}{item.name && <>{item.name} </>}<button type="button" className={styles.addressCopyButton} data-copy-state={status ?? undefined} aria-label={`复制邮箱地址 ${item.address}`} title={title} onClick={() => void copyAddress(target, item.address)}><span>{item.name ? `<${item.address}>` : item.address}</span><Icon size={12} aria-hidden="true" /></button></span>;
  }) : "—";
  const openUnsubscribeLink = () => {
    if (unsubscribeUrl) window.open(unsubscribeUrl, "_blank", "noopener,noreferrer");
    setUnsubscribePending(false);
  };
  const downloadAttachment = async (attachment: MessageDetail["attachments"][number]) => {
    if (!attachment.id) return;
    const currentController = attachmentControllersRef.current.get(attachment.id);
    if (currentController) {
      currentController.abort();
      attachmentControllersRef.current.delete(attachment.id);
      setAttachmentDownloads((current) => { const next = { ...current }; delete next[attachment.id!]; return next; });
      return;
    }
    const controller = new AbortController();
    attachmentControllersRef.current.set(attachment.id, controller);
    setAttachmentDownloads((current) => ({ ...current, [attachment.id!]: "waiting" }));
    try {
      const blob = await api.download(`/messages/${message.id}/attachments/${encodeURIComponent(attachment.id)}`, controller.signal, () => {
        setAttachmentDownloads((current) => ({ ...current, [attachment.id!]: "downloading" }));
      });
      if (controller.signal.aborted) return;
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = attachment.filename;
      link.click();
      URL.revokeObjectURL(url);
      setAttachmentDownloads((current) => ({ ...current, [attachment.id!]: "completed" }));
      const timer = setTimeout(() => {
        setAttachmentDownloads((current) => { const next = { ...current }; delete next[attachment.id!]; return next; });
        attachmentTimersRef.current.delete(attachment.id!);
      }, 1600);
      attachmentTimersRef.current.set(attachment.id, timer);
    } catch (error) {
      if (!controller.signal.aborted) setAttachmentDownloads((current) => ({ ...current, [attachment.id!]: "error" }));
    } finally {
      if (attachmentControllersRef.current.get(attachment.id) === controller) attachmentControllersRef.current.delete(attachment.id);
    }
  };
  const unsubscribeUrl = safeHttpLinkUrl(message.unsubscribeUrl ?? "");
  const unsubscribeHost = unsubscribeUrl ? new URL(unsubscribeUrl).host : "";
  return <article className={styles.messageDetail}>
    <div className={styles.detailToolbar}>
      <IconButton label="返回邮件列表" className={`${styles.backButton} ${styles.detailIconAction}`} onClick={onBack}><ArrowLeft size={17} /></IconButton>
      {message.labels.includes("forwarded") && <div className={styles.detailContext}>
        {message.labels.includes("forwarded") && <MessageLabels labels={["forwarded"]} forwardedVia={message.forwardedVia} toolbar showForwardedVia forwardedCopyState={addressCopyState?.target === "forwarded" ? addressCopyState.status : null} onCopyForwardedVia={(address) => void copyAddress("forwarded", address)} />}
      </div>}
      {(message.verificationCode || unsubscribeUrl) && <div className={styles.detailActions}>
        {message.verificationCode && <Button type="button" variant="quiet" className={styles.detailAction} aria-label={`复制 ${message.verificationCode}`} onClick={() => void copyVerificationCode()}><Copy size={14} /><span className={styles.detailActionText}>{copyState === "copied" ? "已复制" : copyState === "error" ? "复制失败" : `复制 ${message.verificationCode}`}</span></Button>}
        {unsubscribeUrl && <Button type="button" variant="quiet" className={styles.detailAction} aria-label="退订" onClick={() => setUnsubscribePending(true)}><ExternalLink size={14} /><span className={styles.detailActionText}>退订</span></Button>}
      </div>}
      <span className={styles.toolbarSpacer} />
      <div className={styles.detailUtilities}>
        {hasRemoteImages && <Button type="button" variant="quiet" className={`${styles.detailAction} ${styles.remoteImageButton}`} aria-label={remoteImagesLoaded ? "图片已加载" : "加载图片"} disabled={remoteImagesLoaded} onClick={() => setRemoteImagesForMessage(message.id)}>{remoteImagesLoaded ? <Check size={14} /> : <ImageIcon size={14} />}<span className={styles.detailActionText}>{remoteImagesLoaded ? "已加载" : "加载图片"}</span></Button>}
        <IconButton label={message.read ? "标记为未读" : "标记为已读"} className={styles.detailIconAction} onClick={() => onMark(!message.read)}>{message.read ? <MailOpen size={16} /> : <Mail size={16} />}</IconButton>
      </div>
      <span className={styles.srOnly} role="status" aria-live="polite">{addressCopyState ? `${addressCopyState.address} ${addressCopyState.status === "copied" ? "已复制" : "复制失败"}` : copyState === "copied" ? "验证码已复制" : copyState === "error" ? "验证码复制失败" : ""}</span>
    </div>
    <header className={`${styles.detailHeader} ${metadataCollapsed ? styles.detailHeaderCollapsed : ""}`}><h2>{message.subject}</h2><motion.div className={`${styles.detailMetadata} ${metadataCollapsed ? styles.detailMetadataCollapsed : ""}`} aria-hidden={metadataCollapsed} initial={false} animate={{ opacity: metadataCollapsed ? 0 : 1, y: metadataCollapsed && !reducedMotion ? -4 : 0 }} transition={metadataTransition}><time>{formatDate(message.displayTime)}</time><dl><div><dt>发件人</dt><dd className={styles.addressList}>{addressList(message.from, "from")}</dd></div><div><dt>收件人</dt><dd className={styles.addressList}>{addressList(message.to, "to")}</dd></div>{message.cc.length > 0 && <div><dt>抄送</dt><dd className={styles.addressList}>{addressList(message.cc, "cc")}</dd></div>}{message.attachments.length > 0 && <div><dt>附件</dt><dd className={styles.attachments}>{message.attachments.map((attachment, index) => {
      const status = attachment.id ? attachmentDownloads[attachment.id] : undefined;
      const size = formatAttachmentSize(attachment.size);
      const active = status === "waiting" || status === "downloading";
      const label = !attachment.id ? `${attachment.filename}，同步后可下载` : active ? `取消下载 ${attachment.filename}` : status === "error" ? `重试下载 ${attachment.filename}` : `下载 ${attachment.filename}`;
      return <Tooltip.Provider delayDuration={400} key={attachment.id ?? `${attachment.filename}-${index}`}><Tooltip.Root><Tooltip.Trigger asChild><button type="button" className={`btn btn-ghost btn-xs ${styles.attachmentButton} ${status === "error" ? styles.attachmentError : ""}`} disabled={!attachment.id} tabIndex={metadataCollapsed ? -1 : undefined} aria-label={label} onClick={() => void downloadAttachment(attachment)}>{active ? <X size={13} /> : status === "completed" ? <Check size={13} /> : status === "error" ? <CircleAlert size={13} /> : attachment.id ? <Download size={13} /> : <Paperclip size={13} />}<span className={styles.attachmentName}>{attachment.filename}</span>{size && <span className={styles.attachmentSize}>{size}</span>}<span className={styles.attachmentStatus} role="status" aria-live="polite">{status === "waiting" ? "等待中" : status === "downloading" ? "下载中" : status === "completed" ? "已下载" : status === "error" ? "失败 · 重试" : !attachment.id ? "待同步" : ""}</span></button></Tooltip.Trigger><Tooltip.Portal><Tooltip.Content sideOffset={6} className={styles.tooltip}>{label}{size ? ` · ${size}` : ""}<Tooltip.Arrow className={styles.tooltipArrow} /></Tooltip.Content></Tooltip.Portal></Tooltip.Root></Tooltip.Provider>;
    })}</dd></div>}</dl></motion.div></header>
    <motion.div layout="position" transition={bodyLayoutTransition} className={styles.bodyDivider} />
    {message.html ? <motion.iframe layout="position" transition={bodyLayoutTransition} title="邮件正文" sandbox="allow-same-origin" className={styles.mailBodyFrame} srcDoc={srcDoc} onLoad={(event) => handleFrameLoad(event.currentTarget)} /> : <motion.pre layout="position" transition={bodyLayoutTransition} className={styles.textBody} onScroll={(event) => handleBodyScroll(event.currentTarget.scrollTop)}>{message.text || "（无正文）"}</motion.pre>}
    <AnimatePresence>{addressCopyState && <motion.div className={styles.copyToast} aria-hidden="true" initial={reducedMotion ? { opacity: 0 } : { opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={reducedMotion ? { opacity: 0 } : { opacity: 0, y: 4 }} transition={{ duration: reducedMotion ? 0 : 0.16, ease: [0.23, 1, 0.32, 1] }}><span className={addressCopyState.status === "copied" ? styles.copyToastSuccess : styles.copyToastError}>{addressCopyState.status === "copied" ? <Check size={14} /> : <CircleAlert size={14} />}{addressCopyState.status === "copied" ? "已复制" : "复制失败"}</span><span>{addressCopyState.address}</span></motion.div>}</AnimatePresence>
    <ConfirmDialog open={Boolean(pendingLink)} title={`确认打开“${pendingLink?.label ?? "此链接"}”？`} description={pendingLink?.url ?? ""} descriptionClassName={styles.linkConfirmUrl} confirmLabel="打开链接" onOpenChange={(open) => { if (!open) setPendingLink(null); }} onConfirm={openPendingLink} />
    <ConfirmDialog open={unsubscribePending} title={`确认前往 ${unsubscribeHost || "外部网站"} 退订？`} description={unsubscribeUrl ?? ""} descriptionClassName={styles.linkConfirmUrl} confirmLabel="打开退订链接" onOpenChange={setUnsubscribePending} onConfirm={openUnsubscribeLink} />
  </article>;
}

function MessageLabels({ labels, forwardedVia = null, compact = false, toolbar = false, showForwardedVia = false, forwardedCopyState = null, onCopyForwardedVia }: { labels: MessageLabel[]; forwardedVia?: string | null; compact?: boolean; toolbar?: boolean; showForwardedVia?: boolean; forwardedCopyState?: "copied" | "error" | null; onCopyForwardedVia?: (address: string) => void }) {
  return <span className={`${styles.messageLabels} ${compact ? styles.messageLabelsCompact : ""} ${toolbar ? styles.toolbarLabels : ""}`}>{labels.map((label) => {
    const item = MESSAGE_LABELS[label];
    if (!item) return null;
    const hasForwardedVia = Boolean(label === "forwarded" && forwardedVia);
    const isCopyable = Boolean(hasForwardedVia && toolbar && onCopyForwardedVia);
    const Icon = forwardedCopyState === "copied" && isCopyable ? Check : forwardedCopyState === "error" && isCopyable ? CircleAlert : item.icon;
    const className = `badge badge-soft ${compact ? "badge-xs" : "badge-sm"} ${hasForwardedVia ? styles.forwardedViaLabel : ""} ${hasForwardedVia && showForwardedVia ? styles.forwardedViaLabelExpanded : ""} ${isCopyable ? styles.copyableForwardedVia : ""}`;
    const content = <><Icon size={compact ? 11 : 13} />{hasForwardedVia && showForwardedVia ? <span className={styles.forwardedViaAddress}>{forwardedVia}</span> : item.text}</>;
    if (isCopyable && forwardedVia) return <button type="button" className={className} key={label} data-label={label} data-copy-state={forwardedCopyState ?? undefined} aria-label={`复制经由邮箱 ${forwardedVia}`} title={forwardedCopyState === "copied" ? `已复制 ${forwardedVia}` : forwardedCopyState === "error" ? `复制失败，点击重试 ${forwardedVia}` : `点击复制 ${forwardedVia}`} onClick={() => onCopyForwardedVia?.(forwardedVia)}>{content}</button>;
    return <span className={className} key={label} data-label={label} {...(hasForwardedVia ? { "aria-label": `经由邮箱 ${forwardedVia}`, title: `经由邮箱 ${forwardedVia}` } : {})}>{content}</span>;
  })}</span>;
}

function messageTemplate(html: string): HTMLTemplateElement {
  const template = document.createElement("template");
  template.innerHTML = html;
  return template;
}

function safeMessageLinkUrl(value: string): string | null {
  try {
    const parsed = new URL(value);
    return ["http:", "https:", "mailto:"].includes(parsed.protocol) ? parsed.href : null;
  } catch {
    return null;
  }
}

function safeHttpLinkUrl(value: string): string | null {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : null;
  } catch {
    return null;
  }
}

export function hasRemoteImageReferences(html: string): boolean {
  const template = messageTemplate(html);
  if ([...template.content.querySelectorAll("img")].some((image) => /^(https?:)?\/\//i.test(image.getAttribute("data-remote-src") ?? image.getAttribute("src") ?? ""))) return true;
  return [...template.content.querySelectorAll("style, [style]")].some((element) => /url\(\s*["']?https?:\/\//i.test(element.tagName === "STYLE" ? element.textContent ?? "" : element.getAttribute("style") ?? ""));
}

function prepareMessageBody(html: string, loadRemoteImages: boolean): string {
  const template = messageTemplate(html);
  for (const anchor of template.content.querySelectorAll("a")) {
    const url = safeMessageLinkUrl(anchor.getAttribute("data-safe-href") ?? anchor.getAttribute("href") ?? "");
    anchor.removeAttribute("href");
    anchor.removeAttribute("target");
    anchor.removeAttribute("rel");
    anchor.removeAttribute("data-safe-href");
    if (url) {
      anchor.setAttribute("href", "#");
      anchor.setAttribute("data-safe-href", url);
    }
  }
  if (loadRemoteImages) {
    for (const image of template.content.querySelectorAll("img[data-remote-src]")) {
      const src = image.getAttribute("data-remote-src");
      if (src && /^https?:\/\//i.test(src)) image.setAttribute("src", src);
    }
  }
  return template.innerHTML;
}

export function buildMessageSrcDoc(html: string, loadRemoteImages = false): string {
  const imageSources = loadRemoteImages ? "data: http: https:" : "data:";
  const csp = `default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src ${imageSources}; font-src 'none'; media-src 'none'; frame-src 'none'; child-src 'none'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`;
  const body = prepareMessageBody(html, loadRemoteImages);
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="referrer" content="no-referrer"><style>html,body{min-height:100%;margin:0}body{padding:20px;overflow-wrap:anywhere}img,table{max-width:100%}pre{white-space:pre-wrap}</style></head><body>${body}</body></html>`;
}

function SettingsPage({ api, onNotice }: { api: ApiClient; onNotice: (notice: { kind: "success" | "error"; text: string }) => void }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [value, setValue] = useState("100");
  const [interval, setIntervalValue] = useState("10");
  const [pageSize, setPageSize] = useState("100");
  const [maxConcurrentDownloads, setMaxConcurrentDownloads] = useState("3");
  const [maxAttachmentSizeMb, setMaxAttachmentSizeMb] = useState("100");
  const [autoLoadRemoteImages, setAutoLoadRemoteImages] = useState(false);
  const [remoteImageAllowlist, setRemoteImageAllowlist] = useState<string[]>([]);
  const [remoteImageInput, setRemoteImageInput] = useState("");
  const [defaultSenderName, setDefaultSenderName] = useState("");
  const [busy, setBusy] = useState(false);
  const remoteImageInputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    api.request<Settings>("/settings").then((result) => {
      setSettings(result);
      setValue(String(result.maxMessagesPerAccount));
      setIntervalValue(String(result.pollIntervalSeconds));
      setPageSize(String(result.pageSize ?? 100));
      setMaxConcurrentDownloads(String(result.maxConcurrentDownloads ?? 3));
      setMaxAttachmentSizeMb(String(result.maxAttachmentSizeMb ?? 100));
      setAutoLoadRemoteImages(result.autoLoadRemoteImages ?? false);
      setRemoteImageAllowlist(result.remoteImageAllowlist ?? []);
      setDefaultSenderName(result.defaultSenderName ?? "");
    }).catch((error) => onNotice({ kind: "error", text: error.message }));
  }, [api, onNotice]);
  const addRemoteImageSender = () => {
    const address = remoteImageInput.trim().toLowerCase();
    if (!address) return;
    if (!remoteImageInputRef.current?.checkValidity()) {
      remoteImageInputRef.current?.reportValidity();
      return;
    }
    if (remoteImageAllowlist.length >= 200 && !remoteImageAllowlist.includes(address)) {
      onNotice({ kind: "error", text: "加载图片白名单最多保存 200 个邮箱地址" });
      return;
    }
    setRemoteImageAllowlist((current) => current.includes(address) ? current : [...current, address]);
    setRemoteImageInput("");
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    const pendingAddress = autoLoadRemoteImages ? "" : remoteImageInput.trim().toLowerCase();
    if (pendingAddress && !remoteImageInputRef.current?.checkValidity()) {
      remoteImageInputRef.current?.reportValidity();
      return;
    }
    if (pendingAddress && remoteImageAllowlist.length >= 200 && !remoteImageAllowlist.includes(pendingAddress)) {
      onNotice({ kind: "error", text: "加载图片白名单最多保存 200 个邮箱地址" });
      return;
    }
    const nextRemoteImageAllowlist = pendingAddress && !remoteImageAllowlist.includes(pendingAddress)
      ? [...remoteImageAllowlist, pendingAddress]
      : remoteImageAllowlist;
    setBusy(true);
    try {
      const result = await api.request<Settings>("/settings", {
        method: "PATCH",
        body: JSON.stringify({
          maxMessagesPerAccount: Number(value),
          pollIntervalSeconds: Number(interval),
          pageSize: Number(pageSize),
          maxConcurrentDownloads: Number(maxConcurrentDownloads),
          maxAttachmentSizeMb: Number(maxAttachmentSizeMb),
          autoLoadRemoteImages,
          remoteImageAllowlist: nextRemoteImageAllowlist,
          defaultSenderName
        })
      });
      setSettings(result);
      setRemoteImageAllowlist(result.remoteImageAllowlist ?? []);
      setRemoteImageInput("");
      onNotice({ kind: "success", text: "系统设置已保存" });
    } catch (error) {
      onNotice({ kind: "error", text: error instanceof Error ? error.message : "保存失败" });
    } finally {
      setBusy(false);
    }
  };
  if (!settings) return <div className={styles.centerState}><Spinner /></div>;
  const unchanged = Number(value) === settings.maxMessagesPerAccount
    && Number(interval) === settings.pollIntervalSeconds
    && Number(pageSize) === settings.pageSize
    && Number(maxConcurrentDownloads) === (settings.maxConcurrentDownloads ?? 3)
    && Number(maxAttachmentSizeMb) === (settings.maxAttachmentSizeMb ?? 100)
    && autoLoadRemoteImages === (settings.autoLoadRemoteImages ?? false)
    && defaultSenderName === (settings.defaultSenderName ?? "")
    && JSON.stringify(remoteImageAllowlist) === JSON.stringify(settings.remoteImageAllowlist ?? [])
    && !remoteImageInput.trim();
  return <section className={styles.settingsSection}><div className={styles.sectionToolbar}><div><h2>同步与缓存</h2><p>全局邮件策略</p></div></div><form className={styles.settingsForm} onSubmit={save}>
    <div className={`fieldset ${styles.settingsField}`}><label className="fieldset-legend" htmlFor="max-messages">每个账号最多保留</label><div className={styles.numberControl}><input className="input input-sm" id="max-messages" type="number" min="1" max="10000" value={value} onChange={(event) => setValue(event.target.value)} /><span>封邮件</span></div></div>
    <div className={`fieldset ${styles.settingsField}`}><label className="fieldset-legend" htmlFor="page-size">邮件列表每页显示</label><div className={styles.numberControl}><input className="input input-sm" id="page-size" type="number" min="10" max="100" value={pageSize} onChange={(event) => setPageSize(event.target.value)} /><span>封邮件</span></div></div>
    <div className={`fieldset ${styles.settingsField}`}><label className="fieldset-legend" htmlFor="poll-interval">无 IDLE 时轮询间隔</label><div className={styles.numberControl}><input className="input input-sm" id="poll-interval" type="number" min="5" max="3600" value={interval} onChange={(event) => setIntervalValue(event.target.value)} /><span>秒</span></div></div>
    <div className={`fieldset ${styles.settingsField}`}><label className="fieldset-legend" htmlFor="max-concurrent-downloads">附件并发下载</label><div className={styles.numberControl}><input className="input input-sm" id="max-concurrent-downloads" type="number" min="1" max="10" value={maxConcurrentDownloads} onChange={(event) => setMaxConcurrentDownloads(event.target.value)} /><span>个</span></div></div>
    <div className={`fieldset ${styles.settingsField}`}><label className="fieldset-legend" htmlFor="max-attachment-size">单附件大小上限</label><div className={styles.numberControl}><input className="input input-sm" id="max-attachment-size" type="number" min="1" max="1024" value={maxAttachmentSizeMb} onChange={(event) => setMaxAttachmentSizeMb(event.target.value)} /><span>MB</span></div></div>
    <div className={`fieldset ${styles.settingsField}`}><label className="fieldset-legend" htmlFor="default-sender-name">默认发件人名称</label><div className={styles.settingsValue}><input className="input input-sm" id="default-sender-name" maxLength={200} value={defaultSenderName} onChange={(event) => setDefaultSenderName(event.target.value)} placeholder="留空表示不设置" /></div></div>
    <div className={`fieldset ${styles.settingsField}`}><label className="fieldset-legend" htmlFor="auto-load-remote-images">自动加载图片</label><div className={styles.settingsValue}><input className={styles.settingsToggle} id="auto-load-remote-images" type="checkbox" checked={autoLoadRemoteImages} onChange={(event) => { setAutoLoadRemoteImages(event.target.checked); if (event.target.checked) setRemoteImageInput(""); }} /></div></div>
    <div className={`fieldset ${styles.settingsField} ${autoLoadRemoteImages ? styles.settingsFieldDisabled : ""}`}><label className="fieldset-legend" htmlFor="remote-image-sender">自动加载图片发件人</label><div className={styles.settingsValue}><div className={styles.aliasInput}><input ref={remoteImageInputRef} className="input input-sm" id="remote-image-sender" type="email" maxLength={320} value={remoteImageInput} disabled={autoLoadRemoteImages} onChange={(event) => setRemoteImageInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === ",") { event.preventDefault(); addRemoteImageSender(); } }} placeholder="sender@example.com" /><IconButton type="button" label="添加图片白名单" disabled={autoLoadRemoteImages || !remoteImageInput.trim() || (remoteImageAllowlist.length >= 200 && !remoteImageAllowlist.includes(remoteImageInput.trim().toLowerCase()))} onClick={addRemoteImageSender}><Plus size={17} /></IconButton></div>{remoteImageAllowlist.length > 0 && <div className={styles.aliasList}>{remoteImageAllowlist.map((address) => <span className="badge badge-ghost badge-sm" key={address}>{address}<button type="button" disabled={autoLoadRemoteImages} aria-label={`移除图片白名单 ${address}`} onClick={() => setRemoteImageAllowlist((current) => current.filter((item) => item !== address))}><X size={14} /></button></span>)}</div>}</div></div>
    <Button variant="primary" disabled={busy || unchanged}>{busy ? <Spinner label="正在保存" /> : "保存设置"}</Button>
  </form></section>;
}

function ConfirmDialog({ open, title, description, descriptionClassName, confirmLabel, danger = false, onOpenChange, onConfirm }: { open: boolean; title: string; description: string; descriptionClassName?: string; confirmLabel: string; danger?: boolean; onOpenChange: (open: boolean) => void; onConfirm: () => void }) {
  return <AlertDialog.Root open={open} onOpenChange={onOpenChange}><AlertDialog.Portal><AlertDialog.Overlay className={styles.overlay} /><AlertDialog.Content className={styles.confirmDialog}><AlertDialog.Title>{title}</AlertDialog.Title><AlertDialog.Description className={descriptionClassName}>{description}</AlertDialog.Description><div className={`modal-action ${styles.dialogFooter}`}><AlertDialog.Cancel asChild><Button>取消</Button></AlertDialog.Cancel><AlertDialog.Action asChild><Button variant={danger ? "danger" : "primary"} onClick={onConfirm}>{confirmLabel}</Button></AlertDialog.Action></div></AlertDialog.Content></AlertDialog.Portal></AlertDialog.Root>;
}
