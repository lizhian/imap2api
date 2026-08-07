import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent as ReactDragEvent, type FormEvent, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import * as AlertDialog from "@radix-ui/react-alert-dialog";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  Archive, ArrowLeft, Check, ChevronLeft, ChevronRight, CircleAlert, CircleCheck,
  Cloud, Copy, Edit3, ExternalLink, Eye, EyeOff, FileText, Forward, GripVertical, Image as ImageIcon, Inbox, KeyRound, LogOut, Mail, MailCheck, MailOpen,
  Paperclip, Plus, RefreshCw, SearchX, Settings as SettingsIcon, ShieldCheck,
  SlidersHorizontal, Trash2, UserRound, X
} from "lucide-react";
import type { Account, AccountInput, AccountOrderUpdate, AccountUpdate, MessageDetail, MessageLabel, MessageListResponse, MessageSecondaryFilter, MessageSummary, MessageView, ProviderId, ServerEvent, Settings } from "@imap2api/shared";
import { ApiClient } from "./api";
import { Button, EmptyState, IconButton, Spinner } from "./components";
import styles from "./styles.module.css";

const SESSION_KEY = "imap2api-token";
const PROVIDERS: Array<{ value: ProviderId; label: string }> = [
  { value: "auto", label: "自动识别" }, { value: "qq", label: "QQ 邮箱" },
  { value: "gmail", label: "Gmail" }, { value: "icloud", label: "iCloud" },
  { value: "outlook", label: "Outlook" }, { value: "qq-enterprise", label: "QQ 企业邮箱" },
  { value: "163", label: "163 邮箱" }, { value: "custom", label: "自定义" }
];
const MESSAGE_LABELS: Record<MessageLabel, { text: string; icon: typeof Forward }> = {
  forwarded: { text: "转发", icon: Forward },
  verification_code: { text: "验证码", icon: KeyRound },
  unsubscribe: { text: "可退订", icon: ExternalLink }
};
const MESSAGE_VIEWS: Array<{ value: MessageView; label: string }> = [
  { value: "all", label: "全部" }, { value: "unread", label: "未读" }, { value: "junk", label: "垃圾箱" }
];
const MESSAGE_SECONDARY_FILTERS: Array<{ value: MessageSecondaryFilter; label: string; icon: typeof Forward }> = [
  { value: "verification_code", label: "验证码", icon: KeyRound },
  { value: "attachment", label: "附件", icon: Paperclip },
  { value: "forwarded", label: "转发", icon: Forward }
];

