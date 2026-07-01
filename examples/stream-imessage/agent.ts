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
    await message.reply(`Profile linked: ${profile.linked ? "yes" : "not yet"}`);
  });
}
