import { createHash } from "node:crypto";
import type { Message, Space } from "spectrum-ts";
import type { ConfigureSpectrumIdentityInput } from "./types.js";

export interface DerivedIdentity {
  subjectKey: string;
  threadKey: string;
  externalId: string;
  phoneCandidates: string[];
  senderId?: string;
  messageSenderProof?: string;
}

export async function deriveIdentity(input: ConfigureSpectrumIdentityInput): Promise<DerivedIdentity> {
  const senderId = stringField(input.message.sender, "id");
  const phoneCandidates = defaultPhoneCandidates(input.space, input.message);
  const phoneMaterial = phoneCandidates[0];
  const material = phoneMaterial
    ? `phone:${canonicalizePhoneish(phoneMaterial)}`
    : `sender:${input.message.platform}:${senderId || input.space.id}`;
  const subjectKey = `sp_${hash(material)}`;
  const threadKey = `${input.message.platform}:${input.space.id}`;
  const messageSenderProof = defaultMessageSenderProof(input.space, input.message);
  return {
    subjectKey,
    threadKey,
    externalId: `spectrum:${subjectKey}`,
    phoneCandidates,
    ...(senderId ? { senderId } : {}),
    ...(messageSenderProof ? { messageSenderProof } : {}),
  };
}

export function defaultPhoneCandidates(space: Space, message: Message): string[] {
  const candidates = [
    stringField(message.sender, "phone"),
    stringField(message.sender, "address"),
    phoneBackedPlatform(message.platform) ? stringField(message.sender, "id") : undefined,
    looksPhoneLike(stringField(message.sender, "id")) ? stringField(message.sender, "id") : undefined,
    looksPhoneLike(stringField(space, "phone")) ? stringField(space, "phone") : undefined,
  ];
  return unique(candidates.filter((value): value is string => Boolean(value && looksPhoneLike(value))));
}

export function textFromMessage(message: Message): string | null {
  const content = message.content;
  if (content && typeof content === "object" && "type" in content && content.type === "text") {
    const text = (content as { text?: unknown }).text;
    return typeof text === "string" ? text : null;
  }
  return null;
}

export function messageKey(space: Space, message: Message): string {
  return `${message.platform}:${space.id}:${message.id}`;
}

export interface ReconnectUrlOptions {
  origin?: string;
  connectors?: string[];
  messageLinePhone?: string;
  messageBody?: string;
}

export function reconnectUrl(agent: string, options: ReconnectUrlOptions = {}): string {
  const origin = (options.origin ?? "https://sign-in.me").replace(/\/+$/, "");
  const url = new URL(`${origin}/${encodeURIComponent(agent)}/reconnect`);
  if (options.connectors && options.connectors.length > 0) {
    url.searchParams.set("connectors", options.connectors.join(","));
  }
  if (options.messageLinePhone) {
    url.searchParams.set("delivery", "message");
    url.searchParams.set("message_line_phone", options.messageLinePhone);
  }
  if (options.messageBody) {
    url.searchParams.set("message_body", options.messageBody);
  }
  return url.toString();
}

function phoneBackedPlatform(platform: string): boolean {
  const normalized = platform.toLowerCase();
  return normalized.includes("imessage") || normalized.includes("whatsapp") || normalized.includes("sms");
}

function looksPhoneLike(value: string | undefined): boolean {
  if (!value) return false;
  if (value.includes("@")) return false;
  const digits = value.replace(/[^\d]/g, "");
  return digits.length >= 8 && digits.length <= 16;
}

function canonicalizePhoneish(value: string): string {
  const trimmed = value.trim();
  const digits = trimmed.replace(/[^\d]/g, "");
  return trimmed.startsWith("+") ? `+${digits}` : digits;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

function unique(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function stringField(value: unknown, field: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = (value as Record<string, unknown>)[field];
  return typeof candidate === "string" && candidate.trim() ? candidate.trim() : undefined;
}

function defaultMessageSenderProof(space: Space, message: Message): string | undefined {
  return firstToken(
    tokenField(message, "messageSenderProof"),
    tokenField(message, "message_sender_proof"),
    tokenField(message, "signedMessageSenderProof"),
    tokenField(message, "signed_message_sender_proof"),
    tokenField(message, "photonMessageSenderProof"),
    tokenField(message, "photon_message_sender_proof"),
    nestedToken(message, "metadata"),
    nestedToken(message, "providerMetadata"),
    nestedToken(message, "provider_metadata"),
    nestedToken(message.sender, "metadata"),
    nestedToken(space, "metadata"),
    nestedToken(space, "providerMetadata"),
    nestedToken(space, "provider_metadata")
  );
}

function nestedToken(value: unknown, field: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  return defaultTokenFromObject((value as Record<string, unknown>)[field]);
}

function defaultTokenFromObject(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  return firstToken(
    tokenField(value, "messageSenderProof"),
    tokenField(value, "message_sender_proof"),
    tokenField(value, "signedMessageSenderProof"),
    tokenField(value, "signed_message_sender_proof"),
    tokenField(value, "photonMessageSenderProof"),
    tokenField(value, "photon_message_sender_proof")
  );
}

function tokenField(value: unknown, field: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = (value as Record<string, unknown>)[field];
  return typeof candidate === "string" && candidate.trim() ? candidate.trim() : undefined;
}

function firstToken(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => Boolean(value));
}
