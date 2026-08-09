import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type ComponentProps, type DragEvent as ReactDragEvent, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import {
  Bold, Check, CircleAlert, Italic, Link2, List, ListOrdered, Paperclip, Redo2, RefreshCw, Send,
  Underline as UnderlineIcon, Undo2, X
} from "lucide-react";
import type { Account, SendMailInput, SendMailResult, Settings } from "@imap2api/shared";
import { ApiClient } from "./api";
import { Button, EmptyState, IconButton, Spinner } from "./components";
import styles from "./styles.module.css";

interface ComposePageProps {
  api: ApiClient;
  accounts: Account[];
  onNotice: (notice: { kind: "success" | "error"; text: string }) => void;
}

type RecipientKind = "to" | "cc" | "bcc";
type RecipientState = Record<RecipientKind, string[]>;
type RecipientDraftState = Record<RecipientKind, string>;

const RECIPIENT_KINDS: RecipientKind[] = ["to", "cc", "bcc"];
const RECIPIENT_DRAG_TYPE = "application/x-imap2api-recipient";
const emptyRecipients = (): RecipientState => ({ to: [], cc: [], bcc: [] });
const emptyRecipientDrafts = (): RecipientDraftState => ({ to: "", cc: "", bcc: "" });

export function ComposePage({ api, accounts, onNotice }: ComposePageProps) {
  const availableAccounts = useMemo(() => accounts.filter((account) => account.smtp), [accounts]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [settingsError, setSettingsError] = useState("");
  const [accountId, setAccountId] = useState("");
  const [fromAddress, setFromAddress] = useState("");
  const [senderName, setSenderName] = useState("");
  const [recipients, setRecipients] = useState<RecipientState>(emptyRecipients);
  const [recipientDrafts, setRecipientDrafts] = useState<RecipientDraftState>(emptyRecipientDrafts);
  const [showCc, setShowCc] = useState(false);
  const [showBcc, setShowBcc] = useState(false);
  const [subject, setSubject] = useState("");
  const [attachments, setAttachments] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [linkEditorOpen, setLinkEditorOpen] = useState(false);
  const [linkValue, setLinkValue] = useState("");
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const editor = useEditor({
    shouldRerenderOnTransaction: true,
    extensions: [StarterKit.configure({
      blockquote: false, code: false, codeBlock: false, heading: false, horizontalRule: false,
      strike: false, dropcursor: false, gapcursor: false, trailingNode: false,
      link: { openOnClick: false, autolink: false, linkOnPaste: true }
    })],
    content: "",
    editorProps: { attributes: { class: styles.composeEditorContent!, "aria-label": "邮件正文" } }
  });

  const selectedAccount = availableAccounts.find((account) => account.id === accountId) ?? null;
  const loadSettings = useCallback(async () => {
    setSettingsError("");
    try {
      setSettings(await api.request<Settings>("/settings"));
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "系统设置加载失败";
      setSettingsError(message);
      onNotice({ kind: "error", text: message });
    }
  }, [api, onNotice]);
  useEffect(() => { void loadSettings(); }, [loadSettings]);
  useEffect(() => {
    if (accountId && availableAccounts.some((account) => account.id === accountId)) return;
    setAccountId(availableAccounts[0]?.id ?? "");
  }, [accountId, availableAccounts]);
  useEffect(() => {
    if (!selectedAccount) { setFromAddress(""); setSenderName(""); return; }
    setFromAddress((current) => [selectedAccount.email, ...selectedAccount.aliases].includes(current) ? current : selectedAccount.email);
    setSenderName(selectedAccount.defaultSenderName || settings?.defaultSenderName || "");
  }, [selectedAccount?.id, settings?.defaultSenderName]);

  const selectSender = (account: Account, address: string) => {
    const accountChanged = account.id !== accountId;
    setAccountId(account.id);
    setFromAddress(address);
    if (accountChanged) setSenderName(account.defaultSenderName || settings?.defaultSenderName || "");
  };

  const changeRecipientDraft = (kind: RecipientKind, value: string) => {
    const parts = value.split(",");
    if (parts.length === 1) {
      setRecipientDrafts((current) => ({ ...current, [kind]: value }));
      return;
    }
    setRecipients((current) => ({ ...current, [kind]: mergeRecipients(current[kind], parts.slice(0, -1)) }));
    setRecipientDrafts((current) => ({ ...current, [kind]: parts.at(-1) ?? "" }));
    setError("");
  };

  const commitRecipientDraft = (kind: RecipientKind) => {
    const value = recipientDrafts[kind];
    if (!value.trim()) return;
    setRecipients((current) => ({ ...current, [kind]: mergeRecipients(current[kind], [value]) }));
    setRecipientDrafts((current) => ({ ...current, [kind]: "" }));
  };

  const removeRecipient = (kind: RecipientKind, address: string) => {
    setRecipients((current) => ({ ...current, [kind]: current[kind].filter((item) => item !== address) }));
  };

  const moveRecipient = (source: RecipientKind, target: RecipientKind, address: string) => {
    if (source === target) return;
    setRecipients((current) => {
      if (!current[source].includes(address)) return current;
      return {
        ...current,
        [source]: current[source].filter((item) => item !== address),
        [target]: mergeRecipients(current[target], [address])
      };
    });
    if (target === "cc") setShowCc(true);
    if (target === "bcc") setShowBcc(true);
  };

  const addAttachments = (event: ChangeEvent<HTMLInputElement>) => {
    const selected = [...(event.target.files ?? [])];
    event.target.value = "";
    if (!selected.length) return;
    const next = [...attachments, ...selected];
    const maximumBytes = (settings?.maxAttachmentSizeMb ?? 100) * 1024 * 1024;
    if (next.length > 20) { setError("最多添加 20 个附件"); return; }
    if (selected.some((file) => file.size > maximumBytes)) { setError("附件超过系统设置的大小上限"); return; }
    if (next.reduce((total, file) => total + file.size, 0) > maximumBytes) { setError("附件总大小超过系统设置的大小上限"); return; }
    setAttachments(next);
    setError("");
  };

  const applyLink = () => {
    if (!editor) return;
    const value = linkValue.trim();
    if (!value) editor.chain().focus().unsetLink().run();
    else {
      try {
        const url = new URL(value.includes(":") ? value : `https://${value}`);
        if (!["http:", "https:", "mailto:"].includes(url.protocol)) throw new Error();
        editor.chain().focus().extendMarkRange("link").setLink({ href: url.toString() }).run();
      } catch {
        setError("链接地址无效");
        return;
      }
    }
    setLinkEditorOpen(false);
    setLinkValue("");
    setError("");
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedAccount || !editor) return;
    const submittedRecipients = Object.fromEntries(RECIPIENT_KINDS.map((kind) => [
      kind, mergeRecipients(recipients[kind], [recipientDrafts[kind]])
    ])) as unknown as RecipientState;
    setRecipients(submittedRecipients);
    setRecipientDrafts(emptyRecipientDrafts());
    const activeRecipients = [
      ...submittedRecipients.to,
      ...submittedRecipients.cc,
      ...submittedRecipients.bcc
    ];
    if (!activeRecipients.length) { setError("至少填写一个收件人"); return; }
    const invalidAddress = activeRecipients.find((address) => !isValidEmail(address));
    if (invalidAddress) { setError(`邮箱地址无效：${invalidAddress}`); return; }
    if (activeRecipients.length > 100) { setError("收件人、抄送和密送合计不能超过 100 个邮箱"); return; }
    const input: SendMailInput = {
      accountId: selectedAccount.id,
      fromAddress,
      ...(senderName.trim() ? { senderName: senderName.trim() } : {}),
      to: submittedRecipients.to,
      ...(submittedRecipients.cc.length ? { cc: submittedRecipients.cc } : {}),
      ...(submittedRecipients.bcc.length ? { bcc: submittedRecipients.bcc } : {}),
      subject,
      html: editor.getHTML()
    };
    setBusy(true);
    setError("");
    try {
      const form = new FormData();
      form.append("message", JSON.stringify(input));
      for (const attachment of attachments) form.append("attachments", attachment, attachment.name);
      const result = await api.requestMultipart<SendMailResult>("/messages/send", form);
      if (result.rejected.length) {
        onNotice({ kind: "error", text: `邮件已部分发送，${result.rejected.length} 个收件人被拒绝` });
      } else {
        onNotice({ kind: "success", text: "邮件已发送" });
      }
      setRecipients(emptyRecipients()); setRecipientDrafts(emptyRecipientDrafts()); setShowCc(false); setShowBcc(false); setSubject(""); setAttachments([]);
      editor.commands.clearContent();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "邮件发送失败");
    } finally {
      setBusy(false);
    }
  };

  if (!settings) return settingsError
    ? <section className={styles.composeSection}><EmptyState icon={<CircleAlert size={28} />} title="写信设置加载失败" action={<Button type="button" onClick={() => void loadSettings()}><RefreshCw size={16} />重新加载</Button>} /></section>
    : <div className={styles.centerState}><Spinner /></div>;
  if (!availableAccounts.length) return <section className={styles.composeSection}><EmptyState icon={<Send size={28} />} title="没有可用于发信的 SMTP 账号" /></section>;

  return <section className={styles.composeSection}>
    <form className={styles.composeForm} onSubmit={submit}>
      <header className={styles.composeHeader}>
        <div><h2>写信</h2><span>新邮件</span></div>
        <Button variant="primary" disabled={busy}>{busy ? <Spinner label="正在发送" /> : <><Send size={16} />发送</>}</Button>
      </header>
      <div className={styles.composeLayout}>
        <aside className={styles.composeIdentityPane} aria-label="发件信息">
          <div className={`${styles.composeIdentityField} ${styles.composeSenderField}`}>
            <label className={styles.composeIdentityLabel} htmlFor="compose-sender-name">发件人名称</label>
            <input className="input input-sm" id="compose-sender-name" aria-label="发件人名称" maxLength={200} value={senderName} onChange={(event) => setSenderName(event.target.value)} placeholder="可选" disabled={busy} />
          </div>
          <div className={`${styles.composeIdentityField} ${styles.composeAccountField}`}>
            <span className={styles.composeIdentityLabel} id="compose-sender-list-label">发件人邮箱</span>
            <div className={styles.composeSenderList} role="listbox" aria-labelledby="compose-sender-list-label">
              {availableAccounts.flatMap((account) => [account.email, ...account.aliases].map((address) =>
                <button type="button" className={`${styles.accountTab} ${styles.composeSenderOption}`} role="option" aria-selected={account.id === accountId && fromAddress === address} title={address} disabled={busy} key={`${account.id}-${address}`} onClick={() => selectSender(account, address)}><span>{address}</span></button>
              ))}
            </div>
          </div>
        </aside>
        <main className={styles.composeMessagePane}>
          <div className={styles.composeMessageFields}>
            <div className={styles.composeAddressRow}>
              <span className={styles.composeAddressLabel} id="compose-from-label">发件人</span>
              <div className={styles.composeFromSummary} role="group" aria-labelledby="compose-from-label">
                {senderName.trim() && <strong title={senderName.trim()}>{senderName.trim()}</strong>}
                <span title={fromAddress}>{fromAddress}</span>
              </div>
            </div>
            <div className={styles.composeAddressRow}>
              <label htmlFor="compose-to">收件人</label><RecipientField kind="to" label="收件人" values={recipients.to} draft={recipientDrafts.to} placeholder="recipient@example.com" busy={busy} onDraftChange={changeRecipientDraft} onCommit={commitRecipientDraft} onRemove={removeRecipient} onMove={moveRecipient} />
              <div className={styles.composeAddressActions}><button type="button" aria-pressed={showCc} onClick={() => setShowCc((value) => !value)}>抄送</button><button type="button" aria-pressed={showBcc} onClick={() => setShowBcc((value) => !value)}>密送</button></div>
            </div>
            {showCc && <div className={styles.composeAddressRow}><label htmlFor="compose-cc">抄送</label><RecipientField kind="cc" label="抄送" values={recipients.cc} draft={recipientDrafts.cc} busy={busy} onDraftChange={changeRecipientDraft} onCommit={commitRecipientDraft} onRemove={removeRecipient} onMove={moveRecipient} /></div>}
            {showBcc && <div className={styles.composeAddressRow}><label htmlFor="compose-bcc">密送</label><RecipientField kind="bcc" label="密送" values={recipients.bcc} draft={recipientDrafts.bcc} busy={busy} onDraftChange={changeRecipientDraft} onCommit={commitRecipientDraft} onRemove={removeRecipient} onMove={moveRecipient} /></div>}
            <div className={styles.composeAddressRow}><label htmlFor="compose-subject">主题</label><input className="input input-sm" id="compose-subject" maxLength={998} value={subject} onChange={(event) => setSubject(event.target.value)} disabled={busy} /></div>
          </div>
          <div className={styles.composeEditor}>
            <div className={styles.composeToolbar} aria-label="正文格式工具栏">
              <FormatButton label="粗体" active={editor?.isActive("bold")} disabled={busy} onClick={() => editor?.chain().focus().toggleBold().run()}><Bold size={16} /></FormatButton>
              <FormatButton label="斜体" active={editor?.isActive("italic")} disabled={busy} onClick={() => editor?.chain().focus().toggleItalic().run()}><Italic size={16} /></FormatButton>
              <FormatButton label="下划线" active={editor?.isActive("underline")} disabled={busy} onClick={() => editor?.chain().focus().toggleUnderline().run()}><UnderlineIcon size={16} /></FormatButton>
              <FormatButton label="项目列表" active={editor?.isActive("bulletList")} disabled={busy} onClick={() => editor?.chain().focus().toggleBulletList().run()}><List size={16} /></FormatButton>
              <FormatButton label="编号列表" active={editor?.isActive("orderedList")} disabled={busy} onClick={() => editor?.chain().focus().toggleOrderedList().run()}><ListOrdered size={16} /></FormatButton>
              <FormatButton label="链接" active={editor?.isActive("link")} disabled={busy} onClick={() => { setLinkValue(editor?.getAttributes("link").href ?? ""); setLinkEditorOpen((value) => !value); }}><Link2 size={16} /></FormatButton>
              <span className={styles.composeToolbarSpacer} />
              <FormatButton label="撤销" disabled={busy || !editor?.can().chain().focus().undo().run()} onClick={() => editor?.chain().focus().undo().run()}><Undo2 size={16} /></FormatButton>
              <FormatButton label="重做" disabled={busy || !editor?.can().chain().focus().redo().run()} onClick={() => editor?.chain().focus().redo().run()}><Redo2 size={16} /></FormatButton>
            </div>
            {linkEditorOpen && <div className={styles.composeLinkEditor}><input className="input input-sm" aria-label="链接地址" value={linkValue} onChange={(event) => setLinkValue(event.target.value)} placeholder="https://example.com" autoFocus /><IconButton type="button" label="应用链接" onClick={applyLink}><Check size={16} /></IconButton><IconButton type="button" label="取消链接编辑" onClick={() => setLinkEditorOpen(false)}><X size={16} /></IconButton></div>}
            <EditorContent className={styles.composeEditorBody} editor={editor} />
            {attachments.length > 0 && <ul className={styles.composeAttachmentList}>{attachments.map((file, index) => <li key={`${file.name}-${file.lastModified}-${index}`}><span><strong>{file.name}</strong><small>{formatBytes(file.size)}</small></span><IconButton type="button" label={`移除附件 ${file.name}`} disabled={busy} onClick={() => setAttachments((current) => current.filter((_, itemIndex) => itemIndex !== index))}><X size={16} /></IconButton></li>)}</ul>}
            <div className={styles.composeEditorFooter}>
              <div className={styles.composeAttachments}>
                <input ref={fileInputRef} className={styles.srOnly} type="file" multiple onChange={addAttachments} tabIndex={-1} />
                <IconButton type="button" label="添加附件" disabled={busy || attachments.length >= 20} onClick={() => fileInputRef.current?.click()}><Paperclip size={17} /></IconButton>
                <span>{attachments.length ? `${attachments.length} 个附件 · ${formatBytes(attachments.reduce((total, file) => total + file.size, 0))}` : "添加附件"}</span>
              </div>
            </div>
          </div>
          {error && <p className={styles.formError} role="alert">{error}</p>}
        </main>
      </div>
    </form>
  </section>;
}

