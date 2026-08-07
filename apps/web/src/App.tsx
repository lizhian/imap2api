import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import * as AlertDialog from "@radix-ui/react-alert-dialog";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  Archive, ArrowLeft, Check, ChevronLeft, ChevronRight, CircleAlert, CircleCheck,
  Cloud, Edit3, Eye, EyeOff, FileText, Inbox, KeyRound, LogOut, Mail, MailCheck,
  Menu, Paperclip, Plus, RefreshCw, SearchX, Settings as SettingsIcon, ShieldCheck,
  SlidersHorizontal, Trash2, UserRound, X
} from "lucide-react";
import type { Account, AccountInput, AccountUpdate, MessageDetail, MessageListResponse, MessageSummary, MessageView, ProviderId, ServerEvent, Settings } from "@imap2api/shared";
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

type Page = "messages" | "accounts" | "settings";

function formatDate(value: string | null, compact = false): string {
  if (!value) return "尚未同步";
  const date = new Date(value);
  return new Intl.DateTimeFormat("zh-CN", compact
    ? { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }
    : { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }
  ).format(date);
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
      <motion.form initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.24 }} className={styles.loginPanel} onSubmit={submit}>
        <div className={styles.brandMark}><Mail size={20} strokeWidth={2} /></div>
        <h1>imap2api</h1>
        <div className={styles.field}>
          <label htmlFor="token">访问 Token</label>
          <div className={styles.passwordField}>
            <input id="token" value={value} onChange={(event) => setValue(event.target.value)} type={visible ? "text" : "password"} autoFocus autoComplete="current-password" required />
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
  const [messageRevision, setMessageRevision] = useState(0);
  const [notice, setNotice] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const reducedMotion = useReducedMotion();

  const loadAccounts = useCallback(async () => {
    try { setAccounts(await api.request<Account[]>("/accounts")); }
    catch (error) { setNotice({ kind: "error", text: error instanceof Error ? error.message : "账号加载失败" }); }
  }, [api]);

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
              void loadAccounts();
              refreshMessages();
            } else if (event.type === "account.changed") {
              void loadAccounts();
            } else if (event.type === "messages.changed") {
              refreshMessages();
            }
          }, controller.signal);
        } catch {
          if (controller.signal.aborted) break;
          const delays = [1000, 2000, 5000, 10_000, 30_000];
          await abortableDelay(delays[Math.min(retry++, delays.length - 1)]!, controller.signal);
        }
      }
    })();
    return () => {
      controller.abort();
      if (messageRefresh) clearTimeout(messageRefresh);
    };
  }, [api, loadAccounts]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 3800);
    return () => clearTimeout(timer);
  }, [notice]);

  const navigate = (next: Page) => { location.hash = next; setPage(next); };
  const title = page === "messages" ? "邮件" : page === "accounts" ? "邮箱账号" : "系统设置";

  return (
    <div className={styles.appShell}>
      <aside className={styles.sidebar}>
        <div className={styles.sidebarBrand}><span className={styles.brandMark}><Mail size={18} /></span><strong>imap2api</strong></div>
        <nav aria-label="主导航">
          <NavButton active={page === "messages"} icon={<Inbox size={18} />} label="邮件" onClick={() => navigate("messages")} />
          <NavButton active={page === "accounts"} icon={<UserRound size={18} />} label="邮箱账号" onClick={() => navigate("accounts")} />
          <NavButton active={page === "settings"} icon={<SettingsIcon size={18} />} label="系统设置" onClick={() => navigate("settings")} />
        </nav>
        <button className={styles.logoutButton} onClick={onLogout}><LogOut size={17} />退出</button>
      </aside>
      <div className={styles.mainColumn}>
        <header className={styles.topbar}>
          <div><p className={styles.eyebrow}>IMAP 控制台</p><h1>{title}</h1></div>
          <div className={styles.systemState}><span className={styles.liveDot} />服务正常</div>
        </header>
        <main className={styles.mainContent}>
          <AnimatePresence mode="wait" initial={false}>
            <motion.div key={page} className={styles.pageFrame} initial={reducedMotion ? { opacity: 0 } : { opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={reducedMotion ? { opacity: 0 } : { opacity: 0, y: -4 }} transition={{ duration: reducedMotion ? 0.08 : 0.2 }}>
              {page === "messages" && <MessagesPage api={api} accounts={accounts} revision={messageRevision} onNotice={setNotice} />}
              {page === "accounts" && <AccountsPage api={api} accounts={accounts} reload={loadAccounts} onNotice={setNotice} />}
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
      <AnimatePresence>{notice && <motion.div role="status" aria-live="polite" className={`${styles.notice} ${styles[notice.kind]}`} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 4 }}>{notice.kind === "success" ? <CircleCheck size={17} /> : <CircleAlert size={17} />}{notice.text}</motion.div>}</AnimatePresence>
    </div>
  );
}

