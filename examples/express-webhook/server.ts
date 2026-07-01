import express from "express";
import { Spectrum } from "spectrum-ts";
import { spectrum } from "@spectrum-ts/express";
import { memoryStore, withConfigure } from "@configure-ai/spectrum-ts";

const app = await Spectrum({
  webhookSecret: process.env.SPECTRUM_WEBHOOK_SECRET!,
  providers: [],
});

const configureSpectrum = withConfigure({
  apiKey: process.env.CONFIGURE_API_KEY!,
  publishableKey: process.env.CONFIGURE_PUBLISHABLE_KEY!,
  agent: process.env.CONFIGURE_AGENT!,
  store: memoryStore(),
});

const server = express();

server.use(
  spectrum({
    app,
    onMessage: async (space, message) => {
      await configureSpectrum.handle(space, message, async (ctx) => {
        if (!ctx.text) return;
        const { profile } = await ctx.profile.read();
        await message.reply(`Profile linked: ${profile.linked ? "yes" : "not yet"}`);
      });
    },
  })
);

server.listen(3000);
