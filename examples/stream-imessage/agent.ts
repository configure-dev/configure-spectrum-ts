import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import { withConfigure } from "configure-spectrum";

const app = await Spectrum({
  projectId: process.env.PHOTON_PROJECT_ID!,
  projectSecret: process.env.PHOTON_PROJECT_SECRET!,
  providers: [imessage.config()],
});

const configureSpectrum = withConfigure({
  apiKey: process.env.CONFIGURE_API_KEY!,
  publishableKey: process.env.CONFIGURE_PUBLISHABLE_KEY!,
  agent: process.env.CONFIGURE_AGENT!,
  store: withConfigure.localStore(),
  signIn: {
    displayName: "Your Agent",
    linkMode: "managed",
    connectors: ["gmail", "calendar"],
  },
  connect: {
    mode: "intent",
    sendOnce: true,
  },
});

for await (const [space, message] of app.messages) {
  await configureSpectrum.handle(space, message, async (ctx) => {
    if (!ctx.text) return;
    const tools = ctx.profile.tools({
      connectors: ["gmail", "calendar"],
      actions: ["email.send", "calendar.create_event"],
    });
    const turn = await runAgentTurn({
      text: ctx.text,
      linked: ctx.linked,
      tools,
      executeTool: ctx.profile.executeTool,
    });

    await message.reply(turn.reply);
    if (turn.configureReadUsed) ctx.profile.commit({
      messages: [
        { role: "user", content: ctx.text },
        { role: "assistant", content: turn.reply },
      ],
    }).catch(() => {});
  });
}

async function runAgentTurn(input: {
  text: string;
  linked: boolean;
  tools: unknown[];
  executeTool: (toolCall: { name: string; arguments?: Record<string, unknown> }) => Promise<unknown>;
}): Promise<{ reply: string; configureReadUsed: boolean }> {
  void input.text;
  void input.tools;
  const firstName = await readFirstName(input.executeTool);
  const greeting = firstName.name ? `Hey ${firstName.name}.` : "Hey.";
  const state = input.linked
    ? "I have your Configure profile for this conversation."
    : "I can continue without a linked profile. Send \"connect\" to link Configure.";
  return { reply: `${greeting} ${state}`, configureReadUsed: firstName.configureReadUsed };
}

async function readFirstName(
  executeTool: (toolCall: { name: string; arguments?: Record<string, unknown> }) => Promise<unknown>
): Promise<{ name: string | null; configureReadUsed: boolean }> {
  try {
    const result = await executeTool({
      name: "configure_profile_read",
      arguments: { sections: ["identity", "summary", "preferences"] },
    });
    const profile = isRecord(result) && isRecord(result.profile) ? result.profile : {};
    const identity = isRecord(profile.identity) ? profile.identity : {};
    const name = typeof identity.name === "string" ? identity.name.trim() : "";
    return { name: name ? name.split(/\s+/)[0] ?? null : null, configureReadUsed: true };
  } catch {
    return { name: null, configureReadUsed: false };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
