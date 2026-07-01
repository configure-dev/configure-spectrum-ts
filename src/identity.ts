import { createHash } from "node:crypto";
import type { Message, Space } from "spectrum-ts";
import type { ConfigureSpectrumIdentityInput } from "./types.js";

export interface DerivedIdentity {
  subjectKey: string;
  threadKey: string;
  externalId: string;
  phoneCandidates: string[];
  senderId?: string;
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
  return {
    subjectKey,
    threadKey,
    externalId: `spectrum:${subjectKey}`,
    phoneCandidates,
    ...(senderId ? { senderId } : {}),
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

export function reconnectUrl(agent: string): string {
  return `https://sign-in.me/${encodeURIComponent(agent)}/reconnect`;
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
