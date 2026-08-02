import { Bot } from "@almeidamateus/wzapp";

// WhatsApp echoes outgoing messages back to all devices on the account,
// so without .ignore("message:from_me") handlers like .on("message:image", ...)
// would fire on the bot's own replies and loop.
const bot = new Bot({ authPath: "./auth", prefix: "/" }).ignore(
  "message:from_me",
);

bot.command("start", (ctx) =>
  ctx.reply(`Oi, ${ctx.senderName ?? "amigo"}! Bem-vindo ao wzapp.`),
);

bot.command("help", (ctx) =>
  ctx.reply(
    "Comandos: /start, /help, /ping, /echo <texto>. Também reajo a 'ping', voz e mídia.",
  ),
);

bot.command("ping", (ctx) => ctx.reply("pong"));

bot.command("echo", (ctx) => {
  const args = typeof ctx.match === "string" ? ctx.match : "";
  return ctx.reply(args.length > 0 ? args : "(nada para ecoar)");
});

bot.hears(/^ping$/i, (ctx) => ctx.reply("pong"));

bot.on("message:image", async (ctx) => {
  const buf = await ctx.downloadMedia();
  await ctx.replyWithImage(buf, { caption: `Recebi ${buf.length} bytes` });
});

bot.on("message:voice", (ctx) => ctx.react("🎙️"));

bot.on("message:quoted", (ctx) => ctx.react("👀"));

bot.on("group:participants:add", (ctx) => {
  const first = ctx.update.participants[0];
  if (!first) return;
  const jids = ctx.update.participants.map((p) => p.id);
  return ctx.reply(`Bem-vindo, @${first.id.split("@")[0]}!`, {
    mentions: jids,
  });
});

bot.catch((err) => {
  console.error("[echo-bot] erro:", err);
});

console.log("[echo-bot] iniciando, escaneie o QR no celular");

await bot.start({ concurrency: 8 });
