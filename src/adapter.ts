import { randomUUID } from "node:crypto";
import { Configure } from "configure";
import type { SignInTokenValidationResult } from "configure";
import type { Message, Space } from "spectrum-ts";
import { deriveIdentity, messageKey, reconnectUrl, textFromMessage } from "./identity.js";
import { localStore } from "./store.js";
import type {
  ConfigureSpectrum,
  ConfigureSpectrumCompleteInput,
  ConfigureSpectrumCompleteResult,
  ConfigureSpectrumConnectOptions,
  ConfigureSpectrumContext,
  ConfigureSpectrumFactory,
  ConfigureSpectrumHandleResult,
  ConfigureSpectrumIdentityInput,
  ConfigureSpectrumOptions,
  ConfigureSpectrumSignInMessage,
  ConfigureSpectrumSubject,
  ConfigureSpectrumTokenValidation,
} from "./types.js";

const DEFAULT_CONNECT_INTENT = /\b(connect|link|sign[\s-]?in|log[\s-]?in|login)\b/i;

function createWithConfigure(options: ConfigureSpectrumOptions): ConfigureSpectrum {
  assertRequired(options.apiKey, "apiKey");
  assertRequired(options.publishableKey, "publishableKey");
  assertRequired(options.agent, "agent");
  if (!options.store) throw new Error("withConfigure: missing required option \"store\"");

  const configure = new Configure({
    apiKey: options.apiKey,
    agent: options.agent,
    baseUrl: options.baseUrl,
    timeout: options.timeout,
    fetch: options.fetch,
  });
  const validatedTokens = new Set<string>();
  const journeyByContext = new WeakMap<ConfigureSpectrumContext, string>();

  async function resolve(space: Space, message: Message): Promise<ConfigureSpectrumContext> {
    const identityInput: ConfigureSpectrumIdentityInput = { space, message };
    const derived = await deriveConfiguredIdentity(identityInput, options);
    const saved = await options.store.getSubject(derived.subjectKey);
    const validationPolicy = options.identity?.validateStoredToken ?? "on-first-use";
    const storedToken = saved?.configureToken;

    if (storedToken) {
      const validStored = await resolveStoredToken(storedToken, saved, validationPolicy);
      if (validStored) {
        return createContext({
          space,
          message,
          derived,
          saved,
          identity: {
            externalId: derived.externalId,
            token: storedToken,
            userId: saved?.configureUserId,
            linked: true,
            approved: true,
            recognized: false,
            source: "token",
          },
        });
      }
      await options.store.saveSubject(derived.subjectKey, {
        externalId: derived.externalId,
        configureToken: null,
        configureUserId: null,
      });
    }

    if (derived.phoneCandidates.length > 0) {
      try {
        const recognition = await configure.auth.recognizePhone(derived.phoneCandidates);
        const recognizedToken = recognition.token || recognition.agentToken;
        if (recognition.approved && recognizedToken) {
          await options.store.saveSubject(derived.subjectKey, {
            externalId: derived.externalId,
            configureToken: recognizedToken,
            configureUserId: recognition.userId,
          });
          return createContext({
            space,
            message,
            derived,
            saved,
            recognition,
            identity: {
              externalId: derived.externalId,
              token: recognizedToken,
              userId: recognition.userId,
              linked: true,
              approved: true,
              recognized: true,
              displayName: recognition.displayName,
              source: "phone_recognition",
            },
          });
        }
        if (recognition.recognized) {
          await options.store.saveSubject(derived.subjectKey, { externalId: derived.externalId });
          return createContext({
            space,
            message,
            derived,
            saved,
            recognition,
            identity: {
              externalId: derived.externalId,
              linked: false,
              approved: false,
              recognized: true,
              displayName: recognition.displayName,
              source: "external_id",
            },
          });
        }
      } catch (error) {
        options.logger?.warn?.("configure phone recognition failed; falling back to externalId", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    await options.store.saveSubject(derived.subjectKey, { externalId: derived.externalId });
    return createContext({
      space,
      message,
      derived,
      saved,
      identity: {
        externalId: derived.externalId,
        linked: false,
        approved: false,
        recognized: false,
        source: "external_id",
      },
    });
  }

  async function handle(
    space: Space,
    message: Message,
    handler: (ctx: ConfigureSpectrumContext) => void | Promise<void>
  ): Promise<ConfigureSpectrumHandleResult> {
    if (options.store.claimMessage) {
      const claimed = await options.store.claimMessage(messageKey(space, message));
      if (!claimed) return { status: "duplicate" };
    }

    const ctx = await resolve(space, message);
    if (!ctx.linked && (await shouldConnect(ctx, options.connect))) {
      await ctx.replyWithSignIn();
      if ((options.connect?.behavior ?? "send-and-stop") === "send-and-stop") {
        return { status: "connect-link-sent" };
      }
    }

    await handler(ctx);
    return { status: "handled" };
  }

  async function complete(input: ConfigureSpectrumCompleteInput): Promise<ConfigureSpectrumCompleteResult> {
    if (!input.token) return { ok: false, linked: false };
    if (!input.journeyId) return { ok: false, linked: false };
    if (!options.store.consumeJourney) {
      throw new Error("withConfigure.complete requires store.consumeJourney");
    }

    const validation = await configure.auth.validateSignInToken(input.token);
    if (!isValidAgentToken(validation, options.agent)) return { ok: false, linked: false };
    if (input.agent && input.agent !== options.agent) return { ok: false, linked: false };
    if (input.userId && validation.userId && input.userId !== validation.userId) return { ok: false, linked: false };

    const journey = await options.store.consumeJourney(input.journeyId);
    if (!journey) return { ok: false, linked: false };

    await options.store.saveSubject(journey.subjectKey, {
      configureToken: input.token,
      configureUserId: validation.userId || input.userId,
    });
    return { ok: true, linked: true, subjectKey: journey.subjectKey, threadKey: journey.threadKey };
  }

  async function resolveStoredToken(
    token: string,
    saved: ConfigureSpectrumSubject | null,
    policy: ConfigureSpectrumTokenValidation
  ): Promise<boolean> {
    if (policy === "never") return true;
    if (policy === "on-first-use" && validatedTokens.has(token)) return true;
    try {
      const validation = await configure.auth.validateSignInToken(token);
      if (!isValidAgentToken(validation, options.agent)) return false;
      validatedTokens.add(token);
      if (validation.userId && saved && validation.userId !== saved.configureUserId) {
        await options.store.saveSubject(saved.key, { configureUserId: validation.userId });
      }
      return true;
    } catch (error) {
      options.logger?.warn?.("configure token validation failed; falling back to externalId", {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  function createContext(input: {
    space: Space;
    message: Message;
    derived: Awaited<ReturnType<typeof deriveConfiguredIdentity>>;
    saved: ConfigureSpectrumSubject | null;
    identity: ConfigureSpectrumContext["identity"];
    recognition?: ConfigureSpectrumContext["recognition"];
  }): ConfigureSpectrumContext {
    const profile = configure.profile(
      input.identity.token ? { token: input.identity.token } : { externalId: input.derived.externalId }
    );
    const ctx: ConfigureSpectrumContext = {
      space: input.space,
      message: input.message,
      text: textFromMessage(input.message),
      platform: input.message.platform,
      subject: {
        key: input.derived.subjectKey,
        externalId: input.derived.externalId,
        ...(input.derived.senderId ? { senderId: input.derived.senderId } : {}),
        ...(input.saved?.signInSentAt ? { signInSentAt: input.saved.signInSentAt } : {}),
      },
      thread: {
        key: input.derived.threadKey,
        spaceId: input.space.id,
      },
      identity: input.identity,
      ...(input.recognition ? { recognition: input.recognition } : {}),
      linked: input.identity.linked,
      approved: input.identity.approved,
      recognized: input.identity.recognized,
      profile,
      signInUrl: async (overrides = {}) => {
        let journeyId = journeyByContext.get(ctx);
        if (!journeyId && options.signIn?.messageCompleteUrl) {
          if (!options.store.saveJourney) {
            throw new Error("ctx.signInUrl requires store.saveJourney when messageCompleteUrl is configured");
          }
          journeyId = randomUUID();
          journeyByContext.set(ctx, journeyId);
          const now = new Date();
          await options.store.saveJourney({
            journeyId,
            subjectKey: input.derived.subjectKey,
            threadKey: input.derived.threadKey,
            spaceId: input.space.id,
            messageId: input.message.id,
            createdAt: now.toISOString(),
            expiresAt: new Date(now.getTime() + 15 * 60 * 1000).toISOString(),
          });
        }
        // A message sign-in link is just the agent's first-party hosted page. The
        // hosted OTP flow is public, so the plain flow needs no publishable key or
        // query params — a clean `sign-in.me/<agent>` is enough, and the agent
        // re-recognizes the user by phone on their next message. The verbose form
        // (pk + journey + connectors) is only used when a messageCompleteUrl journey
        // is configured, or the caller passes explicit overrides.
        if (!journeyId && Object.keys(overrides).length === 0) {
          const origin = (options.signIn?.signInOrigin ?? "https://sign-in.me").replace(/\/+$/, "");
          return `${origin}/${encodeURIComponent(options.agent)}`;
        }
        return configure.auth.signInUrl({
          publishableKey: options.publishableKey,
          delivery: "message",
          displayName: options.signIn?.displayName,
          agentLogo: options.signIn?.agentLogo,
          messageLinePhone: options.signIn?.agentPhone,
          messageBody: options.signIn?.messageBody,
          messageCompleteUrl: options.signIn?.messageCompleteUrl,
          connectors: options.signIn?.connectors,
          theme: options.signIn?.theme,
          signInOrigin: options.signIn?.signInOrigin,
          ...(journeyId ? { journeyId } : {}),
          ...overrides,
        });
      },
      reconnectUrl: () => reconnectUrl(options.agent),
      replyWithSignIn: async (replyOptions = {}) => {
        const url = await ctx.signInUrl();
        const body = await signInMessage(ctx, url, replyOptions.message ?? options.connect?.message);
        await input.message.reply(body);
        await options.store.saveSubject(input.derived.subjectKey, {
          externalId: input.derived.externalId,
          signInSentAt: new Date().toISOString(),
        });
      },
    };
    return ctx;
  }

  return { resolve, handle, complete };
}

export const withConfigure: ConfigureSpectrumFactory = Object.assign(createWithConfigure, {
  localStore,
});

async function deriveConfiguredIdentity(input: ConfigureSpectrumIdentityInput, options: ConfigureSpectrumOptions) {
  const base = await deriveIdentity(input);
  const customPhoneCandidates = options.identity?.phoneCandidates
    ? await options.identity.phoneCandidates(input)
    : base.phoneCandidates;
  const subjectKey = options.identity?.subjectKey ? await options.identity.subjectKey(input) : base.subjectKey;
  const threadKey = options.identity?.threadKey ? await options.identity.threadKey(input) : base.threadKey;
  const externalId = options.identity?.externalId
    ? await options.identity.externalId({ ...input, subjectKey })
    : `spectrum:${subjectKey}`;
  return {
    ...base,
    subjectKey,
    threadKey,
    externalId,
    phoneCandidates: unique(customPhoneCandidates),
  };
}

async function shouldConnect(
  ctx: ConfigureSpectrumContext,
  connect: ConfigureSpectrumConnectOptions | undefined
): Promise<boolean> {
  const mode = connect?.mode ?? "manual";
  if (mode === "manual") return false;
  if (connect?.sendOnce && ctx.subject.signInSentAt) return false;
  if (mode === "first-message") return true;
  const intent = connect?.intent ?? DEFAULT_CONNECT_INTENT;
  if (intent instanceof RegExp) return Boolean(ctx.text && intent.test(ctx.text));
  return intent(ctx);
}

async function signInMessage(
  ctx: ConfigureSpectrumContext,
  url: string,
  message: ConfigureSpectrumSignInMessage | undefined
): Promise<string> {
  if (typeof message === "function") {
    return message.length <= 1
      ? (message as (url: string) => string | Promise<string>)(url)
      : (message as (ctx: ConfigureSpectrumContext, url: string) => string | Promise<string>)(ctx, url);
  }
  if (typeof message === "string") return message.replaceAll("{url}", url);
  return `Connect your Configure profile: ${url}`;
}

function isValidAgentToken(validation: SignInTokenValidationResult, agent: string): boolean {
  if (!validation.valid || validation.approved === false) return false;
  if (validation.tokenUse && validation.tokenUse !== "agent") return false;
  if (validation.agent && validation.agent !== agent) return false;
  return true;
}

function assertRequired(value: string | undefined, name: string): void {
  if (!value) throw new Error(`withConfigure: missing required option "${name}"`);
}

function unique(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = String(value || "").trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}
