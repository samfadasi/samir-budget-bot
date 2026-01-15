import { Telegraf } from "telegraf";
import OpenAI from "openai";

const TELEGRAM_BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").trim();

if (!TELEGRAM_BOT_TOKEN) {
  console.error("FATAL: TELEGRAM_BOT_TOKEN missing");
  process.exit(1);
}

const bot = new Telegraf(TELEGRAM_BOT_TOKEN);
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

bot.command("ping", (ctx) => ctx.reply("pong ✅"));
bot.command("version", (ctx) => ctx.reply("version: railway-bot-v1"));
bot.command("env", (ctx) => {
  ctx.reply(`openai: ${openai ? "yes" : "no"}`);
});

bot.on("text", async (ctx) => {
  const text = (ctx.message?.text || "").trim();
  if (text.startsWith("/")) return;

  if (!openai) return ctx.reply("❌ OpenAI غير مفعّل. أضف OPENAI_API_KEY.");

  try {
    const today = new Date().toISOString().slice(0, 10);
    const prompt = `Today is ${today}. Extract ONE expense from: "${text}". Return JSON only with keys: tx_date, amount, currency, vendor, category, description.`;

    const resp = await openai.responses.create({
      model: "gpt-4o",
      instructions: "Return valid JSON only.",
      input: prompt
    });

    const out = resp.output
      .filter(o => o.type === "output_text")
      .map(o => o.text)
      .join("")
      .trim();

    const tx = JSON.parse(out);

    await ctx.reply(
`✅ تم استخراج المصروف:
💰 ${tx.amount} ${tx.currency || "SAR"}
📅 ${tx.tx_date || today}
🏪 ${tx.vendor || "Unknown"}
🏷️ ${tx.category || "Uncategorized"}
📝 ${tx.description || "-"}`
    );
  } catch (e) {
    console.error(e);
    await ctx.reply("❌ ما قدرت أفهم المصروف. اكتبها أوضح.");
  }
});

(async () => {
  const me = await bot.telegram.getMe();
  console.log("BOT USERNAME:", me.username);
  await bot.telegram.deleteWebhook({ drop_pending_updates: true });
  await bot.launch();
  console.log("BOT READY. Test: /ping");
})();

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
