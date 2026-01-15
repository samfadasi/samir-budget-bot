import http from "http";
import { Telegraf } from "telegraf";

// =====================
// ENV
// =====================
const TELEGRAM_BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
if (!TELEGRAM_BOT_TOKEN) {
  console.error("FATAL: TELEGRAM_BOT_TOKEN missing");
  process.exit(1);
}

// =====================
// KEEP-ALIVE HTTP (for platforms expecting a PORT)
// =====================
const PORT = Number(process.env.PORT || 3000);
http
  .createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
  })
  .listen(PORT, () => console.log("HTTP OK on port", PORT));

// =====================
// BOT
// =====================
const bot = new Telegraf(TELEGRAM_BOT_TOKEN);

// Hard error logging (never silent)
bot.catch((e) => console.error("BOT ERROR:", e));
process.on("unhandledRejection", (e) => console.error("UNHANDLED:", e));
process.on("uncaughtException", (e) => console.error("UNCAUGHT:", e));

console.log("BOOT: telegram-only-bot v1");

// Commands
bot.command("start", (ctx) => ctx.reply("✅ شغال. جرّب /ping و /version"));
bot.command("ping", (ctx) => ctx.reply("pong ✅"));
bot.command("version", (ctx) => ctx.reply("version: telegram-only-bot-v1"));
bot.command("help", (ctx) =>
  ctx.reply("أوامر: /ping /version\nأرسل أي رسالة وسأرد عليك.")
);

// Text echo (to prove receiving updates)
bot.on("text", async (ctx) => {
  const text = (ctx.message?.text || "").trim();
  if (!text) return;
  if (text.startsWith("/")) return; // commands handled above

  return ctx.reply("✅ استلمت رسالتك.");
});

// =====================
// LAUNCH (WITH STEP LOGS)
// =====================
(async () => {
  try {
    console.log("STEP: before deleteWebhook");
    await bot.telegram.deleteWebhook({ drop_pending_updates: true });
    console.log("STEP: after deleteWebhook, before getMe");

    const me = await bot.telegram.getMe();
    console.log("STEP: getMe OK:", me.username);

    console.log("STEP: before launch");
    await bot.launch();
    console.log("STEP: after launch (BOT READY)");
  } catch (e) {
    console.error("LAUNCH FAILED:", e);
    process.exit(1);
  }
})();

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
