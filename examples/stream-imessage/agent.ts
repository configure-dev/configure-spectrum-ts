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
    const { profile } = await ctx.profile.read({
      sections: ["identity", "preferences", "summary"],
    });
    const tools = ctx.profile.tools({
      connectors: ["gmail", "calendar"],
      actions: ["email.send", "calendar.create_event"],
    });
    const reply = await runAgentTurn({
      text: ctx.text,
      profile,
      linked: ctx.linked,
      tools,
      executeTool: ctx.profile.executeTool,
    });

    await message.reply(reply);
    ctx.profile.commit({
      messages: [
        { role: "user", content: ctx.text },
        { role: "assistant", content: reply },
      ],
    }).catch(() => {});
  });
}

async function runAgentTurn(input: {
  text: string;
  profile: { identity?: { name?: string } };
  linked: boolean;
  tools: unknown[];
  executeTool: unknown;
}): Promise<string> {
  void input.text;
  void input.tools;
  void input.executeTool;
  const name = firstName(input.profile);
  const greeting = name ? `Hey ${name}.` : "Hey.";
  const state = input.linked
    ? "I have your Configure profile for this conversation."
    : "I can continue without a linked profile. Send \"connect\" to link Configure.";
  return `${greeting} ${state}`;
}

function firstName(profile: { identity?: { name?: string } }): string | null {
  const name = profile.identity?.name?.trim();
  return name ? name.split(/\s+/)[0] ?? null : null;
}
