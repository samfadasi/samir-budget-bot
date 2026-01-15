import { Telegraf } from "telegraf";
import OpenAI from "openai";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const OPENAI_KEY = process.env.OPENAI_API_KEY;

if (!TOKEN) {
  console.error("NO TELEGRAM TOKEN");
  process.exit(1);
}

const bot = new Telegraf(TOKEN);
const client = OPENAI_KEY ? new OpenAI({ apiKey: OPENAI_KEY }) : null;

console.log("BOOT: stable-bot v1");

bot.catch(err => console.error("BOT ERROR", err));
process.on("unhandledRejection", e => console.error("UNHANDLED", e));
process.on("uncaughtException", e => console.error("UNCAUGHT", e));

bot.command("ping", ctx => ctx.reply("pong ✅"));
bot.command("version", ctx => ctx.reply("stable-bot-v1"));
bot.command("env", ctx =>
  ctx.reply(`openai: ${client ? "yes" : "no"}`)
);

bot.on("text", async ctx => {
  const text = ctx.message?.text?.trim();
  if (!text || text.startsWith("/")) return;

  // fallback دايماً شغال
  const m = text.match(/(\d+)/);
  if (!m) return ctx.reply("❌ ما لقيت مبلغ.");

  const amount = Number(m[1]);
  const isFood = /(غداء|عشاء|مطعم|قهوة|اكل)/i.test(text);
  const vendorMatch = text.match(/مطعم\s+(.+)/);

  // لو OpenAI متاح نحاول
  if (client
