import { describe, expect, it, vi } from "vitest";
import type { Message, Space } from "spectrum-ts";
import { withConfigure, type ConfigureSpectrumStore } from "../src/index.js";

const baseOptions = {
  apiKey: "sk_test",
  publishableKey: "pk_test",
  agent: "test-agent",
};

describe("withConfigure", () => {
  it("validates required options", () => {
    expect(() =>
      withConfigure({
        ...baseOptions,
        apiKey: "",
        store: withConfigure.localStore(),
      })
    ).toThrow(/apiKey/);
  });

  it("falls back to a developer-scoped external identity", async () => {
    const store = withConfigure.localStore();
    const configureSpectrum = withConfigure({ ...baseOptions, store });
    const ctx = await configureSpectrum.resolve(space(), message({ sender: { id: "slack-user" }, platform: "slack" }));

    expect(ctx.linked).toBe(false);
    expect(ctx.identity.source).toBe("external_id");
    expect(ctx.subject.externalId).toMatch(/^spectrum:sp_/);
    expect(await store.getSubject(ctx.subject.key)).toMatchObject({ externalId: ctx.subject.externalId });
  });

  it("recognizes approved phone-backed senders and stores the returned token", async () => {
    const store = withConfigure.localStore();
    const fetch = jsonFetch(({ pathname }) => {
      expect(pathname).toBe("/v1/auth/sign-in/recognize-phone");
      return {
        matched: true,
        recognized: true,
        approved: true,
        linked: true,
        token: "agent-token",
        user_id: "user-1",
      };
    });
    const configureSpectrum = withConfigure({ ...baseOptions, store, fetch });
    const ctx = await configureSpectrum.resolve(
      space(),
      message({ platform: "iMessage", sender: { id: "+14155551234", address: "+14155551234" } })
    );

    expect(ctx.linked).toBe(true);
    expect(ctx.identity.source).toBe("phone_recognition");
    expect(ctx.identity.token).toBe("agent-token");
    expect(await store.getSubject(ctx.subject.key)).toMatchObject({
      configureToken: "agent-token",
      configureUserId: "user-1",
    });
  });

  it("does not treat recognized but unapproved phones as linked", async () => {
    const store = withConfigure.localStore();
    const fetch = jsonFetch(() => ({
      matched: true,
      recognized: true,
      approved: false,
      linked: false,
    }));
    const configureSpectrum = withConfigure({ ...baseOptions, store, fetch });
    const ctx = await configureSpectrum.resolve(
      space(),
      message({ platform: "iMessage", sender: { id: "+14155551234", address: "+14155551234" } })
    );

    expect(ctx.recognized).toBe(true);
    expect(ctx.linked).toBe(false);
    expect(ctx.identity.token).toBeUndefined();
    expect(await store.getSubject(ctx.subject.key)).toMatchObject({ externalId: ctx.subject.externalId });
  });

  it("validates stored tokens on first use and then reuses the result", async () => {
    const store = withConfigure.localStore();
    await store.saveSubject("subject-1", {
      externalId: "spectrum:subject-1",
      configureToken: "stored-token",
      configureUserId: "user-1",
    });
    let validations = 0;
    const fetch = jsonFetch(({ pathname }) => {
      expect(pathname).toBe("/v1/auth/sign-in/validate");
      validations += 1;
      return { valid: true, approved: true, token_use: "agent", user_id: "user-1", agent: "test-agent" };
    });
    const configureSpectrum = withConfigure({
      ...baseOptions,
      store,
      fetch,
      identity: {
        subjectKey: () => "subject-1",
        externalId: () => "spectrum:subject-1",
      },
    });

    const first = await configureSpectrum.resolve(space(), message());
    const second = await configureSpectrum.resolve(space(), message());

    expect(first.linked).toBe(true);
    expect(second.linked).toBe(true);
    expect(validations).toBe(1);
  });

  it("clears stored tokens that do not validate for the current agent", async () => {
    const store = withConfigure.localStore();
    await store.saveSubject("subject-1", {
      externalId: "spectrum:subject-1",
      configureToken: "stored-token",
      configureUserId: "user-1",
    });
    const fetch = jsonFetch(({ pathname }) => {
      expect(pathname).toBe("/v1/auth/sign-in/validate");
      return { valid: true, approved: true, token_use: "agent", user_id: "user-1", agent: "other-agent" };
    });
    const configureSpectrum = withConfigure({
      ...baseOptions,
      store,
      fetch,
      identity: {
        subjectKey: () => "subject-1",
        externalId: () => "spectrum:subject-1",
      },
    });

    const ctx = await configureSpectrum.resolve(space(), message());

    expect(ctx.linked).toBe(false);
    expect(ctx.identity.source).toBe("external_id");
    expect(await store.getSubject("subject-1")).toMatchObject({
      externalId: "spectrum:subject-1",
    });
    expect((await store.getSubject("subject-1"))?.configureToken).toBeUndefined();
  });

  it("memoizes one sign-in journey per context", async () => {
    const store = countingStore(withConfigure.localStore());
    const configureSpectrum = withConfigure({
      ...baseOptions,
      store,
      signIn: {
        messageCompleteUrl: "https://agent.example.com/auth/configure/complete",
      },
    });
    const ctx = await configureSpectrum.resolve(space(), message());
    const first = await ctx.signInUrl();
    const second = await ctx.signInUrl();

    expect(new URL(first).searchParams.get("journey")).toBeTruthy();
    expect(new URL(first).searchParams.get("journey")).toBe(new URL(second).searchParams.get("journey"));
    expect(store.savedJourneys).toBe(1);
  });

  it("returns a clean sign-in link for the plain message flow (no pk, no params)", async () => {
    const store = withConfigure.localStore();
    const configureSpectrum = withConfigure({
      ...baseOptions,
      store,
      signIn: { displayName: "Test Agent", agentPhone: "+14155550000", connectors: ["gmail"] },
    });
    const ctx = await configureSpectrum.resolve(space(), message());
    const url = new URL(await ctx.signInUrl());

    expect(url.origin + url.pathname).toBe("https://sign-in.me/test-agent");
    expect(url.search).toBe(""); // no ?pk=, no delivery, no message_line_phone
    expect(url.searchParams.get("pk")).toBeNull();
  });

  it("validates completion callbacks before storing tokens", async () => {
    const store = withConfigure.localStore();
    await store.saveSubject("subject-1", { externalId: "spectrum:subject-1" });
    await store.saveJourney?.({
      journeyId: "journey-1",
      subjectKey: "subject-1",
      threadKey: "thread-1",
      spaceId: "space-1",
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const fetch = jsonFetch(() => ({
      valid: true,
      approved: true,
      token_use: "agent",
      user_id: "user-1",
      agent: "test-agent",
    }));
    const configureSpectrum = withConfigure({ ...baseOptions, store, fetch });

    const result = await configureSpectrum.complete({
      token: "agent-token",
      userId: "user-1",
      agent: "test-agent",
      journeyId: "journey-1",
    });

    expect(result).toEqual({ ok: true, linked: true, subjectKey: "subject-1", threadKey: "thread-1" });
    expect(await store.getSubject("subject-1")).toMatchObject({
      configureToken: "agent-token",
      configureUserId: "user-1",
    });
    expect(await store.consumeJourney?.("journey-1")).toBeNull();
  });

  it("skips duplicate messages when the store rejects the claim", async () => {
    const store = {
      ...withConfigure.localStore(),
      claimMessage: vi.fn(async () => false),
    };
    const configureSpectrum = withConfigure({ ...baseOptions, store });
    const handler = vi.fn();

    await expect(configureSpectrum.handle(space(), message(), handler)).resolves.toEqual({ status: "duplicate" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("can send a first-message sign-in link and stop before the handler", async () => {
    const store = withConfigure.localStore();
    const configureSpectrum = withConfigure({
      ...baseOptions,
      store,
      connect: {
        mode: "first-message",
        behavior: "send-and-stop",
        sendOnce: true,
      },
    });
    const inbound = message({ sender: { id: "slack-user" }, platform: "slack" });
    const handler = vi.fn();

    await expect(configureSpectrum.handle(space(), inbound, handler)).resolves.toEqual({ status: "connect-link-sent" });
    expect(inbound.reply).toHaveBeenCalledWith(expect.stringContaining("https://sign-in.me/test-agent"));
    expect(handler).not.toHaveBeenCalled();
  });
});

function space(overrides: Partial<Space> = {}): Space {
  return {
    id: "space-1",
    __platform: "test",
    ...overrides,
  } as Space;
}

function message(overrides: Partial<Message> & { sender?: Record<string, unknown> } = {}): Message {
  return {
    id: "message-1",
    platform: overrides.platform ?? "test",
    content: overrides.content ?? { type: "text", text: "hello" },
    direction: "inbound",
    sender: overrides.sender ?? { id: "sender-1" },
    timestamp: new Date(),
    reply: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as Message;
}

function jsonFetch(handler: (input: { pathname: string; body: unknown }) => unknown): typeof fetch {
  return (async (input, init) => {
    const url = new URL(String(input));
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const result = handler({ pathname: url.pathname, body });
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

function countingStore(inner: ConfigureSpectrumStore): ConfigureSpectrumStore & { savedJourneys: number } {
  return {
    ...inner,
    savedJourneys: 0,
    async saveJourney(journey) {
      this.savedJourneys += 1;
      await inner.saveJourney?.(journey);
    },
  };
}
