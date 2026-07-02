import { randomUUID } from "node:crypto";
import { Configure } from "configure";
import type { SignInTokenValidationResult } from "configure";
import type { Message, Space } from "spectrum-ts";
import { deriveIdentity, messageKey, reconnectUrl as buildReconnectUrl, textFromMessage } from "./identity.js";
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
  ConfigureSpectrumMessageUrlFallbackReason,
  ConfigureSpectrumMessageUrlReason,
  ConfigureSpectrumMessageUrlResult,
  ConfigureSpectrumOptions,
  ConfigureSpectrumReconnectOptions,
  ConfigureSpectrumSignInMessage,
  ConfigureSpectrumSignInOptions,
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
  const registeredMessageLines = new Set<string>();
  const journeyByContext = new WeakMap<ConfigureSpectrumContext, string>();
  const messageUrlByContext = new WeakMap<ConfigureSpectrumContext, Map<string, Promise<ConfigureSpectrumMessageUrlResult | null>>>();

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
        ...(input.saved?.signInExpiresAt ? { signInExpiresAt: input.saved.signInExpiresAt } : {}),
        ...(input.saved?.signInIdempotencyKey ? { signInIdempotencyKey: input.saved.signInIdempotencyKey } : {}),
      },
      thread: {
        key: input.derived.threadKey,
        spaceId: input.space.id,
        messageId: input.message.id,
      },
      identity: input.identity,
      ...(input.recognition ? { recognition: input.recognition } : {}),
      linked: input.identity.linked,
      approved: input.identity.approved,
      recognized: input.identity.recognized,
      profile,
      signInUrl: async (overrides = {}) => {
        const returnTarget = await messageReturnTarget(ctx, options);
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
        // A message sign-in link is the agent's first-party hosted page. When
        // Spectrum exposes a reliable return-to-message target, the adapter adds
        // that structured return metadata here instead of asking the model or app
        // prompt to know Configure URL parameters.
        if (!journeyId && Object.keys(overrides).length === 0) {
          const messageUrl = await messageUrlForContext(ctx, input.derived, "signin", connectorIds(options.signIn?.connectors), returnTarget);
          return messageUrl?.url ?? plainSignInUrl(options, returnTarget);
        }
        const signInRequest = {
          publishableKey: options.publishableKey,
          delivery: "message",
          displayName: options.signIn?.displayName,
          agentLogo: options.signIn?.agentLogo,
          messageLinePhone: returnTarget.messageLinePhone,
          messageBody: returnTarget.messageBody,
          messageCompleteUrl: options.signIn?.messageCompleteUrl,
          connectors: options.signIn?.connectors,
          theme: options.signIn?.theme,
          signInOrigin: options.signIn?.signInOrigin,
          ...(journeyId ? { journeyId } : {}),
          ...overrides,
        };
        if ("messageLinePhone" in overrides) {
          signInRequest.messageLinePhone = e164Phone(overrides.messageLinePhone);
        }
        return configure.auth.signInUrl(signInRequest);
      },
      reconnectUrl: async (reconnectOptions = {}) => {
        const reconnectConnectors = connectorIds(reconnectOptions.connectors ?? options.signIn?.connectors);
        const returnTarget = await messageReturnTarget(ctx, options);
        const messageUrl = await messageUrlForContext(ctx, input.derived, "reconnect", reconnectConnectors, returnTarget);
        return messageUrl?.url ?? plainReconnectUrl(options, reconnectConnectors, returnTarget);
      },
      replyWithSignIn: async (replyOptions = {}) => {
        const url = await ctx.signInUrl();
        const body = await signInMessage(ctx, url, replyOptions.message ?? options.connect?.message);
        await input.message.reply(body);
        const messageUrl = await cachedMessageUrl(ctx, "signin", connectorIds(options.signIn?.connectors))?.catch(() => null);
        await options.store.saveSubject(input.derived.subjectKey, {
          externalId: input.derived.externalId,
          signInSentAt: new Date().toISOString(),
          ...(messageUrl?.mode === "minted" ? {
            signInExpiresAt: messageUrl.expiresAt,
            signInIdempotencyKey: messageUrl.idempotencyKey ?? messageUrlIdempotencyKey(ctx, "signin"),
          } : {
            signInExpiresAt: null,
            signInIdempotencyKey: null,
          }),
        });
      },
      replyWithReconnect: async (replyOptions = {}) => {
        const reconnectConnectors = connectorIds(replyOptions.connectors ?? options.signIn?.connectors);
        const url = await ctx.reconnectUrl({ connectors: reconnectConnectors });
        const body = await signInMessage(ctx, url, replyOptions.message ?? "Reconnect your Configure apps: {url}");
        await input.message.reply(body);
      },
    };
    return ctx;
  }

  function messageUrlForContext(
    ctx: ConfigureSpectrumContext,
    derived: Awaited<ReturnType<typeof deriveConfiguredIdentity>>,
    reason: ConfigureSpectrumMessageUrlReason,
    connectorIds?: string[],
    returnTarget?: MessageReturnTarget
  ): Promise<ConfigureSpectrumMessageUrlResult | null> {
    const mode = options.signIn?.linkMode ?? "plain";
    if (mode === "plain") return Promise.resolve(null);

    const existing = cachedMessageUrl(ctx, reason, connectorIds);
    if (existing) return existing;

    const request = {
      reason,
      ctx,
      subjectToken: derived.subjectToken,
      connectorIds,
      idempotencyKey: messageUrlIdempotencyKey(ctx, reason, connectorIds),
      returnTarget,
    };
    const pending = createMessageUrl(request).catch((error) => {
      options.logger?.warn?.("configure message URL creation failed; falling back to plain sign-in link", {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    });
    setCachedMessageUrl(ctx, reason, connectorIds, pending);
    return pending;
  }

  function cachedMessageUrl(
    ctx: ConfigureSpectrumContext,
    reason: ConfigureSpectrumMessageUrlReason,
    connectorIds?: string[]
  ): Promise<ConfigureSpectrumMessageUrlResult | null> | undefined {
    return messageUrlByContext.get(ctx)?.get(messageUrlCacheKey(reason, connectorIds));
  }

  function setCachedMessageUrl(
    ctx: ConfigureSpectrumContext,
    reason: ConfigureSpectrumMessageUrlReason,
    connectorIds: string[] | undefined,
    pending: Promise<ConfigureSpectrumMessageUrlResult | null>
  ): void {
    const key = messageUrlCacheKey(reason, connectorIds);
    let byKey = messageUrlByContext.get(ctx);
    if (!byKey) {
      byKey = new Map();
      messageUrlByContext.set(ctx, byKey);
    }
    byKey.set(key, pending);
  }

  async function createMessageUrl(request: {
    reason: ConfigureSpectrumMessageUrlReason;
    ctx: ConfigureSpectrumContext;
    subjectToken?: string;
    connectorIds?: string[];
    idempotencyKey: string;
    returnTarget?: MessageReturnTarget;
  }): Promise<ConfigureSpectrumMessageUrlResult> {
    if (options.signIn?.mintUrl) {
      return options.signIn.mintUrl(request);
    }

    const auth = configure.auth as unknown as ConfigureMessageAuth;
    const payload = await messageUrlPayload(request, options);
    const registeredPayload = await payloadWithRegisteredMessageLine(payload);
    if (typeof auth.createMessageSignInUrl === "function") {
      return auth.createMessageSignInUrl(registeredPayload);
    }
    return postMessageUrl(registeredPayload);
  }

  async function payloadWithRegisteredMessageLine(payload: MessageUrlPayload): Promise<MessageUrlPayload> {
    if (!payload.messageLinePhone) return payload;
    const registered = await ensureMessageLineRegistered(payload.channel, payload.messageLinePhone);
    if (registered) return payload;
    const { messageLinePhone: _messageLinePhone, messageBody: _messageBody, ...safePayload } = payload;
    return safePayload;
  }

  async function ensureMessageLineRegistered(channel: string, phone: string): Promise<boolean> {
    const key = messageLineRegistrationKey(channel, phone);
    if (registeredMessageLines.has(key)) return true;
    try {
      await registerMessageLine(channel, phone);
      registeredMessageLines.add(key);
      return true;
    } catch (error) {
      options.logger?.warn?.("configure message line registration failed; omitting hosted return phone", {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  async function registerMessageLine(channel: string, phone: string): Promise<void> {
    const registration = messageLineRegistrationPayload(channel, phone, options);
    const auth = configure.auth as unknown as ConfigureMessageAuth;
    if (typeof auth.registerMessageLine === "function") {
      await auth.registerMessageLine(registration);
      return;
    }

    // Compatibility for configure versions before auth.registerMessageLine().
    await postMessageLineRegistration(registration);
  }

  async function postMessageLineRegistration(registration: MessageLineRegistrationPayload): Promise<void> {
    const fetchFn = options.fetch ?? globalThis.fetch;
    if (typeof fetchFn !== "function") {
      throw new Error("fetch is not available");
    }
    const response = await fetchFn(`${apiBaseUrl(options)}/v1/auth/sign-in/message-lines`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": options.apiKey,
        "X-Agent": options.agent,
      },
      body: JSON.stringify(registration),
    });
    if (!response.ok) {
      throw new Error(`message line registration failed with status ${response.status}`);
    }
  }

  async function postMessageUrl(payload: MessageUrlPayload): Promise<ConfigureSpectrumMessageUrlResult> {
    const fetchFn = options.fetch ?? globalThis.fetch;
    if (typeof fetchFn !== "function") {
      const returnTarget = messageReturnTargetFromPayload(payload);
      return {
        mode: "plain",
        url: payload.reason === "reconnect"
          ? plainReconnectUrl(options, payload.connectors, returnTarget)
          : plainSignInUrl(options, returnTarget),
      };
    }
    const response = await fetchFn(`${apiBaseUrl(options)}/v1/auth/sign-in/message-url`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": options.apiKey,
        "X-Agent": options.agent,
      },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      throw new Error(`message URL request failed with status ${response.status}`);
    }
    return normalizeMessageUrlResult(await response.json());
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
  const subjectToken = options.identity?.subjectToken
    ? await options.identity.subjectToken(input)
    : base.subjectToken;
  return {
    ...base,
    subjectKey,
    threadKey,
    externalId,
    phoneCandidates: unique(customPhoneCandidates),
    ...(subjectToken ? { subjectToken } : {}),
  };
}

async function shouldConnect(
  ctx: ConfigureSpectrumContext,
  connect: ConfigureSpectrumConnectOptions | undefined
): Promise<boolean> {
  const mode = connect?.mode ?? "manual";
  if (mode === "manual") return false;
  if (connect?.sendOnce && ctx.subject.signInSentAt && signInStillValid(ctx.subject.signInExpiresAt)) return false;
  if (mode === "first-message") return true;
  const intent = connect?.intent ?? DEFAULT_CONNECT_INTENT;
  if (intent instanceof RegExp) return Boolean(ctx.text && intent.test(ctx.text));
  return intent(ctx);
}

function signInStillValid(expiresAt: string | undefined): boolean {
  if (!expiresAt) return true;
  const timestamp = Date.parse(expiresAt);
  if (Number.isNaN(timestamp)) return true;
  return timestamp > Date.now();
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

interface MessageReturnTarget {
  messageLinePhone?: string;
  messageBody?: string;
}

type MessageUrlPayload = {
  reason: ConfigureSpectrumMessageUrlReason;
  channel: string;
  subject: { key: string; externalId: string; senderId?: string };
  thread?: { key?: string; spaceId?: string; messageId?: string };
  subjectToken?: string;
  connectors?: string[];
  displayName?: string;
  agentLogo?: string;
  theme?: "light" | "dark";
  messageLinePhone?: string;
  messageBody?: string;
  returnMode?: "message";
  idempotencyKey?: string;
};

type MessageLineRegistrationPayload = {
  channel: string;
  phone: string;
  label?: string;
  metadata: Record<string, unknown>;
};

type ConfigureMessageAuth = {
  createMessageSignInUrl?: (input: MessageUrlPayload) => Promise<ConfigureSpectrumMessageUrlResult>;
  registerMessageLine?: (input: MessageLineRegistrationPayload) => Promise<unknown>;
};

function apiBaseUrl(options: ConfigureSpectrumOptions): string {
  return (options.baseUrl ?? "https://api.configure.dev").replace(/\/+$/, "");
}

function plainSignInUrl(options: ConfigureSpectrumOptions, returnTarget: MessageReturnTarget = {}): string {
  const origin = (options.signIn?.signInOrigin ?? "https://sign-in.me").replace(/\/+$/, "");
  const url = new URL(`${origin}/${encodeURIComponent(options.agent)}`);
  if (returnTarget.messageLinePhone) {
    url.searchParams.set("delivery", "message");
    url.searchParams.set("message_line_phone", returnTarget.messageLinePhone);
  }
  if (returnTarget.messageLinePhone && returnTarget.messageBody) {
    url.searchParams.set("message_body", returnTarget.messageBody);
  }
  return url.toString();
}

function plainReconnectUrl(
  options: ConfigureSpectrumOptions,
  connectors?: string[],
  returnTarget: MessageReturnTarget = {}
): string {
  return buildReconnectUrl(options.agent, {
    origin: options.signIn?.signInOrigin,
    connectors,
    messageLinePhone: returnTarget.messageLinePhone,
    messageBody: returnTarget.messageBody,
  });
}

function connectorIds(connectors: ConfigureSpectrumSignInOptions["connectors"] | ConfigureSpectrumReconnectOptions["connectors"] | undefined): string[] | undefined {
  if (Array.isArray(connectors)) return connectors.map(String).filter(Boolean);
  if (typeof connectors === "string") return connectors.split(",").map((item) => item.trim()).filter(Boolean);
}

function messageUrlCacheKey(reason: ConfigureSpectrumMessageUrlReason, connectorIds?: string[]): string {
  return connectorIds && connectorIds.length > 0 ? `${reason}:${connectorIds.join(",")}` : reason;
}

function messageUrlIdempotencyKey(ctx: ConfigureSpectrumContext, reason: ConfigureSpectrumMessageUrlReason, connectorIds?: string[]): string {
  const suffix = connectorIds && connectorIds.length > 0 ? `:${connectorIds.join(",")}` : "";
  return `${messageKey(ctx.space, ctx.message)}:${reason}${suffix}`;
}

function messageLineRegistrationKey(channel: string, phone: string): string {
  return `${channel.toLowerCase().replace(/\s+/g, "")}:${phone}`;
}

function messageLineRegistrationPayload(
  channel: string,
  phone: string,
  options: ConfigureSpectrumOptions
): MessageLineRegistrationPayload {
  return {
    channel,
    phone,
    ...(options.signIn?.displayName ? { label: options.signIn.displayName } : {}),
    metadata: { source: "configure-spectrum" },
  };
}

async function messageUrlPayload(request: {
  reason: ConfigureSpectrumMessageUrlReason;
  ctx: ConfigureSpectrumContext;
  subjectToken?: string;
  connectorIds?: string[];
  idempotencyKey: string;
  returnTarget?: MessageReturnTarget;
}, options: ConfigureSpectrumOptions): Promise<MessageUrlPayload> {
  const signIn = options.signIn;
  const returnTarget = request.returnTarget ?? await messageReturnTarget(request.ctx, options);
  return {
    reason: request.reason,
    channel: request.ctx.platform,
    subject: {
      key: request.ctx.subject.key,
      externalId: request.ctx.subject.externalId,
      ...(request.ctx.subject.senderId ? { senderId: request.ctx.subject.senderId } : {}),
    },
    thread: {
      key: request.ctx.thread.key,
      spaceId: request.ctx.thread.spaceId,
      ...(request.ctx.thread.messageId ? { messageId: request.ctx.thread.messageId } : {}),
    },
    ...(request.subjectToken ? { subjectToken: request.subjectToken } : {}),
    ...(request.connectorIds && request.connectorIds.length > 0 ? { connectors: request.connectorIds } : {}),
    ...(signIn?.displayName ? { displayName: signIn.displayName } : {}),
    ...(signIn?.agentLogo ? { agentLogo: signIn.agentLogo } : {}),
    ...(signIn?.theme ? { theme: signIn.theme } : {}),
    ...(returnTarget.messageLinePhone ? { messageLinePhone: returnTarget.messageLinePhone } : {}),
    ...(returnTarget.messageBody ? { messageBody: returnTarget.messageBody } : {}),
    ...(request.idempotencyKey ? { idempotencyKey: request.idempotencyKey } : {}),
    returnMode: "message" as const,
  };
}

async function messageReturnTarget(
  ctx: ConfigureSpectrumContext,
  options: ConfigureSpectrumOptions
): Promise<MessageReturnTarget> {
  const signIn = options.signIn;
  const messageLinePhone = await configuredAgentPhone(ctx, options)
    ?? spectrumIMessageLinePhone(ctx.space, ctx.message);
  return messageLinePhone
    ? {
        messageLinePhone,
        ...(signIn?.messageBody ? { messageBody: signIn.messageBody } : {}),
      }
    : {};
}

async function configuredAgentPhone(
  ctx: ConfigureSpectrumContext,
  options: ConfigureSpectrumOptions
): Promise<string | undefined> {
  const value = options.signIn?.agentPhone;
  if (typeof value === "function") {
    try {
      return e164Phone(await value(ctx));
    } catch (error) {
      options.logger?.warn?.("configure spectrum agent phone resolver failed; omitting hosted return phone", {
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }
  return e164Phone(value);
}

function messageReturnTargetFromPayload(payload: {
  messageLinePhone?: string;
  messageBody?: string;
}): MessageReturnTarget {
  const messageLinePhone = e164Phone(payload.messageLinePhone);
  return messageLinePhone
    ? {
        messageLinePhone,
        ...(payload.messageBody ? { messageBody: payload.messageBody } : {}),
      }
    : {};
}

function spectrumIMessageLinePhone(space: Space, message: Message): string | undefined {
  if (!isIMessageContext(space, message)) return undefined;
  return e164Phone(stringField(space, "phone"));
}

function isIMessageContext(space: Space, message: Message): boolean {
  return [message.platform, stringField(space, "__platform")]
    .filter((value): value is string => Boolean(value))
    .some((value) => value.toLowerCase() === "imessage");
}

function e164Phone(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return /^\+[1-9]\d{6,14}$/.test(trimmed) ? trimmed : undefined;
}

function normalizeMessageUrlResult(value: unknown): ConfigureSpectrumMessageUrlResult {
  if (!value || typeof value !== "object") {
    throw new Error("message URL response was not an object");
  }
  const input = value as Record<string, unknown>;
  const mode = stringValue(input.mode);
  const url = stringValue(input.url);
  const idempotencyKey = stringValue(input.idempotencyKey) ?? stringValue(input.idempotency_key);
  if (!url) throw new Error("message URL response was missing url");
  if (mode === "minted") {
    const expiresAt = stringValue(input.expiresAt) ?? stringValue(input.expires_at);
    if (!expiresAt) throw new Error("minted message URL response was missing expiresAt");
    return {
      mode: "minted",
      url,
      expiresAt,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    };
  }
  if (mode === "plain") {
    const fallbackReason = messageUrlFallbackReason(
      stringValue(input.fallbackReason) ?? stringValue(input.fallback_reason)
    );
    return {
      mode: "plain",
      url,
      ...(fallbackReason ? { fallbackReason } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
    };
  }
  throw new Error("message URL response had invalid mode");
}

function messageUrlFallbackReason(value: string | undefined): ConfigureSpectrumMessageUrlFallbackReason | undefined {
  if (
    value === "subject_signature_missing" ||
    value === "subject_signature_invalid" ||
    value === "subject_signature_unsupported"
  ) {
    return value;
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringField(value: unknown, field: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  return stringValue((value as Record<string, unknown>)[field]);
}
