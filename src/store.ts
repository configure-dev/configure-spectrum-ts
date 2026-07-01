import type {
  ConfigureSpectrumJourney,
  ConfigureSpectrumStore,
  ConfigureSpectrumSubject,
  ConfigureSpectrumSubjectPatch,
} from "./types.js";

export function memoryStore(): ConfigureSpectrumStore {
  const subjects = new Map<string, ConfigureSpectrumSubject>();
  const journeys = new Map<string, ConfigureSpectrumJourney>();
  const claimedMessages = new Map<string, number>();

  return {
    async getSubject(key) {
      const subject = subjects.get(key);
      return subject ? { ...subject } : null;
    },

    async saveSubject(key, patch) {
      const now = new Date().toISOString();
      const existing = subjects.get(key);
      const next: ConfigureSpectrumSubject = {
        key,
        externalId: patch.externalId ?? existing?.externalId ?? key,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        ...existing,
      };

      applyPatch(next, patch);
      next.updatedAt = now;
      subjects.set(key, next);
    },

    async saveJourney(journey) {
      journeys.set(journey.journeyId, { ...journey });
    },

    async consumeJourney(journeyId) {
      const journey = journeys.get(journeyId);
      if (!journey) return null;
      journeys.delete(journeyId);
      return { ...journey };
    },

    async claimMessage(key, ttlMs = 24 * 60 * 60 * 1000) {
      const now = Date.now();
      for (const [claimKey, expiresAt] of claimedMessages) {
        if (expiresAt <= now) claimedMessages.delete(claimKey);
      }
      if (claimedMessages.has(key)) return false;
      claimedMessages.set(key, now + ttlMs);
      return true;
    },
  };
}

function applyPatch(subject: ConfigureSpectrumSubject, patch: ConfigureSpectrumSubjectPatch): void {
  if (patch.externalId !== undefined) subject.externalId = patch.externalId;
  setNullable(subject, "configureToken", patch.configureToken);
  setNullable(subject, "configureUserId", patch.configureUserId);
  setNullable(subject, "signInSentAt", patch.signInSentAt);
}

function setNullable<T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: T[K] | null | undefined
): void {
  if (value === undefined) return;
  if (value === null) {
    delete target[key];
    return;
  }
  target[key] = value;
}