function NavButton({ active, icon, label, onClick }: { active: boolean; icon: ReactNode; label: string; onClick: () => void }) {
  return <button className={`${styles.navButton} ${active ? styles.navActive : ""}`} aria-current={active ? "page" : undefined} onClick={onClick}>{icon}<span>{label}</span></button>;
}

function AccountsPage({ api, accounts, reload, onNotice }: { api: ApiClient; accounts: Account[]; reload: () => Promise<void>; onNotice: (notice: { kind: "success" | "error"; text: string }) => void }) {
  const [editing, setEditing] = useState<Account | "new" | null>(null);
  const [deleting, setDeleting] = useState<Account | null>(null);
  const [localSyncing, setLocalSyncing] = useState<Set<string>>(new Set());
  const [pollIntervalSeconds, setPollIntervalSeconds] = useState(10);

  useEffect(() => { void api.request<Settings>("/settings").then((value) => setPollIntervalSeconds(value.pollIntervalSeconds)); }, [api]);

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

  return (
    <section className={styles.section}>
      <div className={styles.sectionToolbar}><div><h2>已连接账号</h2><p>{accounts.length} 个邮箱</p></div><Button variant="primary" onClick={() => setEditing("new")}><Plus size={16} />添加邮箱</Button></div>
      {accounts.length === 0 ? <EmptyState icon={<Cloud size={28} />} title="还没有邮箱账号" action={<Button variant="primary" onClick={() => setEditing("new")}><Plus size={16} />添加邮箱</Button>} /> :
        <div className={styles.accountList}>
          {accounts.map((account) => {
            const syncing = localSyncing.has(account.id) || account.status === "connecting";
            return <article key={account.id} className={`${styles.accountRow} ${syncing ? styles.syncing : ""}`}>
              <div className={styles.accountIdentity}><span className={styles.mailAvatar}><Mail size={18} /></span><div><strong>{account.email}</strong><span>{PROVIDERS.find((provider) => provider.value === account.provider)?.label ?? account.provider} · {account.imap.host}</span><span>{account.syncMode === "idle" ? "IDLE 实时" : account.syncMode === "polling" ? `每 ${pollIntervalSeconds} 秒轮询` : "正在检测同步模式"}</span></div></div>
              <Status status={syncing ? "connecting" : account.status} />
              <div className={styles.accountTime}><span>最近同步</span><strong>{formatDate(account.lastSyncedAt, true)}</strong>{account.lastError && <small title={account.lastError}>{account.lastError}</small>}</div>
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
  return <span className={`${styles.status} ${styles[`status_${status}`]}`}><Icon size={14} className={status === "connecting" ? styles.rotating : ""} />{labels[status]}</span>;
}

function AccountDialog({ open, account, api, onOpenChange, onSaved }: { open: boolean; account: Account | null; api: ApiClient; onOpenChange: (open: boolean) => void; onSaved: (message: string) => void }) {
  const [email, setEmail] = useState(""); const [password, setPassword] = useState("");
  const [provider, setProvider] = useState<ProviderId>("auto"); const [host, setHost] = useState("");
  const [port, setPort] = useState("993"); const [secure, setSecure] = useState(true);
  const [advanced, setAdvanced] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setEmail(account?.email ?? ""); setPassword(""); setProvider(account?.provider ?? "auto");
    setHost(account?.imap.host ?? ""); setPort(String(account?.imap.port ?? 993)); setSecure(account?.imap.secure ?? true);
    setAdvanced(account?.provider === "custom"); setError("");
  }, [open, account]);

  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError("");
    const imap = { provider, ...(advanced && host ? { host } : {}), ...(advanced ? { port: Number(port), secure } : {}) };
    try {
      if (account) {
        const body: AccountUpdate = { email, imap, ...(password ? { password } : {}) };
        await api.request(`/accounts/${account.id}`, { method: "PATCH", body: JSON.stringify(body) });
        onSaved("邮箱账号已更新");
      } else {
        const body: AccountInput = { email, password, imap };
        await api.request("/accounts", { method: "POST", body: JSON.stringify(body) });
        onSaved("邮箱账号已添加");
      }
    } catch (reason) { setError(reason instanceof Error ? reason.message : "保存失败"); }
    finally { setBusy(false); }
  };

  return <Dialog.Root open={open} onOpenChange={onOpenChange}><Dialog.Portal><Dialog.Overlay className={styles.overlay} /><Dialog.Content className={styles.dialog}>
    <div className={styles.dialogHeader}><div><Dialog.Title>{account ? "编辑邮箱" : "添加邮箱"}</Dialog.Title><Dialog.Description>{account ? "留空密码将保留现有授权码" : "使用邮箱密码或服务商授权码连接"}</Dialog.Description></div><Dialog.Close asChild><IconButton label="关闭"><X size={18} /></IconButton></Dialog.Close></div>
    <form className={styles.accountForm} onSubmit={submit}>
      <div className={styles.field}><label htmlFor="account-email">邮箱地址</label><input id="account-email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} required autoFocus /></div>
      <div className={styles.field}><label htmlFor="account-password">密码 / 授权码</label><input id="account-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} required={!account} autoComplete="new-password" placeholder={account ? "留空表示不修改" : "请输入授权码"} /></div>
      <div className={styles.field}><label htmlFor="account-provider">邮箱服务商</label><select id="account-provider" value={provider} onChange={(event) => { const value = event.target.value as ProviderId; setProvider(value); if (value === "custom") setAdvanced(true); }}>{PROVIDERS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></div>
      <button type="button" className={styles.disclosure} onClick={() => setAdvanced((value) => !value)} aria-expanded={advanced}><SlidersHorizontal size={16} />高级 IMAP 配置<span>{advanced ? "收起" : "展开"}</span></button>
      {advanced && <motion.div className={styles.advancedFields} initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }}>
        <div className={styles.fieldWide}><div className={styles.field}><label htmlFor="imap-host">主机</label><input id="imap-host" value={host} onChange={(event) => setHost(event.target.value)} placeholder="imap.example.com" required={provider === "custom"} /></div><div className={styles.field}><label htmlFor="imap-port">端口</label><input id="imap-port" type="number" min="1" max="65535" value={port} onChange={(event) => setPort(event.target.value)} /></div></div>
        <label className={styles.checkbox}><input type="checkbox" checked={secure} onChange={(event) => setSecure(event.target.checked)} /><span><Check size={13} /></span>使用 TLS 加密连接</label>
      </motion.div>}
      {error && <p className={styles.formError} role="alert"><CircleAlert size={15} />{error}</p>}
      <div className={styles.dialogFooter}><Dialog.Close asChild><Button type="button">取消</Button></Dialog.Close><Button variant="primary" disabled={busy}>{busy ? <Spinner label="正在保存" /> : "保存账号"}</Button></div>
    </form>
  </Dialog.Content></Dialog.Portal></Dialog.Root>;
}

function MessagesPage({ api, accounts, revision, onNotice }: { api: ApiClient; accounts: Account[]; revision: number; onNotice: (notice: { kind: "success" | "error"; text: string }) => void }) {
  const [accountId, setAccountId] = useState(""); const [view, setView] = useState<MessageView>("all");
  const [items, setItems] = useState<MessageSummary[]>([]); const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null); const [detail, setDetail] = useState<MessageDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false); const [cursor, setCursor] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null); const [history, setHistory] = useState<Array<string | null>>([]);
  const [confirmAll, setConfirmAll] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const query = new URLSearchParams({ view, limit: "50" });
    if (accountId) query.set("accountId", accountId); if (cursor) query.set("cursor", cursor);
    try { const result = await api.request<MessageListResponse>(`/messages?${query}`); setItems(result.items); setNextCursor(result.nextCursor); if (selected && !result.items.some((item) => item.id === selected)) { setSelected(null); setDetail(null); } }
    catch (error) { onNotice({ kind: "error", text: error instanceof Error ? error.message : "邮件加载失败" }); }
    finally { setLoading(false); }
  }, [accountId, api, cursor, onNotice, revision, selected, view]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { setCursor(null); setHistory([]); setSelected(null); setDetail(null); }, [accountId, view]);

  const openMessage = async (message: MessageSummary) => {
    setSelected(message.id); setDetailLoading(true);
    try { const value = await api.request<MessageDetail>(`/messages/${message.id}`); setDetail(value); }
    catch (error) { onNotice({ kind: "error", text: error instanceof Error ? error.message : "邮件详情加载失败" }); }
    finally { setDetailLoading(false); }
  };

  const mark = async (message: MessageSummary | MessageDetail, read: boolean) => {
    try { await api.request(`/messages/${message.id}/read`, { method: "PATCH", body: JSON.stringify({ read }) }); setItems((rows) => rows.map((row) => row.id === message.id ? { ...row, read } : row)); setDetail((value) => value?.id === message.id ? { ...value, read } : value); }
    catch (error) { onNotice({ kind: "error", text: error instanceof Error ? error.message : "标记失败" }); }
  };

  const markAll = async () => {
    if (!accountId) return;
    try {
      const result = await api.request<{ count: number; failedFolders: string[] }>(`/accounts/${accountId}/messages/read-all`, { method: "POST" });
      onNotice({ kind: result.failedFolders.length ? "error" : "success", text: result.failedFolders.length ? `已处理 ${result.count} 封，部分文件夹失败` : `已标记 ${result.count} 封邮件` });
      setConfirmAll(false); await load();
    } catch (error) { onNotice({ kind: "error", text: error instanceof Error ? error.message : "全部已读失败" }); }
  };

  return <section className={styles.mailWorkspace}>
    <div className={`${styles.mailListPane} ${selected ? styles.mobileHidden : ""}`}>
      <div className={styles.mailControls}>
        <select aria-label="筛选邮箱账号" value={accountId} onChange={(event) => setAccountId(event.target.value)}><option value="">全部账号</option>{accounts.map((account) => <option key={account.id} value={account.id}>{account.email}</option>)}</select>
        <div className={styles.segmented} aria-label="邮件视图">{(["all", "unread", "junk"] as const).map((item) => <button key={item} className={view === item ? styles.segmentActive : ""} onClick={() => setView(item)}>{item === "all" ? "全部" : item === "unread" ? "未读" : "垃圾箱"}</button>)}</div>
        <IconButton label="全部已读" disabled={!accountId || !items.some((item) => !item.read)} onClick={() => setConfirmAll(true)}><MailCheck size={17} /></IconButton>
      </div>
      <div className={styles.messageList} aria-busy={loading}>
        {loading ? <div className={styles.centerState}><Spinner /></div> : items.length === 0 ? <EmptyState icon={<SearchX size={27} />} title="没有符合条件的邮件" /> : items.map((message) => <button key={message.id} className={`${styles.messageRow} ${selected === message.id ? styles.messageSelected : ""} ${message.read ? styles.messageRead : ""}`} onClick={() => void openMessage(message)}>
          <span className={styles.unreadDot} aria-label={message.read ? "已读" : "未读"} />
          <span className={styles.messageMain}><span className={styles.messageMeta}><strong>{senderLabel(message)}</strong><time>{formatDate(message.displayTime, true)}</time></span><span className={styles.messageSubject}>{message.subject}</span><span className={styles.messagePreview}>{message.preview || "无正文预览"}</span></span>
          <span className={styles.messageFlags}>{message.folder === "junk" && <Archive size={14} aria-label="垃圾箱" />}{message.hasAttachments && <Paperclip size={14} aria-label="包含附件" />}</span>
        </button>)}
      </div>
      <div className={styles.pagination}><Button variant="quiet" disabled={!history.length} onClick={() => { const previous = [...history]; const value = previous.pop() ?? null; setHistory(previous); setCursor(value); }}><ChevronLeft size={16} />上一页</Button><span>每页 50 封</span><Button variant="quiet" disabled={!nextCursor} onClick={() => { setHistory((values) => [...values, cursor]); setCursor(nextCursor); }} >下一页<ChevronRight size={16} /></Button></div>
    </div>
    <div className={`${styles.detailPane} ${selected ? styles.detailVisible : ""}`}>
      {detailLoading ? <div className={styles.centerState}><Spinner label="正在读取邮件" /></div> : detail ? <MessageDetailView message={detail} onBack={() => { setSelected(null); setDetail(null); }} onMark={(read) => void mark(detail, read)} /> : <EmptyState icon={<FileText size={28} />} title="选择一封邮件查看内容" />}
    </div>
    <ConfirmDialog open={confirmAll} title="将缓存邮件全部标记为已读？" description="操作会同步更新当前账号已缓存的收件箱和垃圾箱邮件。" confirmLabel="全部已读" onOpenChange={setConfirmAll} onConfirm={() => void markAll()} />
  </section>;
}