type Page = "messages" | "accounts" | "settings";

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
        <h1>imap2api</h1>
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
    return hash === "accounts" || hash === "settings" ? hash : "messages";
  });
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [activeAccountId, setActiveAccountId] = useState("");
  const [messageRevision, setMessageRevision] = useState(0);
  const [eventConnection, setEventConnection] = useState<"connecting" | "connected" | "reconnecting">("connecting");
  const [sidebarWidth, setSidebarWidth] = useState(248);
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
  const totalUnread = accounts.reduce((sum, account) => sum + (account.unreadCount ?? 0), 0);
  const connectionBadge = eventConnection === "connected"
    ? { badge: "badge-success", status: "status-success", label: "服务正常" }
    : eventConnection === "reconnecting"
      ? { badge: "badge-warning", status: "status-warning", label: "正在重连" }
      : { badge: "badge-info", status: "status-info", label: "连接中" };

  return (
    <div className={`${styles.appShell} bg-base-200 text-base-content`} style={{ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties}>
      <aside className={`${styles.sidebar} bg-base-100`}>
        <div className={styles.sidebarBrand}><span className={styles.brandMark}><Mail size={18} /></span><strong>imap2api</strong><span className={`status status-xs ${connectionBadge.status}`} aria-label={connectionBadge.label} /></div>
        <nav className={`tabs ${styles.accountTabs}`} role="tablist" aria-label="邮箱账号">
          <button role="tab" aria-selected={page === "messages" && !activeAccountId} className={`tab ${page === "messages" && !activeAccountId ? "tab-active" : ""} ${styles.accountTab} ${styles.accountTabWithIcon}`} onClick={() => openMailbox("")}>
            <span className={styles.accountTabIcon}><Inbox size={16} /></span><span className={`${styles.accountTabText} ${styles.aggregateTabText}`}><strong>聚合收件箱</strong><small className={styles.unreadCount} aria-label={`${totalUnread} 封未读`}>{totalUnread} 未读</small></span>
          </button>
          {accounts.map((account) => <button key={account.id} role="tab" aria-selected={page === "messages" && activeAccountId === account.id} className={`tab ${page === "messages" && activeAccountId === account.id ? "tab-active" : ""} ${styles.accountTab}`} onClick={() => openMailbox(account.id)}>
            <span className={styles.accountTabText}><strong>{account.email}</strong><span className={styles.accountTabSubline}><small>{account.status === "connected" ? "已连接" : account.status === "connecting" ? "同步中" : account.status === "warning" ? "有警告" : account.status === "error" ? "连接错误" : "等待连接"}</small><small className={styles.unreadCount} aria-label={`${account.unreadCount ?? 0} 封未读`}>{account.unreadCount ?? 0} 未读</small></span></span>
          </button>)}
        </nav>
        <nav className={`menu menu-sm ${styles.utilityNav}`} aria-label="管理导航">
          <li><NavButton active={page === "accounts"} icon={<UserRound size={17} />} label="账号管理" onClick={() => navigate("accounts")} /></li>
          <li><NavButton active={page === "settings"} icon={<SettingsIcon size={17} />} label="系统设置" onClick={() => navigate("settings")} /></li>
        </nav>
        <button className={`btn btn-ghost btn-sm ${styles.logoutButton}`} onClick={onLogout}><LogOut size={17} />退出</button>
      </aside>
      <ResizeHandle value={sidebarWidth} min={200} max={() => Math.min(360, window.innerWidth - 680)} label="调整邮箱栏宽度" onChange={setSidebarWidth} />
      <div className={styles.mainColumn}>
        <main className={`${styles.mainContent} ${page === "messages" ? styles.messageContent : ""}`}>
          <AnimatePresence mode="wait" initial={false}>
            <motion.div key={page} className={`${styles.pageFrame} ${page === "messages" ? styles.messageFrame : ""}`} initial={reducedMotion ? { opacity: 0 } : { opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={reducedMotion ? { opacity: 0 } : { opacity: 0, y: -4 }} transition={{ duration: reducedMotion ? 0.08 : 0.2 }}>
              {page === "messages" && <MessagesPage api={api} accounts={accounts} accountId={activeAccountId} onAccountChange={setActiveAccountId} revision={messageRevision} onLocalMessageUpdate={registerLocalMessageUpdate} onLocalMessageUpdateFailed={cancelLocalMessageUpdate} onNotice={setNotice} />}
              {page === "accounts" && <AccountsPage api={api} accounts={accounts} reload={loadAccounts} reorder={reorderAccounts} onNotice={setNotice} />}
              {page === "settings" && <SettingsPage api={api} onNotice={setNotice} />}
            </motion.div>
          </AnimatePresence>
        </main>
      </div>
      <nav className={styles.mobileNav} aria-label="移动端主导航">
        <NavButton active={page === "messages"} icon={<Inbox size={19} />} label="邮件" onClick={() => navigate("messages")} />
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
                <div className={styles.accountHealth}>
                  <div className={styles.accountConnection}><Status status={syncing ? "connecting" : account.status} /><small>{syncModeLabel}</small></div>
                  <div className={styles.accountMetric}><span>本地缓存</span><strong>{account.messageCount ?? 0} 封 · {account.unreadCount ?? 0} 未读</strong></div>
                  <div className={styles.accountTime}><span>最近同步</span><time dateTime={account.lastSyncedAt ?? undefined} title={formatDate(account.lastSyncedAt)}>{account.lastSyncedAt ? formatRelativeDate(account.lastSyncedAt, now) : "尚未同步"}</time>{account.lastError && <small title={account.lastError}>{account.lastError}</small>}</div>
                </div>
              </div>
              <div className={styles.rowActions}>
                <IconButton label="测试连接" onClick={() => void test(account)}><ShieldCheck size={17} /></IconButton>
                <IconButton label="立即同步" disabled={syncing} onClick={() => void sync(account)}><RefreshCw className={syncing ? styles.rotating : ""} size={17} /></IconButton>
                <IconButton label="编辑账号" onClick={() => setEditing(account)}><Edit3 size={17} /></IconButton>
                <IconButton label="删除账号" className={styles.dangerIcon} onClick={() => setDeleting(account)}><Trash2 size={17} /></IconButton>
              </div>
              {syncing && <span className={styles.syncRail} aria-hidden="true" />}
            </article>;
          })}
        </div>}
      <AccountDialog open={editing !== null} account={editing === "new" ? null : editing} api={api} onOpenChange={(open) => !open && setEditing(null)} onSaved={async (message) => { setEditing(null); onNotice({ kind: "success", text: message }); await reload(); }} />
      <ConfirmDialog open={Boolean(deleting)} title="删除邮箱账号？" description={deleting ? `将永久删除 ${deleting.email} 的配置和本地邮件缓存，不影响 IMAP 服务器邮件。` : ""} confirmLabel="删除账号" danger onOpenChange={(open) => !open && setDeleting(null)} onConfirm={() => void remove()} />
    </section>
  );
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
  const [advanced, setAdvanced] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setEmail(account?.email ?? ""); setPassword(""); setAliases(account?.aliases ?? []); setAliasInput(""); setProvider(account?.provider ?? "auto");
    setHost(account?.imap.host ?? ""); setPort(String(account?.imap.port ?? 993)); setSecure(account?.imap.secure ?? true);
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
    try {
      if (account) {
        const body: AccountUpdate = { email, aliases: submittedAliases, imap, ...(password ? { password } : {}) };
        await api.request(`/accounts/${account.id}`, { method: "PATCH", body: JSON.stringify(body) });
        onSaved("邮箱账号已更新");
      } else {
        const body: AccountInput = { email, aliases: submittedAliases, password, imap };
        await api.request("/accounts", { method: "POST", body: JSON.stringify(body) });
        onSaved("邮箱账号已添加");
      }
    } catch (reason) { setError(reason instanceof Error ? reason.message : "保存失败"); }
    finally { setBusy(false); }
  };

  return <Dialog.Root open={open} onOpenChange={onOpenChange}><Dialog.Portal><Dialog.Overlay className={styles.overlay} /><Dialog.Content className={styles.dialog}>
    <div className={styles.dialogHeader}><div><Dialog.Title>{account ? "编辑邮箱" : "添加邮箱"}</Dialog.Title><Dialog.Description>{account ? "留空密码将保留现有授权码" : "使用邮箱密码或服务商授权码连接"}</Dialog.Description></div><Dialog.Close asChild><IconButton label="关闭"><X size={18} /></IconButton></Dialog.Close></div>
    <form className={styles.accountForm} onSubmit={submit}>
      <div className={`fieldset ${styles.field}`}><label className="fieldset-legend" htmlFor="account-email">邮箱地址</label><input className="input input-sm" id="account-email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} required autoFocus /></div>
      <div className={`fieldset ${styles.field}`}><label className="fieldset-legend" htmlFor="account-alias">别名邮箱</label><div className={styles.aliasInput}><input className="input input-sm" id="account-alias" type="email" value={aliasInput} onChange={(event) => setAliasInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === ",") { event.preventDefault(); addAliases(); } }} placeholder="alias@example.com" /><IconButton type="button" label="添加别名" onClick={() => addAliases()}><Plus size={17} /></IconButton></div>{aliases.length > 0 && <div className={styles.aliasList}>{aliases.map((alias) => <span className="badge badge-ghost badge-sm" key={alias}>{alias}<button type="button" aria-label={`移除别名 ${alias}`} onClick={() => setAliases((values) => values.filter((value) => value !== alias))}><X size={14} /></button></span>)}</div>}</div>
      <div className={`fieldset ${styles.field}`}><label className="fieldset-legend" htmlFor="account-password">密码 / 授权码</label><input className="input input-sm" id="account-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} required={!account} autoComplete="new-password" placeholder={account ? "留空表示不修改" : "请输入授权码"} /></div>
      <div className={`fieldset ${styles.field}`}><label className="fieldset-legend" htmlFor="account-provider">邮箱服务商</label><select className="select select-sm" id="account-provider" value={provider} onChange={(event) => { const value = event.target.value as ProviderId; setProvider(value); if (value === "custom") setAdvanced(true); }}>{PROVIDERS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></div>
      <button type="button" className={styles.disclosure} onClick={() => setAdvanced((value) => !value)} aria-expanded={advanced}><SlidersHorizontal size={16} />高级 IMAP 配置<span>{advanced ? "收起" : "展开"}</span></button>
      {advanced && <motion.div className={styles.advancedFields} initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }}>
        <div className={`fieldset ${styles.field}`}><label className="fieldset-legend" htmlFor="imap-host">主机</label><input className="input input-sm" id="imap-host" value={host} onChange={(event) => setHost(event.target.value)} placeholder="imap.example.com" required={provider === "custom"} /></div>
        <div className={`fieldset ${styles.field}`}><label className="fieldset-legend" htmlFor="imap-port">端口</label><input className="input input-sm" id="imap-port" type="number" min="1" max="65535" value={port} onChange={(event) => setPort(event.target.value)} /></div>
        <label className={styles.checkbox}><span>SSL</span><input className="toggle toggle-sm" type="checkbox" checked={secure} onChange={(event) => setSecure(event.target.checked)} /></label>
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
  const [confirmAll, setConfirmAll] = useState(false);
  const [listWidth, setListWidth] = useState(380);
  const [now, setNow] = useState(Date.now());
  const workspaceRef = useRef<HTMLElement | null>(null);

  const load = useCallback(async (background = false) => {
    if (background) setRefreshing(true); else setLoading(true);
    const query = new URLSearchParams({ view, limit: "50" });
    secondaryFilters.forEach((filter) => query.append("filter", filter));
    if (accountId) query.set("accountId", accountId); if (cursor) query.set("cursor", cursor);
    try { const result = await api.request<MessageListResponse>(`/messages?${query}`); setItems(result.items); setNextCursor(result.nextCursor); }
    catch (error) { onNotice({ kind: "error", text: error instanceof Error ? error.message : "邮件加载失败" }); }
    finally { if (background) setRefreshing(false); else setLoading(false); }
  }, [accountId, api, cursor, onNotice, revision, secondaryFilters, view]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { setCursor(null); setHistory([]); setSelected(null); setDetail(null); }, [accountId, secondaryFilters, view]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
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

  return <section ref={workspaceRef} className={styles.mailWorkspace} style={{ "--mail-list-width": `${listWidth}px` } as CSSProperties}>
    <div className={`${styles.mailListPane} ${selected ? styles.mobileHidden : ""}`}>
      <div className={styles.mailControls}>
        <select className={`select select-sm ${styles.mobileAccountSelect}`} aria-label="筛选邮箱账号" value={accountId} onChange={(event) => onAccountChange(event.target.value)}><option value="">聚合收件箱</option>{accounts.map((account) => <option key={account.id} value={account.id}>{account.email}</option>)}</select>
        <div className={styles.filterBar}>
          <div className={`join ${styles.viewGroup}`} role="tablist" aria-label="邮件视图">{MESSAGE_VIEWS.map((item) => <button key={item.value} role="tab" aria-selected={view === item.value} className={`join-item btn btn-sm ${styles.viewButton} ${view === item.value ? `btn-primary btn-active ${styles.viewButtonActive}` : ""}`} onClick={() => setView(item.value)}>{item.label}</button>)}</div>
          <div className={`join ${styles.secondaryFilterGroup}`} aria-label="邮件内容筛选">{MESSAGE_SECONDARY_FILTERS.map((item) => <button key={item.value} type="button" aria-pressed={secondaryFilters.includes(item.value)} className={`join-item btn btn-sm ${styles.secondaryFilterButton} ${secondaryFilters.includes(item.value) ? styles.secondaryFilterButtonActive : ""}`} onClick={() => toggleSecondaryFilter(item.value)}>{item.label}</button>)}</div>
          <details className={`dropdown dropdown-end ${styles.filterDropdown}`}>
            <summary role="button" className={`btn btn-sm ${styles.filterDropdownTrigger}`} aria-label={`更多筛选，已选 ${secondaryFilters.length} 项`} onKeyDown={(event) => {
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
          <span className={styles.messageMain}><span className={styles.messageMeta}><strong>{senderLabel(message)}</strong><span className={styles.messageMetaRight}><span className={styles.messageSignals}>{message.labels.length > 0 && <MessageLabels labels={message.labels} forwardedVia={message.forwardedVia} compact />}{message.hasAttachments && <Paperclip size={14} aria-label="包含附件" />}{message.folder === "junk" && <Archive size={14} aria-label="垃圾箱" />}</span><time dateTime={message.displayTime} title={formatDate(message.displayTime)}>{formatRelativeDate(message.displayTime, now)}</time></span></span><span className={styles.messageSubject}>{message.subject}</span><span className={styles.messagePreview}>{message.preview || "无正文预览"}</span></span>
        </button>)}
      </div>
      <div className={styles.pagination}><Button variant="quiet" disabled={!history.length} onClick={() => { const previous = [...history]; const value = previous.pop() ?? null; setHistory(previous); setCursor(value); }}><ChevronLeft size={16} />上一页</Button><span>每页 50 封</span><Button variant="quiet" disabled={!nextCursor} onClick={() => { setHistory((values) => [...values, cursor]); setCursor(nextCursor); }} >下一页<ChevronRight size={16} /></Button></div>
    </div>
    <ResizeHandle value={listWidth} min={320} max={() => Math.max(320, (workspaceRef.current?.clientWidth ?? window.innerWidth) - 360)} label="调整邮件列表宽度" onChange={setListWidth} />
    <div className={`${styles.detailPane} ${selected ? styles.detailVisible : ""}`}>
      {detailLoading ? <div className={styles.centerState}><Spinner label="正在读取邮件" /></div> : detail ? <MessageDetailView message={detail} onBack={() => { setSelected(null); setDetail(null); }} onMark={(read) => void mark(detail, read)} /> : <EmptyState icon={<FileText size={28} />} title="选择一封邮件查看内容" />}
    </div>
    <ConfirmDialog open={confirmAll} title="将缓存邮件全部标记为已读？" description={accountId ? "操作会同步更新当前账号已缓存的收件箱和垃圾箱邮件。" : "操作会同步更新所有账号已缓存的收件箱和垃圾箱邮件。"} confirmLabel="全部已读" onOpenChange={setConfirmAll} onConfirm={() => void markAll()} />
  </section>;
}