function FormatButton({ label, active = false, ...props }: ComponentProps<typeof IconButton> & { active?: boolean }) {
  return <IconButton type="button" label={label} aria-pressed={active} className={active ? styles.composeFormatActive : ""} {...props} />;
}

interface RecipientFieldProps {
  kind: RecipientKind;
  label: string;
  values: string[];
  draft: string;
  placeholder?: string;
  busy: boolean;
  onDraftChange: (kind: RecipientKind, value: string) => void;
  onCommit: (kind: RecipientKind) => void;
  onRemove: (kind: RecipientKind, address: string) => void;
  onMove: (source: RecipientKind, target: RecipientKind, address: string) => void;
}

function RecipientField({ kind, label, values, draft, placeholder, busy, onDraftChange, onCommit, onRemove, onMove }: RecipientFieldProps) {
  const [dragActive, setDragActive] = useState(false);
  const moveByKeyboard = (address: string, direction: -1 | 1) => {
    const target = RECIPIENT_KINDS[RECIPIENT_KINDS.indexOf(kind) + direction];
    if (target) onMove(kind, target, address);
  };
  const dropRecipient = (event: ReactDragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragActive(false);
    try {
      const payload = JSON.parse(event.dataTransfer.getData(RECIPIENT_DRAG_TYPE)) as { source?: RecipientKind; address?: string };
      if (payload.source && RECIPIENT_KINDS.includes(payload.source) && payload.address) onMove(payload.source, kind, payload.address);
    } catch {
      // Ignore drags that did not originate from a recipient chip.
    }
  };
  return <div
    className={`${styles.recipientControl} ${dragActive ? styles.recipientControlDragActive : ""}`}
    role="group"
    aria-label={`${label}地址`}
    onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; setDragActive(true); }}
    onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragActive(false); }}
    onDrop={dropRecipient}
  >
    <span className={styles.srOnly} id={`recipient-help-${kind}`}>按 Delete 删除；按 Alt 加上方向键可移动到相邻地址栏</span>
    {values.map((address) => {
      const valid = isValidEmail(address);
      return <span
        className={`${styles.recipientChip} ${valid ? "" : styles.recipientChipInvalid}`}
        role="listitem"
        aria-label={`${label} ${address}`}
        aria-describedby={`recipient-help-${kind}`}
        aria-invalid={!valid || undefined}
        draggable={!busy}
        tabIndex={busy ? -1 : 0}
        key={address}
        onDragStart={(event) => {
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData(RECIPIENT_DRAG_TYPE, JSON.stringify({ source: kind, address }));
          event.dataTransfer.setData("text/plain", address);
        }}
        onKeyDown={(event: ReactKeyboardEvent<HTMLSpanElement>) => {
          if (event.target !== event.currentTarget) return;
          if (event.key === "Delete" || event.key === "Backspace") { event.preventDefault(); onRemove(kind, address); }
          if (event.altKey && event.key === "ArrowUp") { event.preventDefault(); moveByKeyboard(address, -1); }
          if (event.altKey && event.key === "ArrowDown") { event.preventDefault(); moveByKeyboard(address, 1); }
        }}
      ><span title={address}>{address}</span><button type="button" aria-label={`删除${label} ${address}`} disabled={busy} onClick={() => onRemove(kind, address)}><X size={14} /></button></span>;
    })}
    <input
      className={styles.recipientInput}
      id={`compose-${kind}`}
      value={draft}
      onChange={(event) => onDraftChange(kind, event.target.value)}
      onBlur={() => onCommit(kind)}
      onKeyDown={(event) => {
        if (event.key === "Enter") { event.preventDefault(); onCommit(kind); }
        if (event.key === "Backspace" && !draft && values.length) onRemove(kind, values.at(-1)!);
      }}
      placeholder={values.length ? undefined : placeholder}
      disabled={busy}
      autoComplete="off"
      inputMode="email"
    />
  </div>;
}

function mergeRecipients(current: string[], values: string[]): string[] {
  return [...new Set([...current, ...values.map((address) => address.trim().toLowerCase()).filter(Boolean)])];
}

function isValidEmail(value: string): boolean {
  return /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/u.test(value);
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}
