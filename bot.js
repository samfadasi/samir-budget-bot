import { Telegraf } from "telegraf";

const TELEGRAM_BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
if (!TELEGRAM_BOT_TOKEN) {
  console.error("FATAL: TELEGRAM_BOT_TOKEN missing");
  process.exit(1);
}

const bot = new Telegraf(TELEGRAM_BOT_TOKEN);

bot.catch((e) => console.error("BOT ERROR:", e));
process.on("unhandledRejection", (e) => console.error("UNHANDLED:", e));
process.on("uncaughtException", (e) => console.error("UNCAUGHT:", e));

console.log("BOOT: safe-bot v1");

bot.command("ping", (ctx) => ctx.reply("pong ✅"));
bot.command("version", (ctx) => ctx.reply("version: safe-bot-v1"));
bot.command("start", (ctx) => ctx.reply("✅ شغال. جرّب /ping"));

bot.on("text", (ctx) =>
  ctx.reply("✅ استلمت رسالتك. (نفعّل المحاسب بعد ما نثبت التشغيل)")
);

(async () => {
  const me = await bot.telegram.getMe();
  console.log("BOT USERNAME:", me.username);
  await bot.telegram.deleteWebhook({ drop_pending_updates: true });
  await bot.launch();
  console.log("BOT READY. Test: /ping");
})();

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));