export function MessageDetailView({ message, onBack, onMark }: { message: MessageDetail; onBack: () => void; onMark: (read: boolean) => void }) {
  const addressList = (values: MessageDetail["to"]) => values.map((item) => item.name ? `${item.name} <${item.address}>` : item.address).join(", ") || "—";
  const [remoteImagesForMessage, setRemoteImagesForMessage] = useState<string | null>(null);
  const [pendingLink, setPendingLink] = useState<{ url: string; label: string } | null>(null);
  const [unsubscribePending, setUnsubscribePending] = useState(false);
  const [copyState, setCopyState] = useState<"copied" | "error" | null>(null);
  const hasRemoteImages = useMemo(() => hasRemoteImageReferences(message.html ?? ""), [message.html]);
  const remoteImagesLoaded = remoteImagesForMessage === message.id;
  const srcDoc = useMemo(() => message.html ? buildMessageSrcDoc(message.html, remoteImagesLoaded) : "", [message.html, remoteImagesLoaded]);
  useEffect(() => { setPendingLink(null); setUnsubscribePending(false); setCopyState(null); }, [message.id]);
  const handleFrameLoad = (frame: HTMLIFrameElement) => {
    frame.contentDocument?.addEventListener("click", (event) => {
      const anchor = (event.target as Element | null)?.closest?.("a[data-safe-href]") as HTMLAnchorElement | null;
      if (!anchor) return;
      event.preventDefault();
      event.stopPropagation();
      const url = safeMessageLinkUrl(anchor.getAttribute("data-safe-href") ?? "");
      if (url) setPendingLink({ url, label: (anchor.textContent?.replace(/\s+/g, " ").trim() || url).slice(0, 160) });
    });
  };
  const openPendingLink = () => {
    const url = pendingLink ? safeMessageLinkUrl(pendingLink.url) : null;
    if (url) window.open(url, "_blank", "noopener,noreferrer");
    setPendingLink(null);
  };
  const copyVerificationCode = async () => {
    if (!message.verificationCode || !navigator.clipboard) { setCopyState("error"); return; }
    try { await navigator.clipboard.writeText(message.verificationCode); setCopyState("copied"); }
    catch { setCopyState("error"); }
  };
  const openUnsubscribeLink = () => {
    if (unsubscribeUrl) window.open(unsubscribeUrl, "_blank", "noopener,noreferrer");
    setUnsubscribePending(false);
  };
  const unsubscribeUrl = safeHttpLinkUrl(message.unsubscribeUrl ?? "");
  const unsubscribeHost = unsubscribeUrl ? new URL(unsubscribeUrl).host : "";
  return <article className={styles.messageDetail}>
    <div className={styles.detailToolbar}>
      <IconButton label="返回邮件列表" className={`${styles.backButton} ${styles.detailIconAction}`} onClick={onBack}><ArrowLeft size={17} /></IconButton>
      {(message.folder === "junk" || message.labels.length > 0) && <div className={styles.detailContext}>
        {message.folder === "junk" && <span className={`badge badge-soft badge-sm ${styles.junkLabel}`}>垃圾箱</span>}
        {message.labels.length > 0 && <MessageLabels labels={message.labels} toolbar />}
      </div>}
      {(message.verificationCode || unsubscribeUrl) && <div className={styles.detailActions}>
        {message.verificationCode && <Button type="button" variant="quiet" className={styles.detailAction} aria-label={`复制 ${message.verificationCode}`} onClick={() => void copyVerificationCode()}><Copy size={14} /><span className={styles.detailActionText}>{copyState === "copied" ? "已复制" : copyState === "error" ? "复制失败" : `复制 ${message.verificationCode}`}</span></Button>}
        {unsubscribeUrl && <Button type="button" variant="quiet" className={styles.detailAction} aria-label="快速退订" onClick={() => setUnsubscribePending(true)}><ExternalLink size={14} /><span className={styles.detailActionText}>快速退订</span></Button>}
      </div>}
      <span className={styles.toolbarSpacer} />
      <div className={styles.detailUtilities}>
        {hasRemoteImages && <Button type="button" variant="quiet" className={`${styles.detailAction} ${styles.remoteImageButton}`} aria-label={remoteImagesLoaded ? "图片已加载" : "加载图片"} disabled={remoteImagesLoaded} onClick={() => setRemoteImagesForMessage(message.id)}>{remoteImagesLoaded ? <Check size={14} /> : <ImageIcon size={14} />}<span className={styles.detailActionText}>{remoteImagesLoaded ? "已加载" : "加载图片"}</span></Button>}
        <IconButton label={message.read ? "标记为未读" : "标记为已读"} className={styles.detailIconAction} onClick={() => onMark(!message.read)}>{message.read ? <Mail size={16} /> : <MailCheck size={16} />}</IconButton>
      </div>
      <span className={styles.srOnly} role="status" aria-live="polite">{copyState === "copied" ? "验证码已复制" : copyState === "error" ? "验证码复制失败" : ""}</span>
    </div>
    <header className={styles.detailHeader}><h2>{message.subject}</h2><time>{formatDate(message.displayTime)}</time><dl><div><dt>发件人</dt><dd>{addressList(message.from)}</dd></div><div><dt>收件人</dt><dd>{addressList(message.to)}</dd></div>{message.cc.length > 0 && <div><dt>抄送</dt><dd>{addressList(message.cc)}</dd></div>}{message.attachments.length > 0 && <div><dt>附件</dt><dd className={styles.attachments}>{message.attachments.map((name) => <span key={name}><Paperclip size={13} />{name}</span>)}</dd></div>}</dl></header>
    <div className={styles.bodyDivider} />
    {message.html ? <iframe title="邮件正文" sandbox="allow-same-origin" className={styles.mailBodyFrame} srcDoc={srcDoc} onLoad={(event) => handleFrameLoad(event.currentTarget)} /> : <pre className={styles.textBody}>{message.text || "（无正文）"}</pre>}
    <ConfirmDialog open={Boolean(pendingLink)} title={`确认打开“${pendingLink?.label ?? "此链接"}”？`} description={pendingLink?.url ?? ""} descriptionClassName={styles.linkConfirmUrl} confirmLabel="打开链接" onOpenChange={(open) => { if (!open) setPendingLink(null); }} onConfirm={openPendingLink} />
    <ConfirmDialog open={unsubscribePending} title={`确认前往 ${unsubscribeHost || "外部网站"} 退订？`} description={unsubscribeUrl ?? ""} descriptionClassName={styles.linkConfirmUrl} confirmLabel="打开退订链接" onOpenChange={setUnsubscribePending} onConfirm={openUnsubscribeLink} />
  </article>;
}