function MessageDetailView({ message, onBack, onMark }: { message: MessageDetail; onBack: () => void; onMark: (read: boolean) => void }) {
  const addressList = (values: MessageDetail["to"]) => values.map((item) => item.name ? `${item.name} <${item.address}>` : item.address).join(", ") || "—";
  const srcDoc = message.html ? `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>body{font:14px/1.65 -apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif;color:#1d1d1f;margin:0;padding:20px;overflow-wrap:anywhere}a{color:#0066cc}table{border-collapse:collapse;max-width:100%}td,th{border:1px solid #d2d2d7;padding:6px}pre{white-space:pre-wrap}</style></head><body>${message.html}</body></html>` : "";
  return <article className={styles.messageDetail}>
    <div className={styles.detailToolbar}><IconButton label="返回邮件列表" className={styles.backButton} onClick={onBack}><ArrowLeft size={18} /></IconButton><span className={styles.detailFolder}>{message.folder === "junk" ? "垃圾箱" : "收件箱"}</span><IconButton label={message.read ? "标记为未读" : "标记为已读"} onClick={() => onMark(!message.read)}>{message.read ? <Mail size={17} /> : <MailCheck size={17} />}</IconButton></div>
    <header className={styles.detailHeader}><h2>{message.subject}</h2><time>{formatDate(message.displayTime)}</time><dl><div><dt>发件人</dt><dd>{addressList(message.from)}</dd></div><div><dt>收件人</dt><dd>{addressList(message.to)}</dd></div>{message.cc.length > 0 && <div><dt>抄送</dt><dd>{addressList(message.cc)}</dd></div>}{message.attachments.length > 0 && <div><dt>附件</dt><dd className={styles.attachments}>{message.attachments.map((name) => <span key={name}><Paperclip size={13} />{name}</span>)}</dd></div>}</dl></header>
    <div className={styles.bodyDivider} />
    {message.html ? <iframe title="邮件正文" sandbox="" className={styles.mailBodyFrame} srcDoc={srcDoc} /> : <pre className={styles.textBody}>{message.text || "（无正文）"}</pre>}
  </article>;
}

