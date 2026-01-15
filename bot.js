import { Telegraf } from "telegraf";
import OpenAI from "openai";

// =====================
// ENV
// =====================
const TELEGRAM_BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").trim();
const OPENAI_MODEL = (process.env.OPENAI_MODEL || "gpt-4o").trim();

if (!TELEGRAM_BOT_TOKEN) {
  console.error("FATAL: TELEGRAM_BOT_TOKEN missing");
  process.exit(1);
}

const bot = new Telegraf(TELEGRAM_BOT_TOKEN);
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

let LAST_ERROR = "";

// =====================
// HARD ERROR LOGGING
// =====================
function setErr(e, label = "ERROR") {
  const msg = String(e?.stack || e?.message || e);
  LAST_ERROR = msg;
  console.error(`[${label}]`, msg);
}

bot.catch((err) => setErr(err, "BOT"));
process.on("unhandledRejection", (e) => setErr(e, "UNHANDLED_REJECTION"));
process.on("uncaughtException", (e) => setErr(e, "UNCAUGHT_EXCEPTION"));

// =====================
// HELPERS
// =====================
function safeJsonParse(s) {
  // Try direct parse
  try {
    return JSON.parse(s);
  } catch {}

  // If model returns extra text, try to extract JSON object portion
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) {
    const cut = s.slice(first, last + 1);
    return JSON.parse(cut);
  }

  throw new Error("Invalid JSON output from model");
}

function normalizeTx(tx) {
  const today = new Date().toISOString().slice(0, 10);

  const amount = Number(tx.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("Invalid amount");

  let currency = (tx.currency || "SAR").toString().trim().toUpperCase();
  if (currency === "ريال" || currency === "SAR" || currency === "SR") currency = "SAR";

  const tx_date = (tx.tx_date || today).toString().slice(0, 10);
  const vendor = (tx.vendor || "Unknown").toString().trim() || "Unknown";

  const allowedCats = new Set([
    "Food",
    "Transport",
    "Utilities",
    "Rent",
    "Business",
    "Personal",
    "Equipment",
    "Raw materials",
    "Uncategorized",
  ]);
  let category = (tx.category || "Uncategorized").toString().trim();
  if (!allowedCats.has(category)) category = "Uncategorized";

  const description = (tx.description || "").toString().trim();

  return { tx_date, amount, currency, vendor, category, description };
}

async function extractExpenseFromText(text) {
  if (!openai) throw new Error("OpenAI disabled (missing OPENAI_API_KEY)");

  const today = new Date().toISOString().slice(0, 10);

  const prompt = `
Today is ${today}.

You are an accounting extraction engine. The message may be Arabic or English.
Extract ONE expense transaction from this message:

"${text}"

Return ONLY valid JSON (no markdown, no extra text) with EXACTLY these keys:
- tx_date (YYYY-MM-DD, use today if missing)
- amount (number)
- currency (string, default "SAR" if missing). If the message contains "ريال", set currency to "SAR".
- vendor (string, merchant/place name if available, otherwise "Unknown")
- category (one of: Food, Transport, Utilities, Rent, Business, Personal, Equipment, Raw materials, Uncategorized)
- description (short string)

Rules:
- If it's food/meal (غداء/عشاء/فطور/مطعم/قهوة), category = "Food".
- If uncertain, category = "Uncategorized".
- Output JSON only.
`;

  const resp = await openai.responses.create({
    model: OPENAI_MODEL,
    instructions: "Return valid JSON only. No extra keys. No extra text.",
    input: prompt,
  });

  const out = resp.output
    .filter((o) => o.type === "output_text")
    .map((o) => o.text)
    .join("")
    .trim();

  const parsed = safeJsonParse(out);
  return normalizeTx(parsed);
}

// =====================
// COMMANDS
// =====================
bot.command("start", (ctx) =>
  ctx.reply(
    "✅ البوت شغال.\n" +
      "أرسل مصروف مثل: دفعت 40 ريال للغداء من مطعم...\n" +
      "أوامر: /ping /version /env"
  )
);

bot.command("ping", (ctx) => ctx.reply("pong ✅"));
bot.command("version", (ctx) => ctx.reply("version: railway-bot-v2"));

bot.command("env", (ctx) => {
  const hasAI = !!openai;
  ctx.reply(`openai: ${hasAI ? "yes" : "no"}\nmodel: ${OPENAI_MODEL}`);
});

// =====================
// TEXT HANDLER
// =====================
bot.on("text", async (ctx) => {
  const text = (ctx.message?.text || "").trim();
  if (!text || text.startsWith("/")) return;

  // If OpenAI disabled, don't pretend it's processing
  if (!openai) {
    return ctx.reply("❌ OpenAI غير مفعّل. أضف OPENAI_API_KEY في Railway Variables ثم Redeploy.");
  }

  try {
    const tx = await extractExpenseFromText(text);

    await ctx.reply(
      `✅ تم استخراج المصروف:\n` +
        `💰 ${tx.amount.toFixed(2)} ${tx.currency}\n` +
        `📅 ${tx.tx_date}\n` +
        `🏪 ${tx.vendor}\n` +
        `🏷️ ${tx.category}\n` +
        `📝 ${tx.description || "-"}`
    );
  } catch (e) {
    setErr(e, "EXTRACT_FAIL");
    await ctx.reply(
      "❌ ما قدرت أفهم المصروف.\n" +
        "اكتبها بهذه الصيغة:\n" +
        "مثال: غداء 40 ريال مطعم رائد البخاري\n" +
        "أو: دفعت 25 ريال قهوة"
    );
  }
});

// =====================
// LAUNCH
// =====================
(async () => {
  try {
    const me = await bot.telegram.getMe();
    console.log("BOT USERNAME:", me.username);

    // Make sure webhook isn't set (polling conflict)
    await bot.telegram.deleteWebhook({ drop_pending_updates: true });

    await bot.launch();
    console.log("BOT READY. Test: /ping");
  } catch (e) {
    setErr(e, "LAUNCH_FAILED");
    process.exit(1);
  }
})();

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));

