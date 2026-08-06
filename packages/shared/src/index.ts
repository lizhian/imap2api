export type ProviderId = "auto" | "qq" | "gmail" | "icloud" | "outlook" | "qq-enterprise" | "163" | "custom";
export type ConnectionStatus = "pending" | "connecting" | "connected" | "warning" | "error";
export type MessageView = "all" | "unread" | "junk";

export interface ImapConfig {
  provider: ProviderId;
  host?: string;
  port?: number;
  secure?: boolean;
}

export interface Account {
  id: string;
  email: string;
  provider: ProviderId;
  imap: Required<Pick<ImapConfig, "host" | "port" | "secure">>;
  hasCredential: true;
  status: ConnectionStatus;
  lastSyncedAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AccountInput {
  email: string;
  password: string;
  imap?: ImapConfig;
}

export interface AccountUpdate {
  email?: string;
  password?: string;
  imap?: ImapConfig;
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
}

export interface MessageDetail extends MessageSummary {
  to: Address[];
  cc: Address[];
  attachments: string[];
  text: string;
  html: string | null;
}

export interface MessageListResponse {
  items: MessageSummary[];
  nextCursor: string | null;
}

export interface Settings {
  maxMessagesPerAccount: number;
}

export interface ApiError {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}
