import { Telegraf } from "telegraf";
import OpenAI from "openai";

// =====================
// ENV
// =====================
const TELEGRAM_BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").trim();
const OPENAI_MODEL = (process.env.OPENAI_MODEL || "gpt-4o-mini").trim();

if (!TELEGRAM_BOT_TOKEN) {
  console.error("FATAL: TELEGRAM_BOT_TOKEN missing");
  process.exit(1);
}

const bot = new Telegraf(TELEGRAM_BOT_TOKEN);
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

console.log("BOOT: accounting-bot v1 (safe)");

// =====================
// ERROR HANDLING
// =====================
let LAST_ERROR = "";
function logErr(e, tag = "ERR") {
  const msg = String(e?.stack || e?.message || e);
  LAST_ERROR = msg;
  console.error(`[${tag}]`, msg);
}

bot.catch((e) => logErr(e, "BOT"));
process.on("unhandledRejection", (e) => logErr(e, "UNHANDLED"));
process.on("uncaughtException", (e) => logErr(e, "UNCAUGHT"));

// =====================
// LOCAL FALLBACK PARSER (ARABIC)
// =====================
function localExtract(text) {
  // amount: first number
  const numMatch = text.match(/(\d+(\.\d+)?)/);
  const amount = numMatch ? Number(numMatch[1]) : null;

  // currency
  const currency = /ريال|ر\.?س|SAR|SR/i.test(text) ? "SAR" : "SAR";

  // category heuristic
  const foodKw = /(غداء|عشاء|فطور|مطعم|قهوة|شاي|اكل|وجبة)/i;
  const category = foodKw.test(text) ? "Food" : "Uncategorized";

  // vendor: after "مطعم" أو "من"
  let vendor = "Unknown";
  const v1 = text.match(/مطعم\s+([^\n\r]+)/);
  if (v1 && v1[1]) vendor = v1[1].trim();

  const v2 = text.match(/من\s+([^\n\r]+)/);
  if (vendor === "Unknown" && v2 && v2[1]) vendor = v2[1].trim();

  const today = new Date().toISOString().slice(0, 10);

  if (!amount || amount <= 0) return null;

  return {
    tx_date: today,
    amount,
    currency,
    vendor,
    category,
    description: text.slice(0, 60)
  };
}

// =====================
// OPENAI EXTRACT (STRICT JSON)
// =====================
async function aiExtract(text) {
  if (!openai) throw new Error("OpenAI disabled");

  const today = new Date().toISOString().slice(0, 10);

  // Use chat.completions with enforced JSON output (more stable across SDK versions)
  const res = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    messages: [
      {
        role: "system",
        content:
          "Extract ONE expense transaction from Arabic/English text. Return ONLY valid JSON with keys: tx_date, amount, currency, vendor, category, description. Category must be one of: Food, Transport, Utilities, Rent, Business, Personal, Equipment, Raw materials, Uncategorized."
      },
      {
        role: "user",
        content:
          `Today is ${today}.\n` +
          `Text: "${text}"\n` +
          `Rules: ريال= SAR. If meal/coffee/restaurant then category=Food. If missing date use today. Return JSON only.`
      }
    ],
    response_format: { type: "json_object" },
    temperature: 0
  });

  const out = res.choices?.[0]?.message?.content?.trim() || "";
  const obj = JSON.parse(out);

  // normalize
  const amount = Number(obj.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("Invalid amount from AI");

  const tx_date = String(obj.tx_date || today).slice(0, 10);
  const currency = String(obj.currency || "SAR").toUpperCase();
  const vendor = String(obj.vendor || "Unknown").trim() || "Unknown";

  const allowed = new Set([
    "Food","Transport","Utilities","Rent","Business","Personal","Equipment","Raw materials","Uncategorized"
  ]);
  const category = allowed.has(obj.category) ? obj.category : "Uncategorized";
  const description = String(obj.description || "").trim();

  return { tx_date, amount, currency, vendor, category, description };
}

// =====================
// COMMANDS
// =====================
bot.command("start", (ctx) =>
  ctx.reply(
    "✅ البوت شغال.\n" +
      "أرسل مصروف مثل: دفعت 40 ريال للغداء من مطعم رائد البخاري\n" +
      "أوامر: /ping /version /env"
  )
);

bot.command("ping", (ctx) => ctx.reply("pong ✅"));
bot.command("version", (ctx) => ctx.reply("version: accounting-bot-v1"));
bot.command("env", (ctx) => {
  ctx.reply(
    `openai: ${openai ? "yes" : "no"}\n` +
    `model: ${OPENAI_MODEL}\n` +
    `last_error: ${LAST_ERROR ? "yes" : "no"}`
  );
});

// =====================
// MAIN HANDLER
// =====================
bot.on("text", async (ctx) => {
  const text = (ctx.message?.text || "").trim();
  if (!text || text.startsWith("/")) return;

  // 1) Try AI if enabled
  if (openai) {
    try {
      const tx = await aiExtract(text);
      return ctx.reply(
        `✅ تم استخراج المصروف:\n` +
          `💰 ${tx.amount.toFixed(2)} ${tx.currency}\n` +
          `📅 ${tx.tx_date}\n` +
          `🏪 ${tx.vendor}\n` +
          `🏷️ ${tx.category}\n` +
          `📝 ${tx.description || "-"}`
      );
    } catch (e) {
      logErr(e, "AI_EXTRACT_FAIL");
      // fall through to local parse
    }
  }

  // 2) Local fallback (never crashes)
  const local = localExtract(text);
  if (local) {
    return ctx.reply(
      `✅ (Fallback) تم تسجيل مصروف مبدئي:\n` +
        `💰 ${local.amount.toFixed(2)} ${local.currency}\n` +
        `📅 ${local.tx_date}\n` +
        `🏪 ${local.vendor}\n` +
        `🏷️ ${local.category}\n` +
        `📝 ${local.description}`
    );
  }

  // 3) Could not parse
  return ctx.reply(
    "❌ ما قدرت أفهم المصروف.\n" +
      "اكتبها أوضح:\n" +
      "مثال: غداء 40 ريال مطعم رائد البخاري"
  );
});

// =====================
// LAUNCH
// =====================
(async () => {
  const me = await bot.telegram.getMe();
  console.log("BOT USERNAME:", me.username);
  await bot.telegram.deleteWebhook({ drop_pending_updates: true });
  await bot.launch();
  console.log("BOT READY. Test: /ping");
})();

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
