import type { ImapConfig, ProviderId, ResolvedSmtpConfig, SmtpConfig } from "@email2api/shared";
import { InputError } from "./errors.js";

export interface ResolvedImapConfig {
  provider: Exclude<ProviderId, "auto">;
  host: string;
  port: number;
  secure: boolean;
}

const PRESETS: Record<Exclude<ProviderId, "auto" | "custom">, Omit<ResolvedImapConfig, "provider">> = {
  qq: { host: "imap.qq.com", port: 993, secure: true },
  gmail: { host: "imap.gmail.com", port: 993, secure: true },
  icloud: { host: "imap.mail.me.com", port: 993, secure: true },
  outlook: { host: "outlook.office365.com", port: 993, secure: true },
  "qq-enterprise": { host: "imap.exmail.qq.com", port: 993, secure: true },
  "163": { host: "imap.163.com", port: 993, secure: true }
};

const SMTP_PRESETS: Record<Exclude<ProviderId, "auto" | "custom">, ResolvedSmtpConfig> = {
  qq: { host: "smtp.qq.com", port: 465, secure: true },
  gmail: { host: "smtp.gmail.com", port: 465, secure: true },
  icloud: { host: "smtp.mail.me.com", port: 587, secure: false },
  outlook: { host: "smtp-mail.outlook.com", port: 587, secure: false },
  "qq-enterprise": { host: "smtp.exmail.qq.com", port: 465, secure: true },
  "163": { host: "smtp.163.com", port: 465, secure: true }
};

export function detectProvider(email: string): Exclude<ProviderId, "auto" | "custom"> | "custom" {
  const domain = email.trim().toLowerCase().split("@")[1] ?? "";
  if (domain === "qq.com") return "qq";
  if (["gmail.com", "googlemail.com"].includes(domain)) return "gmail";
  if (["icloud.com", "me.com", "mac.com"].includes(domain)) return "icloud";
  if (["outlook.com", "hotmail.com", "live.com", "msn.com"].includes(domain)) return "outlook";
  if (domain === "163.com") return "163";
  return "custom";
}

export function resolveImapConfig(email: string, input?: ImapConfig): ResolvedImapConfig {
  const requested = input?.provider ?? "auto";
  const provider = requested === "auto" ? detectProvider(email) : requested;
  const preset = provider !== "custom" ? PRESETS[provider] : undefined;
  const host = input?.host?.trim() || preset?.host;
  const port = input?.port ?? preset?.port ?? 993;
  const secure = input?.secure ?? preset?.secure ?? true;
  if (!host) throw new InputError("无法识别邮箱服务商，请填写 IMAP 主机或选择服务商预设");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new InputError("IMAP 端口无效");
  return { provider, host, port, secure };
}

export function resolveSmtpConfig(provider: Exclude<ProviderId, "auto">, input?: SmtpConfig | null): ResolvedSmtpConfig | null {
  const preset = provider === "custom" ? undefined : SMTP_PRESETS[provider];
  if (input === null) return preset ?? null;
  const host = input?.host?.trim() || preset?.host;
  if (!host) {
    if (input !== undefined) throw new InputError("自定义 SMTP 配置必须填写 SMTP 主机");
    return null;
  }
  const port = input?.port ?? preset?.port ?? 465;
  const secure = input?.secure ?? preset?.secure ?? true;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new InputError("SMTP 端口无效");
  return { host, port, secure };
}

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  auto: "自动识别",
  qq: "QQ 邮箱",
  gmail: "Gmail",
  icloud: "iCloud",
  outlook: "Outlook",
  "qq-enterprise": "QQ 企业邮箱",
  "163": "163 邮箱",
  custom: "自定义"
};
