import type { Address, MessageLabel } from "@imap2api/shared";
import { DomUtils, parseDocument } from "htmlparser2";

export const MAIL_CLASSIFICATION_VERSION = 1;

const VERIFICATION_KEYWORDS = /验证码|校验码|动态码|一次性密码|\botp\b|verification\s+code|security\s+code|auth(?:entication|orization)?\s+code|\bcode\b/giu;
const VERIFICATION_CODE = /(?<![A-Za-z0-9])(?=[A-Za-z0-9]{4,8}(?![A-Za-z0-9]))(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{4,8}(?![A-Za-z0-9])/gu;
const UNSUBSCRIBE_KEYWORDS = /取消订阅|退订|unsubscribe/iu;

export interface MailClassificationInput {
  accountEmail: string;
  aliases: string[];
  to: Address[];
  cc: Address[];
  text: string;
  html: string | null;
}

export interface MailClassificationResult {
  classificationVersion: number;
  labels: MessageLabel[];
  verificationCode: string | null;
  unsubscribeUrl: string | null;
}

export function classifyMail(input: MailClassificationInput): MailClassificationResult {
  const recipients = new Set([input.accountEmail, ...input.aliases].map(normalizeAddress));
  const forwarded = ![...input.to, ...input.cc].some((value) => recipients.has(normalizeAddress(value.address)));
  const verificationCode = extractVerificationCode(input.text);
  const unsubscribeUrl = extractUnsubscribeUrl(input.html);
  const labels: MessageLabel[] = [];
  if (forwarded) labels.push("forwarded");
  if (verificationCode) labels.push("verification_code");
  if (unsubscribeUrl) labels.push("unsubscribe");
  return { classificationVersion: MAIL_CLASSIFICATION_VERSION, labels, verificationCode, unsubscribeUrl };
}

export function extractVerificationCode(value: string): string | null {
  const text = value.replace(/\s+/gu, " ");
  for (const keyword of text.matchAll(VERIFICATION_KEYWORDS)) {
    const start = keyword.index;
    const end = start + keyword[0].length;
    const after = nearestCode(text.slice(end, end + 48), true);
    if (after) return after;
    const before = nearestCode(text.slice(Math.max(0, start - 48), start), false);
    if (before) return before;
  }
  return null;
}

export function extractUnsubscribeUrl(html: string | null): string | null {
  if (!html) return null;
  const document = parseDocument(html);
  const anchors = DomUtils.findAll((node) => node.name === "a", document.children);
  for (const anchor of anchors) {
    const context = DomUtils.textContent(anchor.parent ?? anchor).replace(/\s+/gu, " ").trim();
    if (!UNSUBSCRIBE_KEYWORDS.test(context)) continue;
    const url = safeHttpUrl(anchor.attribs["data-safe-href"]);
    if (url) return url;
  }
  return null;
}

function nearestCode(value: string, fromStart: boolean): string | null {
  const matches = [...value.matchAll(VERIFICATION_CODE)];
  const match = fromStart ? matches[0] : matches.at(-1);
  return match?.[0] ?? null;
}

function normalizeAddress(value: string): string {
  return value.trim().toLowerCase();
}

function safeHttpUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : null;
  } catch {
    return null;
  }
}
