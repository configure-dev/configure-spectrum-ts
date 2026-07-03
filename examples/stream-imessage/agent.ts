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
    const name = firstName(profile);
    const greeting = name ? `Hey ${name}.` : "Hey.";
    const state = ctx.linked
      ? "I have your Configure profile for this conversation."
      : "I can continue without a linked profile. Send \"connect\" to link Configure.";
    const reply = `${greeting} ${state}`;

    await message.reply(reply);
    ctx.profile.commit({
      messages: [
        { role: "user", content: ctx.text },
        { role: "assistant", content: reply },
      ],
    }).catch(() => {});
  });
}

function firstName(profile: { identity?: { name?: string } }): string | null {
  const name = profile.identity?.name?.trim();
  return name ? name.split(/\s+/)[0] ?? null : null;
}
