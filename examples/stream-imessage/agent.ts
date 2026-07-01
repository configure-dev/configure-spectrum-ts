import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import { memoryStore, withConfigure } from "@configure-ai/spectrum-ts";

const app = await Spectrum({
  projectId: process.env.PHOTON_PROJECT_ID!,
  projectSecret: process.env.PHOTON_PROJECT_SECRET!,
  providers: [imessage.config()],
});

const configureSpectrum = withConfigure({
  apiKey: process.env.CONFIGURE_API_KEY!,
  publishableKey: process.env.CONFIGURE_PUBLISHABLE_KEY!,
  agent: process.env.CONFIGURE_AGENT!,
  store: memoryStore(),
  signIn: {
    displayName: "Your Agent",
    agentPhone: process.env.AGENT_PHONE_NUMBER,
  },
});

for await (const [space, message] of app.messages) {
  await configureSpectrum.handle(space, message, async (ctx) => {
    if (!ctx.text) return;
    const { profile } = await ctx.profile.read();
    const name = firstName(profile);
    const greeting = name ? `Hey ${name}.` : "Hey.";
    const state = ctx.linked
      ? "I have your Configure profile for this conversation."
      : "I can answer normally. Send \"connect\" if you want to link your Configure profile.";

    await message.reply(`${greeting} ${state}`);
  });
}

function firstName(profile: { identity?: { name?: string } }): string | null {
  const name = profile.identity?.name?.trim();
  return name ? name.split(/\s+/)[0] ?? null : null;
}
