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

  it("returns a public hosted sign-in link with safe message return metadata", async () => {
    const store = withConfigure.localStore();
    const configureSpectrum = withConfigure({
      ...baseOptions,
      store,
      signIn: { displayName: "Test Agent", agentPhone: "+14155550000", connectors: ["gmail"] },
    });
    const ctx = await configureSpectrum.resolve(space(), message());
    const url = new URL(await ctx.signInUrl());

    expect(url.origin + url.pathname).toBe("https://sign-in.me/test-agent");
    expect(url.searchParams.get("pk")).toBeNull();
    expect(url.searchParams.get("delivery")).toBe("message");
    expect(url.searchParams.get("message_line_phone")).toBe("+14155550000");
  });

  it("uses a dynamic agent phone resolver when Spectrum has no routed line", async () => {
    const store = withConfigure.localStore();
    const agentPhone = vi.fn(async (ctx) => {
      expect(ctx.thread.spaceId).toBe("space-1");
      return "+14155550199";
    });
    const configureSpectrum = withConfigure({
      ...baseOptions,
      store,
      signIn: { agentPhone, messageBody: "done!" },
    });
    const ctx = await configureSpectrum.resolve(
      space({ __platform: "iMessage", type: "dm" }),
      message({ platform: "iMessage", sender: { id: "+14155551234", address: "+14155551234" } })
    );
    const url = new URL(await ctx.signInUrl());

    expect(agentPhone).toHaveBeenCalledTimes(1);
    expect(url.origin + url.pathname).toBe("https://sign-in.me/test-agent");
    expect(url.searchParams.get("delivery")).toBe("message");
    expect(url.searchParams.get("message_line_phone")).toBe("+14155550199");
    expect(url.searchParams.get("message_body")).toBe("done!");
  });

  it("prefers explicit agent phone over Spectrum routed line metadata", async () => {
    const store = withConfigure.localStore();
    const configureSpectrum = withConfigure({
      ...baseOptions,
      store,
      signIn: { agentPhone: "+14155550999" },
    });
    const ctx = await configureSpectrum.resolve(
      space({ __platform: "iMessage", phone: "+14155550123", type: "dm" }),
      message({ platform: "iMessage", sender: { id: "+14155551234", address: "+14155551234" } })
    );
    const url = new URL(await ctx.signInUrl());

    expect(url.searchParams.get("message_line_phone")).toBe("+14155550999");
  });

  it("uses the message URL API in managed mode when signed subject evidence exists", async () => {
    const store = withConfigure.localStore();
    const fetch = jsonFetch(({ pathname, body }) => {
      expect(pathname).toBe("/v1/auth/sign-in/message-url");
      expect(body).toMatchObject({
        reason: "signin",
        channel: "slack",
        subject: {
          key: "subject-1",
          externalId: "spectrum:subject-1",
          senderId: "slack-user",
        },
        subjectToken: "photon.signed.subject",
        returnMode: "message",
      });
      return {
        mode: "plain",
        url: "https://sign-in.me/test-agent",
        reason: "signin",
        fallbackReason: "subject_signature_unsupported",
      };
    });
    const configureSpectrum = withConfigure({
      ...baseOptions,
      store,
      fetch,
      signIn: { linkMode: "managed" },
      identity: {
        subjectKey: () => "subject-1",
        externalId: () => "spectrum:subject-1",
        subjectToken: () => "photon.signed.subject",
      },
    });

    const ctx = await configureSpectrum.resolve(space(), message({ sender: { id: "slack-user" }, platform: "slack" }));

    await expect(ctx.signInUrl()).resolves.toBe("https://sign-in.me/test-agent");
  });

  it("accepts auto as a compatibility alias for managed link mode", async () => {
    const store = withConfigure.localStore();
    const fetch = jsonFetch(({ pathname }) => {
      expect(pathname).toBe("/v1/auth/sign-in/message-url");
      return {
        mode: "plain",
        url: "https://sign-in.me/test-agent",
        reason: "signin",
        fallbackReason: "subject_signature_missing",
      };
    });
    const configureSpectrum = withConfigure({
      ...baseOptions,
      store,
      fetch,
      signIn: { linkMode: "auto" },
      identity: {
        subjectKey: () => "subject-1",
        externalId: () => "spectrum:subject-1",
      },
    });

    const ctx = await configureSpectrum.resolve(space(), message());

    await expect(ctx.signInUrl()).resolves.toBe("https://sign-in.me/test-agent");
  });

  it("uses the message URL API in managed mode for plain fallback links", async () => {
    const store = withConfigure.localStore();
    const fetch = jsonFetch(({ pathname, body }) => {
      if (pathname === "/v1/auth/sign-in/message-lines") {
        expect(body).toMatchObject({
          channel: "iMessage",
          phone: "+14155550123",
          metadata: { source: "configure-spectrum" },
        });
        return { line: { id: "line-imessage-0123", channel: "imessage", phoneLast4: "0123", status: "active" } };
      }
      expect(pathname).toBe("/v1/auth/sign-in/message-url");
      expect(body).toMatchObject({
        reason: "signin",
        channel: "iMessage",
        subject: {
          key: "subject-1",
          externalId: "spectrum:subject-1",
          senderId: "+14155551234",
        },
        messageLinePhone: "+14155550123",
        returnMode: "message",
      });
      expect((body as Record<string, unknown>).subjectToken).toBeUndefined();
      return {
        mode: "plain",
        url: "https://sign-in.me/test-agent?delivery=message&message_line_phone=%2B14155550123",
        reason: "signin",
        fallbackReason: "subject_signature_missing",
      };
    });
    const configureSpectrum = withConfigure({
      ...baseOptions,
      store,
      fetch,
      signIn: { linkMode: "managed" },
      identity: {
        subjectKey: () => "subject-1",
        externalId: () => "spectrum:subject-1",
      },
    });

    const ctx = await configureSpectrum.resolve(
      space({ __platform: "iMessage", phone: "+14155550123", type: "dm" }),
      message({ platform: "iMessage", sender: { id: "+14155551234", address: "+14155551234" } })
    );

    await expect(ctx.signInUrl()).resolves.toContain("message_line_phone=%2B14155550123");
  });

  it("uses the routed iMessage line for first-message sign-in return metadata", async () => {
    const store = withConfigure.localStore();
    const fetch = jsonFetch(({ pathname, body }) => {
      if (pathname === "/v1/auth/sign-in/message-lines") {
        expect(body).toMatchObject({
          channel: "iMessage",
          phone: "+14155550123",
          metadata: { source: "configure-spectrum" },
        });
        return { line: { id: "line-imessage-0123", channel: "imessage", phoneLast4: "0123", status: "active" } };
      }
      expect(pathname).toBe("/v1/auth/sign-in/message-url");
      expect(body).toMatchObject({
        reason: "signin",
        channel: "iMessage",
        subjectToken: "photon.signed.subject",
        messageLinePhone: "+14155550123",
        returnMode: "message",
      });
      return {
        mode: "plain",
        url: "https://sign-in.me/test-agent?delivery=message&message_line_phone=%2B14155550123",
        reason: "signin",
        fallbackReason: "subject_signature_unsupported",
      };
    });
    const configureSpectrum = withConfigure({
      ...baseOptions,
      store,
      fetch,
      signIn: { linkMode: "managed" },
      connect: {
        mode: "first-message",
        behavior: "send-and-stop",
      },
      identity: {
        subjectKey: () => "subject-1",
        externalId: () => "spectrum:subject-1",
        subjectToken: () => "photon.signed.subject",
      },
    });
    const inbound = message({ platform: "iMessage", sender: { id: "+14155551234", address: "+14155551234" } });
    const handler = vi.fn();

    await expect(
      configureSpectrum.handle(
        space({ __platform: "iMessage", phone: "+14155550123", type: "dm" }),
        inbound,
        handler
      )
    ).resolves.toEqual({ status: "connect-link-sent" });

    expect(inbound.reply).toHaveBeenCalledWith(
      "Connect your Configure profile: https://sign-in.me/test-agent?delivery=message&message_line_phone=%2B14155550123"
    );
    expect(handler).not.toHaveBeenCalled();
  });

  it("passes dynamic agent phone resolver output to the message URL API", async () => {
    const store = withConfigure.localStore();
    const agentPhone = vi.fn(async () => "+14155550999");
    const fetch = jsonFetch(({ pathname, body }) => {
      if (pathname === "/v1/auth/sign-in/message-lines") {
        expect(body).toMatchObject({
          channel: "iMessage",
          phone: "+14155550999",
          metadata: { source: "configure-spectrum" },
        });
        return { line: { id: "line-imessage-0999", channel: "imessage", phoneLast4: "0999", status: "active" } };
      }
      expect(pathname).toBe("/v1/auth/sign-in/message-url");
      expect(body).toMatchObject({
        reason: "signin",
        channel: "iMessage",
        subjectToken: "photon.signed.subject",
        messageLinePhone: "+14155550999",
        messageBody: "done!",
        returnMode: "message",
      });
      return {
        mode: "plain",
        url: "https://sign-in.me/test-agent?delivery=message&message_line_phone=%2B14155550999",
        reason: "signin",
        fallbackReason: "subject_signature_unsupported",
      };
    });
    const configureSpectrum = withConfigure({
      ...baseOptions,
      store,
      fetch,
      signIn: {
        linkMode: "managed",
        agentPhone,
        messageBody: "done!",
      },
      identity: {
        subjectKey: () => "subject-1",
        externalId: () => "spectrum:subject-1",
        subjectToken: () => "photon.signed.subject",
      },
    });
    const ctx = await configureSpectrum.resolve(
      space({ __platform: "iMessage", type: "dm" }),
      message({ platform: "iMessage", sender: { id: "+14155551234", address: "+14155551234" } })
    );

    await expect(ctx.signInUrl()).resolves.toContain("message_line_phone=%2B14155550999");
    expect(agentPhone).toHaveBeenCalledTimes(1);
  });

  it("does not pass the iMessage shared-mode sentinel as a return phone", async () => {
    const store = withConfigure.localStore();
    const fetch = jsonFetch(({ pathname, body }) => {
      expect(pathname).toBe("/v1/auth/sign-in/message-url");
      expect(body).toMatchObject({
        reason: "signin",
        channel: "iMessage",
        subjectToken: "photon.signed.subject",
        returnMode: "message",
      });
      expect((body as Record<string, unknown>).messageLinePhone).toBeUndefined();
      expect((body as Record<string, unknown>).messageBody).toBeUndefined();
      return {
        mode: "plain",
        url: "https://sign-in.me/test-agent",
        reason: "signin",
        fallbackReason: "subject_signature_unsupported",
      };
    });
    const configureSpectrum = withConfigure({
      ...baseOptions,
      store,
      fetch,
      signIn: {
        linkMode: "managed",
        agentPhone: "shared",
        messageBody: "done!",
      },
      identity: {
        subjectKey: () => "subject-1",
        externalId: () => "spectrum:subject-1",
        subjectToken: () => "photon.signed.subject",
      },
    });
    const ctx = await configureSpectrum.resolve(
      space({ __platform: "iMessage", phone: "shared", type: "dm" }),
      message({ platform: "iMessage", sender: { id: "+14155551234", address: "+14155551234" } })
    );

    await expect(ctx.signInUrl()).resolves.toBe("https://sign-in.me/test-agent");
  });

  it("adds routed iMessage return metadata to hosted completion links when available", async () => {
    const store = countingStore(withConfigure.localStore());
    const configureSpectrum = withConfigure({
      ...baseOptions,
      store,
      signIn: {
        messageCompleteUrl: "https://agent.example.com/auth/configure/complete",
        messageBody: "done!",
      },
    });
    const ctx = await configureSpectrum.resolve(
      space({ __platform: "iMessage", phone: "+14155550123", type: "dm" }),
      message({ platform: "iMessage", sender: { id: "+14155551234", address: "+14155551234" } })
    );
    const url = new URL(await ctx.signInUrl());

    expect(url.searchParams.get("pk")).toBe("pk_test");
    expect(url.searchParams.get("journey")).toBeTruthy();
    expect(url.searchParams.get("message_complete_url")).toBe("https://agent.example.com/auth/configure/complete");
    expect(url.searchParams.get("delivery")).toBe("message");
    expect(url.searchParams.get("message_line_phone")).toBe("+14155550123");
    expect(url.searchParams.get("message_body")).toBe("done!");
    expect(store.savedJourneys).toBe(1);
  });

  it("keeps hosted completion fallback when no reliable return phone is available", async () => {
    const store = countingStore(withConfigure.localStore());
    const configureSpectrum = withConfigure({
      ...baseOptions,
      store,
      signIn: {
        agentPhone: "shared",
        messageCompleteUrl: "https://agent.example.com/auth/configure/complete",
        messageBody: "done!",
      },
    });
    const ctx = await configureSpectrum.resolve(
      space({ __platform: "iMessage", phone: "shared", type: "dm" }),
      message({ platform: "iMessage", sender: { id: "+14155551234", address: "+14155551234" } })
    );
    const url = new URL(await ctx.signInUrl());

    expect(url.searchParams.get("pk")).toBe("pk_test");
    expect(url.searchParams.get("journey")).toBeTruthy();
    expect(url.searchParams.get("message_complete_url")).toBe("https://agent.example.com/auth/configure/complete");
    expect(url.searchParams.get("delivery")).toBe("message");
    expect(url.searchParams.get("message_line_phone")).toBeNull();
    expect(url.searchParams.get("message_body")).toBeNull();
    expect(store.savedJourneys).toBe(1);
  });

  it("builds targeted reconnect links with hosted message return metadata", async () => {
    const store = withConfigure.localStore();
    const configureSpectrum = withConfigure({
      ...baseOptions,
      store,
      signIn: {
        agentPhone: "+14155550000",
        messageBody: "done!",
      },
    });
    const ctx = await configureSpectrum.resolve(space(), message());
    const url = new URL(await ctx.reconnectUrl({ connectors: ["gmail"] }));

    expect(url.origin + url.pathname).toBe("https://sign-in.me/test-agent/reconnect");
    expect(url.searchParams.get("connectors")).toBe("gmail");
    expect(url.searchParams.get("delivery")).toBe("message");
    expect(url.searchParams.get("message_line_phone")).toBe("+14155550000");
    expect(url.searchParams.get("message_body")).toBe("done!");
  });

  it("uses the message URL API for reconnect in managed mode when signed subject evidence exists", async () => {
    const store = withConfigure.localStore();
    const fetch = jsonFetch(({ pathname, body }) => {
      if (pathname === "/v1/auth/sign-in/message-lines") {
        expect(body).toMatchObject({
          channel: "slack",
          phone: "+14155550000",
          metadata: { source: "configure-spectrum" },
        });
        return { line: { id: "line-slack-0000", channel: "slack", phoneLast4: "0000", status: "active" } };
      }
      expect(pathname).toBe("/v1/auth/sign-in/message-url");
      expect(body).toMatchObject({
        reason: "reconnect",
        channel: "slack",
        subject: {
          key: "subject-1",
          externalId: "spectrum:subject-1",
          senderId: "slack-user",
        },
        subjectToken: "photon.signed.subject",
        connectors: ["gmail"],
        messageLinePhone: "+14155550000",
        messageBody: "done!",
        returnMode: "message",
      });
      return {
        mode: "plain",
        url: "https://sign-in.me/test-agent/reconnect?connectors=gmail",
        reason: "reconnect",
        fallbackReason: "subject_signature_unsupported",
      };
    });
    const configureSpectrum = withConfigure({
      ...baseOptions,
      store,
      fetch,
      signIn: {
        linkMode: "managed",
        agentPhone: "+14155550000",
        messageBody: "done!",
      },
      identity: {
        subjectKey: () => "subject-1",
        externalId: () => "spectrum:subject-1",
        subjectToken: () => "photon.signed.subject",
      },
    });
    const inbound = message({ sender: { id: "slack-user" }, platform: "slack" });
    const ctx = await configureSpectrum.resolve(space(), inbound);

    await ctx.replyWithReconnect({ connectors: ["gmail"], message: "Reconnect Gmail: {url}" });

    expect(inbound.reply).toHaveBeenCalledWith(
      "Reconnect Gmail: https://sign-in.me/test-agent/reconnect?connectors=gmail"
    );
  });

  it("stores message URL expiry when a code-bearing sign-in link is sent", async () => {
    const store = withConfigure.localStore();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const fetch = jsonFetch(({ pathname }) => {
      expect(pathname).toBe("/v1/auth/sign-in/message-url");
      return {
        mode: "minted",
        url: "https://sign-in.me/test-agent/cfgmsg_123",
        code: "cfgmsg_123",
        reason: "signin",
        expiresAt,
        idempotencyKey: "slack:space-1:message-1:signin",
      };
    });
    const configureSpectrum = withConfigure({
      ...baseOptions,
      store,
      fetch,
      signIn: { linkMode: "managed" },
      identity: {
        subjectKey: () => "subject-1",
        externalId: () => "spectrum:subject-1",
        subjectToken: () => "photon.signed.subject",
      },
    });
    const inbound = message({ sender: { id: "slack-user" }, platform: "slack" });
    const ctx = await configureSpectrum.resolve(space(), inbound);

    await ctx.replyWithSignIn();

    expect(inbound.reply).toHaveBeenCalledWith(
      expect.stringContaining("https://sign-in.me/test-agent/cfgmsg_123")
    );
    expect(await store.getSubject("subject-1")).toMatchObject({
      signInSentAt: expect.any(String),
      signInExpiresAt: expiresAt,
      signInIdempotencyKey: "slack:space-1:message-1:signin",
    });
  });

  it("allows sendOnce to resend after a code-bearing link expires", async () => {
    const store = withConfigure.localStore();
    await store.saveSubject("subject-1", {
      externalId: "spectrum:subject-1",
      signInSentAt: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
      signInExpiresAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      signInIdempotencyKey: "old:signin",
    });
    const configureSpectrum = withConfigure({
      ...baseOptions,
      store,
      connect: {
        mode: "first-message",
        sendOnce: true,
        behavior: "send-and-stop",
      },
      identity: {
        subjectKey: () => "subject-1",
        externalId: () => "spectrum:subject-1",
      },
    });
    const inbound = message({ sender: { id: "slack-user" }, platform: "slack" });
    const handler = vi.fn();

    await expect(configureSpectrum.handle(space(), inbound, handler)).resolves.toEqual({ status: "connect-link-sent" });
    expect(inbound.reply).toHaveBeenCalledWith(expect.stringContaining("https://sign-in.me/test-agent"));
    expect(handler).not.toHaveBeenCalled();
    const saved = await store.getSubject("subject-1");
    expect(saved?.signInExpiresAt).toBeUndefined();
    expect(saved?.signInIdempotencyKey).toBeUndefined();
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

  it("emits redacted adapter journey events", async () => {
    const store = withConfigure.localStore();
    const events: unknown[] = [];
    const fetch = jsonFetch(({ pathname, body }) => {
      if (pathname === "/v1/auth/sign-in/message-lines") {
        return {
          line: {
            id: "line-1",
            channel: "slack",
            phoneLast4: "0123",
            status: "active",
          },
        };
      }
      if (pathname === "/v1/auth/sign-in/message-url") {
        expect(body).toMatchObject({
          reason: "signin",
          channel: "slack",
          messageLinePhone: "+14155550123",
        });
        return {
          mode: "plain",
          url: "https://sign-in.me/test-agent",
          reason: "signin",
          fallbackReason: "subject_signature_missing",
        };
      }
      throw new Error(`unexpected request: ${pathname}`);
    });
    const configureSpectrum = withConfigure({
      ...baseOptions,
      store,
      fetch,
      signIn: {
        agentPhone: "+14155550123",
        linkMode: "managed",
      },
      connect: {
        mode: "intent",
        behavior: "send-and-stop",
      },
      onEvent: (event) => {
        events.push(event);
      },
    });
    const inbound = message({
      platform: "slack",
      content: { type: "text", text: "connect my profile" },
      sender: { id: "slack-user" },
    });
    const handler = vi.fn();

    await expect(configureSpectrum.handle(space(), inbound, handler)).resolves.toEqual({ status: "connect-link-sent" });

    const names = events.map((event) => (event as { event?: string }).event);
    expect(names).toEqual(expect.arrayContaining([
      "identity_resolution_started",
      "identity_resolved",
      "signin_required",
      "message_url_requested",
      "message_line_registration_attempted",
      "message_line_registration_completed",
      "message_url_created",
      "signin_link_sent",
    ]));
    expect(events.find((event) => (event as { event?: string }).event === "message_url_created")).toMatchObject({
      surface: "adapter",
      agent: "test-agent",
      channel: "slack",
      outcome: "fallback",
      properties: {
        link_mode: "managed",
        message_url_mode: "plain",
        fallback_reason: "subject_signature_missing",
        return_line_present: true,
      },
    });
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("+14155550123");
    expect(serialized).not.toContain("https://");
    expect(serialized).not.toContain("agent-token");
    expect(handler).not.toHaveBeenCalled();
  });
});

function space(overrides: Partial<Space> & Record<string, unknown> = {}): Space {
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