function SettingsPage({ api, onNotice }: { api: ApiClient; onNotice: (notice: { kind: "success" | "error"; text: string }) => void }) {
  const [settings, setSettings] = useState<Settings | null>(null); const [value, setValue] = useState("100"); const [interval, setIntervalValue] = useState("10"); const [busy, setBusy] = useState(false);
  useEffect(() => { api.request<Settings>("/settings").then((result) => { setSettings(result); setValue(String(result.maxMessagesPerAccount)); setIntervalValue(String(result.pollIntervalSeconds)); }).catch((error) => onNotice({ kind: "error", text: error.message })); }, [api, onNotice]);
  const save = async (event: FormEvent) => { event.preventDefault(); setBusy(true); try { const result = await api.request<Settings>("/settings", { method: "PATCH", body: JSON.stringify({ maxMessagesPerAccount: Number(value), pollIntervalSeconds: Number(interval) }) }); setSettings(result); onNotice({ kind: "success", text: "系统设置已保存" }); } catch (error) { onNotice({ kind: "error", text: error instanceof Error ? error.message : "保存失败" }); } finally { setBusy(false); } };
  if (!settings) return <div className={styles.centerState}><Spinner /></div>;
  const unchanged = Number(value) === settings.maxMessagesPerAccount && Number(interval) === settings.pollIntervalSeconds;
  return <section className={styles.settingsSection}><div className={styles.sectionToolbar}><div><h2>同步与缓存</h2><p>全局邮件策略</p></div></div><form className={styles.settingsForm} onSubmit={save}><div><label htmlFor="max-messages">每个账号最多保留</label><div className={styles.numberControl}><input id="max-messages" type="number" min="1" max="10000" value={value} onChange={(event) => setValue(event.target.value)} /><span>封邮件</span></div><p>收件箱和垃圾箱合计计算，超出后删除最旧的本地缓存。</p></div><div><label htmlFor="poll-interval">无 IDLE 时轮询间隔</label><div className={styles.numberControl}><input id="poll-interval" type="number" min="5" max="3600" value={interval} onChange={(event) => setIntervalValue(event.target.value)} /><span>秒</span></div><p>支持 IDLE 的邮箱保持实时长连接，此设置只用于不支持 IDLE 的服务器。</p></div><Button variant="primary" disabled={busy || unchanged}>{busy ? <Spinner label="正在保存" /> : "保存设置"}</Button></form></section>;
}

function ConfirmDialog({ open, title, description, confirmLabel, danger = false, onOpenChange, onConfirm }: { open: boolean; title: string; description: string; confirmLabel: string; danger?: boolean; onOpenChange: (open: boolean) => void; onConfirm: () => void }) {
  return <AlertDialog.Root open={open} onOpenChange={onOpenChange}><AlertDialog.Portal><AlertDialog.Overlay className={styles.overlay} /><AlertDialog.Content className={styles.confirmDialog}><AlertDialog.Title>{title}</AlertDialog.Title><AlertDialog.Description>{description}</AlertDialog.Description><div className={styles.dialogFooter}><AlertDialog.Cancel asChild><Button>取消</Button></AlertDialog.Cancel><AlertDialog.Action asChild><Button variant={danger ? "danger" : "primary"} onClick={onConfirm}>{confirmLabel}</Button></AlertDialog.Action></div></AlertDialog.Content></AlertDialog.Portal></AlertDialog.Root>;
}
