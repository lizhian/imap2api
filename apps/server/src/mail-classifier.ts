import type { Address, MessageLabel } from "@email2api/shared";
import { DomUtils, parseDocument } from "htmlparser2";
import { simpleParser, type AddressObject } from "mailparser";

export const MAIL_CLASSIFICATION_VERSION = 3;

export const FORWARDING_HEADER_FIELDS = [
  "Resent-Sender", "Resent-From", "X-Forwarded-For", "Delivered-To", "X-Original-To",
  "Original-Recipient", "X-Original-Recipient", "Envelope-To", "X-Envelope-To", "To", "Cc"
] as const;

export type ForwardedViaSource = "resent" | "forwarded-header" | "delivery-chain" | "recipient";

export interface ForwardedViaResult {
  address: string;
  source: ForwardedViaSource;
}

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
  forwardedVia?: ForwardedViaResult | null;
}

export interface MailClassificationResult {
  classificationVersion: number;
  labels: MessageLabel[];
  verificationCode: string | null;
  unsubscribeUrl: string | null;
  forwardedVia: string | null;
  forwardedViaSource: ForwardedViaSource | null;
}

export function classifyMail(input: MailClassificationInput): MailClassificationResult {
  const recipients = new Set([input.accountEmail, ...input.aliases].map(normalizeAddress));
  const recipientMismatch = ![...input.to, ...input.cc].some((value) => recipients.has(normalizeAddress(value.address)));
  const fallback = recipientMismatch ? resolveForwardedViaFromRecipients(input) : null;
  const supplied = input.forwardedVia === undefined ? fallback : input.forwardedVia;
  const forwardedVia = supplied && !recipients.has(normalizeAddress(supplied.address)) ? supplied : null;
  const verificationCode = extractVerificationCode(input.text);
  const unsubscribeUrl = extractUnsubscribeUrl(input.html);
  const labels: MessageLabel[] = [];
  if (recipientMismatch || forwardedVia) labels.push("forwarded");
  if (verificationCode) labels.push("verification_code");
  if (unsubscribeUrl) labels.push("unsubscribe");
  return {
    classificationVersion: MAIL_CLASSIFICATION_VERSION, labels, verificationCode, unsubscribeUrl,
    forwardedVia: forwardedVia?.address ?? null, forwardedViaSource: forwardedVia?.source ?? null
  };
}

export async function resolveForwardedVia(input: Omit<MailClassificationInput, "text" | "html" | "forwardedVia"> & { headers?: Buffer }): Promise<ForwardedViaResult | null> {
  const localAddresses = new Set([input.accountEmail, ...input.aliases].map(normalizeAddress));
  const recipientFallback = [...input.to, ...input.cc].some((value) => localAddresses.has(normalizeAddress(value.address)))
    ? null
    : resolveForwardedViaFromRecipients(input);
  if (!input.headers?.length) return recipientFallback;

  let headerLines: ReadonlyArray<{ key: string; line: string }>;
  try {
    const parsed = await simpleParser(Buffer.concat([input.headers, Buffer.from("\r\n\r\n")]), {
      skipHtmlToText: true, skipTextToHtml: true
    });
    headerLines = parsed.headerLines;
  } catch {
    return recipientFallback;
  }

  const tiers: Array<{ keys: ReadonlySet<string>; source: Exclude<ForwardedViaSource, "recipient"> }> = [
    { keys: new Set(["resent-sender"]), source: "resent" },
    { keys: new Set(["resent-from"]), source: "resent" },
    { keys: new Set(["x-forwarded-for"]), source: "forwarded-header" },
    { keys: new Set(["delivered-to", "x-original-to", "original-recipient", "x-original-recipient", "envelope-to", "x-envelope-to"]), source: "delivery-chain" }
  ];
  for (const tier of tiers) {
    const candidate = await firstHeaderCandidate(headerLines, tier.keys, localAddresses);
    if (candidate.state === "conflict") return null;
    if (candidate.state === "match") return { address: candidate.address, source: tier.source };
  }
  return recipientFallback;
}

export function resolveForwardedViaFromRecipients(input: Pick<MailClassificationInput, "accountEmail" | "aliases" | "to" | "cc">): ForwardedViaResult | null {
  const localAddresses = new Set([input.accountEmail, ...input.aliases].map(normalizeAddress));
  const candidates = uniqueAddresses([...input.to, ...input.cc].map((value) => value.address), localAddresses);
  return candidates.length === 1 ? { address: candidates[0]!, source: "recipient" } : null;
}

type HeaderCandidate = { state: "none" | "conflict" } | { state: "match"; address: string };

async function firstHeaderCandidate(headerLines: ReadonlyArray<{ key: string; line: string }>, keys: ReadonlySet<string>, localAddresses: ReadonlySet<string>): Promise<HeaderCandidate> {
  for (const header of headerLines) {
    if (!keys.has(header.key.toLowerCase())) continue;
    const candidates = uniqueAddresses(await parseHeaderAddresses(header.line), localAddresses);
    if (candidates.length > 1) return { state: "conflict" };
    if (candidates.length === 1) return { state: "match", address: candidates[0]! };
  }
  return { state: "none" };
}

async function parseHeaderAddresses(line: string): Promise<string[]> {
  const separator = line.indexOf(":");
  if (separator < 0) return [];
  const value = line.slice(separator + 1).replace(/[\r\n]+[\t ]*/gu, " ").trim();
  if (!value) return [];
  try {
    const parsed = await simpleParser(Buffer.from(`To: ${value}\r\n\r\n`, "utf8"), {
      skipHtmlToText: true, skipTextToHtml: true
    });
    return addressObjectValues(parsed.to);
  } catch {
    return [];
  }
}

function addressObjectValues(value: AddressObject | AddressObject[] | undefined): string[] {
  const objects = Array.isArray(value) ? value : value ? [value] : [];
  return objects.flatMap((object) => object.value.map((item) => item.address ?? ""));
}

function uniqueAddresses(values: string[], excluded: ReadonlySet<string>): string[] {
  return [...new Set(values.map(normalizeAddress).filter((value) => isEmailAddress(value) && !excluded.has(value)))];
}

function isEmailAddress(value: string): boolean {
  return /^[^\s@]+@[^\s@]+$/u.test(value);
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