function MessageLabels({ labels, forwardedVia = null, compact = false, toolbar = false }: { labels: MessageLabel[]; forwardedVia?: string | null; compact?: boolean; toolbar?: boolean }) {
  return <span className={`${styles.messageLabels} ${compact ? styles.messageLabelsCompact : ""} ${toolbar ? styles.toolbarLabels : ""}`}>{labels.map((label) => {
    const item = MESSAGE_LABELS[label];
    if (!item) return null;
    const Icon = item.icon;
    const showForwardedVia = compact && label === "forwarded" && forwardedVia;
    return <span className={`badge badge-soft ${compact ? "badge-xs" : "badge-sm"} ${showForwardedVia ? styles.forwardedViaLabel : ""}`} key={label} data-label={label} {...(showForwardedVia ? { "aria-label": `经由邮箱 ${forwardedVia}`, title: `经由邮箱 ${forwardedVia}` } : {})}><Icon size={compact ? 11 : 13} />{showForwardedVia ? <><span className={styles.forwardedViaAddress}>{forwardedVia}</span><span className={styles.forwardedViaFallback} aria-hidden="true">转发</span></> : item.text}</span>;
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
  const [settings, setSettings] = useState<Settings | null>(null); const [value, setValue] = useState("100"); const [interval, setIntervalValue] = useState("10"); const [busy, setBusy] = useState(false);
  useEffect(() => { api.request<Settings>("/settings").then((result) => { setSettings(result); setValue(String(result.maxMessagesPerAccount)); setIntervalValue(String(result.pollIntervalSeconds)); }).catch((error) => onNotice({ kind: "error", text: error.message })); }, [api, onNotice]);
  const save = async (event: FormEvent) => { event.preventDefault(); setBusy(true); try { const result = await api.request<Settings>("/settings", { method: "PATCH", body: JSON.stringify({ maxMessagesPerAccount: Number(value), pollIntervalSeconds: Number(interval) }) }); setSettings(result); onNotice({ kind: "success", text: "系统设置已保存" }); } catch (error) { onNotice({ kind: "error", text: error instanceof Error ? error.message : "保存失败" }); } finally { setBusy(false); } };
  if (!settings) return <div className={styles.centerState}><Spinner /></div>;
  const unchanged = Number(value) === settings.maxMessagesPerAccount && Number(interval) === settings.pollIntervalSeconds;
  return <section className={styles.settingsSection}><div className={styles.sectionToolbar}><div><h2>同步与缓存</h2><p>全局邮件策略</p></div></div><form className={styles.settingsForm} onSubmit={save}><div className={`fieldset ${styles.settingsField}`}><label className="fieldset-legend" htmlFor="max-messages">每个账号最多保留</label><div className={styles.numberControl}><input className="input input-sm" id="max-messages" type="number" min="1" max="10000" value={value} onChange={(event) => setValue(event.target.value)} /><span>封邮件</span></div><p>收件箱和垃圾箱合计计算，超出后删除最旧的本地缓存。</p></div><div className={`fieldset ${styles.settingsField}`}><label className="fieldset-legend" htmlFor="poll-interval">无 IDLE 时轮询间隔</label><div className={styles.numberControl}><input className="input input-sm" id="poll-interval" type="number" min="5" max="3600" value={interval} onChange={(event) => setIntervalValue(event.target.value)} /><span>秒</span></div><p>支持 IDLE 的邮箱保持实时长连接，此设置只用于不支持 IDLE 的服务器。</p></div><Button variant="primary" disabled={busy || unchanged}>{busy ? <Spinner label="正在保存" /> : "保存设置"}</Button></form></section>;
}

function ConfirmDialog({ open, title, description, descriptionClassName, confirmLabel, danger = false, onOpenChange, onConfirm }: { open: boolean; title: string; description: string; descriptionClassName?: string; confirmLabel: string; danger?: boolean; onOpenChange: (open: boolean) => void; onConfirm: () => void }) {
  return <AlertDialog.Root open={open} onOpenChange={onOpenChange}><AlertDialog.Portal><AlertDialog.Overlay className={styles.overlay} /><AlertDialog.Content className={styles.confirmDialog}><AlertDialog.Title>{title}</AlertDialog.Title><AlertDialog.Description className={descriptionClassName}>{description}</AlertDialog.Description><div className={`modal-action ${styles.dialogFooter}`}><AlertDialog.Cancel asChild><Button>取消</Button></AlertDialog.Cancel><AlertDialog.Action asChild><Button variant={danger ? "danger" : "primary"} onClick={onConfirm}>{confirmLabel}</Button></AlertDialog.Action></div></AlertDialog.Content></AlertDialog.Portal></AlertDialog.Root>;
}
