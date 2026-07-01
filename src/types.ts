import type {
  Configure,
  ConnectorName,
  MessageIdentity,
  SignInPhoneRecognitionResult,
  SignInUrlOptions,
} from "configure";
import type { Message, Space } from "spectrum-ts";

export type ProfileRuntime = ReturnType<Configure["profile"]>;

export type ConfigureSpectrumConnectMode = "manual" | "intent" | "first-message";
export type ConfigureSpectrumTokenValidation = "never" | "always" | "on-first-use";
export type ConfigureSpectrumSignInMessage =
  | string
  | ((ctx: ConfigureSpectrumContext, url: string) => string | Promise<string>)
  | ((url: string) => string | Promise<string>);

export interface ConfigureSpectrumLogger {
  debug?(message: string, fields?: Record<string, unknown>): void;
  warn?(message: string, fields?: Record<string, unknown>): void;
  error?(message: string, fields?: Record<string, unknown>): void;
}

export interface ConfigureSpectrumSignInOptions {
  displayName?: string;
  agentLogo?: string;
  agentPhone?: string;
  connectors?: ConnectorName[] | string;
  messageBody?: string;
  messageCompleteUrl?: string;
  theme?: "light" | "dark";
  signInOrigin?: string;
}

export interface ConfigureSpectrumConnectOptions {
  mode?: ConfigureSpectrumConnectMode;
  intent?: RegExp | ((ctx: ConfigureSpectrumContext) => boolean | Promise<boolean>);
  sendOnce?: boolean;
  behavior?: "send-and-stop" | "send-and-continue";
  message?: ConfigureSpectrumSignInMessage;
}

export interface ConfigureSpectrumIdentityInput {
  space: Space;
  message: Message;
}

export interface ConfigureSpectrumIdentityOptions {
  subjectKey?: (input: ConfigureSpectrumIdentityInput) => string | Promise<string>;
  threadKey?: (input: ConfigureSpectrumIdentityInput) => string | Promise<string>;
  phoneCandidates?: (input: ConfigureSpectrumIdentityInput) => string[] | Promise<string[]>;
  externalId?: (input: ConfigureSpectrumIdentityInput & { subjectKey: string }) => string | Promise<string>;
  validateStoredToken?: ConfigureSpectrumTokenValidation;
}

export interface ConfigureSpectrumOptions {
  apiKey: string;
  publishableKey: string;
  agent: string;
  store: ConfigureSpectrumStore;

  baseUrl?: string;
  timeout?: number;
  fetch?: typeof fetch;

  signIn?: ConfigureSpectrumSignInOptions;
  connect?: ConfigureSpectrumConnectOptions;
  identity?: ConfigureSpectrumIdentityOptions;
  logger?: ConfigureSpectrumLogger;
}

export interface ConfigureSpectrumSubject {
  key: string;
  externalId: string;
  configureToken?: string;
  configureUserId?: string;
  signInSentAt?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface ConfigureSpectrumSubjectPatch {
  externalId?: string;
  configureToken?: string | null;
  configureUserId?: string | null;
  signInSentAt?: string | null;
}

export interface ConfigureSpectrumJourney {
  journeyId: string;
  subjectKey: string;
  threadKey: string;
  spaceId: string;
  messageId?: string;
  createdAt: string;
  expiresAt: string;
}

export interface ConfigureSpectrumStore {
  getSubject(key: string): Promise<ConfigureSpectrumSubject | null>;
  saveSubject(key: string, value: ConfigureSpectrumSubjectPatch): Promise<void>;

  saveJourney?(journey: ConfigureSpectrumJourney): Promise<void>;
  consumeJourney?(journeyId: string): Promise<ConfigureSpectrumJourney | null>;

  claimMessage?(key: string, ttlMs?: number): Promise<boolean>;
}

export interface ConfigureSpectrumSubjectContext {
  key: string;
  externalId: string;
  senderId?: string;
  signInSentAt?: string;
}

export interface ConfigureSpectrumThreadContext {
  key: string;
  spaceId: string;
}

export interface ConfigureSpectrumContext {
  space: Space;
  message: Message;

  text: string | null;
  platform: string;

  subject: ConfigureSpectrumSubjectContext;
  thread: ConfigureSpectrumThreadContext;

  identity: MessageIdentity;
  recognition?: SignInPhoneRecognitionResult;

  linked: boolean;
  approved: boolean;
  recognized: boolean;

  profile: ProfileRuntime;

  signInUrl(options?: Partial<SignInUrlOptions>): Promise<string>;
  reconnectUrl(): string;
  replyWithSignIn(options?: {
    message?: ConfigureSpectrumSignInMessage;
  }): Promise<void>;
}

export interface ConfigureSpectrumCompleteInput {
  token?: string;
  userId?: string;
  agent?: string;
  journeyId?: string;
}

export interface ConfigureSpectrumCompleteResult {
  ok: boolean;
  linked: boolean;
  subjectKey?: string;
  threadKey?: string;
}

export type ConfigureSpectrumHandleResult =
  | { status: "handled" }
  | { status: "duplicate" }
  | { status: "connect-link-sent" };

export interface ConfigureSpectrum {
  resolve(space: Space, message: Message): Promise<ConfigureSpectrumContext>;
  handle(
    space: Space,
    message: Message,
    handler: (ctx: ConfigureSpectrumContext) => void | Promise<void>
  ): Promise<ConfigureSpectrumHandleResult>;
  complete(input: ConfigureSpectrumCompleteInput): Promise<ConfigureSpectrumCompleteResult>;
}
