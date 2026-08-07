export type ProviderId = "auto" | "qq" | "gmail" | "icloud" | "outlook" | "qq-enterprise" | "163" | "custom";
export type ConnectionStatus = "pending" | "connecting" | "connected" | "warning" | "error";
export type SyncMode = "idle" | "polling";
export type MessageView = "all" | "unread" | "junk";
export type FolderKind = "inbox" | "junk";
export type MessageLabel = "forwarded" | "verification_code" | "unsubscribe";
export type MessageSecondaryFilter = "verification_code" | "attachment" | "forwarded";

export interface ImapConfig {
  provider: ProviderId;
  host?: string;
  port?: number;
  secure?: boolean;
}

export interface Account {
  id: string;
  email: string;
  aliases: string[];
  provider: ProviderId;
  imap: Required<Pick<ImapConfig, "host" | "port" | "secure">>;
  hasCredential: true;
  status: ConnectionStatus;
  syncMode: SyncMode | null;
  messageCount: number;
  unreadCount: number;
  lastSyncedAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AccountInput {
  email: string;
  password: string;
  aliases?: string[];
  imap?: ImapConfig;
}

export interface AccountUpdate {
  email?: string;
  password?: string;
  aliases?: string[];
  imap?: ImapConfig;
}

export interface AccountOrderUpdate {
  accountIds: string[];
}

export interface Address {
  name?: string;
  address: string;
}

export interface MessageSummary {
  id: string;
  accountId: string;
  accountEmail: string;
  subject: string;
  from: Address[];
  preview: string;
  displayTime: string;
  folder: "inbox" | "junk";
  read: boolean;
  hasAttachments: boolean;
  labels: MessageLabel[];
  forwardedVia: string | null;
}

export interface MessageDetail extends MessageSummary {
  to: Address[];
  cc: Address[];
  attachments: string[];
  text: string;
  html: string | null;
  verificationCode: string | null;
  unsubscribeUrl: string | null;
}

export interface MessageListResponse {
  items: MessageSummary[];
  nextCursor: string | null;
}

export interface Settings {
  maxMessagesPerAccount: number;
  pollIntervalSeconds: number;
}

export interface SyncTriggerResult {
  status: "started" | "running";
}

export interface ReadAllResult {
  count: number;
  failedFolders: FolderKind[];
}

export interface ReadyEvent {
  type: "ready";
  serverTime: string;
}

export interface MessagesChangedEvent {
  type: "messages.changed";
  accountId: string;
  folder: "inbox" | "junk";
  addedIds: string[];
  updatedIds: string[];
  deletedIds: string[];
  occurredAt: string;
}

export interface AccountChangedEvent {
  type: "account.changed";
  accountId: string;
  status: ConnectionStatus;
  syncMode: SyncMode | null;
  lastSyncedAt: string | null;
  occurredAt: string;
}

export type ServerEvent = ReadyEvent | MessagesChangedEvent | AccountChangedEvent;

export interface ApiError {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}
