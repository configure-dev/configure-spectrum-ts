import express from "express";
import { Spectrum } from "spectrum-ts";
import { spectrum } from "@spectrum-ts/express";
import { withConfigure } from "configure-spectrum";

const app = await Spectrum({
  webhookSecret: process.env.SPECTRUM_WEBHOOK_SECRET!,
  providers: [],
});

const configureSpectrum = withConfigure({
  apiKey: process.env.CONFIGURE_API_KEY!,
  publishableKey: process.env.CONFIGURE_PUBLISHABLE_KEY!,
  agent: process.env.CONFIGURE_AGENT!,
  store: withConfigure.localStore(),
  connect: {
    mode: "intent",
    sendOnce: true,
  },
});

const server = express();

server.use(
  spectrum({
    app,
    onMessage: async (space, message) => {
      await configureSpectrum.handle(space, message, async (ctx) => {
        if (!ctx.text) return;
        const { profile } = await ctx.profile.read();
        const name = firstName(profile);
        const greeting = name ? `Hey ${name}.` : "Hey.";
        const state = ctx.linked
          ? "I have your Configure profile for this conversation."
          : "I can continue without a linked profile. Send \"connect\" to link Configure.";

        await message.reply(`${greeting} ${state}`);
      });
    },
  })
);

server.listen(3000);

function firstName(profile: { identity?: { name?: string } }): string | null {
  const name = profile.identity?.name?.trim();
  return name ? name.split(/\s+/)[0] ?? null : null;
}
