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
// LOGGING / HARD ERRORS
// =====================
function logErr(e, label = "ERROR") {
  const msg = String(e?.stack || e?.message || e);
  LAST_ERROR = msg;
  console.error(`[${label}] ${msg}`);
}

bot.catch((e) => logErr(e, "BOT"));
process.on("unhandledRejection", (e) => logErr(e, "UNHANDLED_REJECTION"));
process.on("uncaughtException", (e) => logErr(e, "UNCAUGHT_EXCEPTION"));

console.log("BOOT: bot.js running (v1.0)");

// =====================
// EXTRACTION (STRICT JSON SCHEMA)
// =====================
async function extractExpense(text) {
  if (!openai) throw new Error("OpenAI disabled (missing OPENAI_API_KEY)");

  const today = new Date().toISOString().slice(0, 10);

  const resp = await openai.responses.create({
    model: OPENAI_MODEL,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "expense",
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            tx_date: { type: "string", description: "YYYY-MM-DD; default today if missing" },
            amount: { type: "number", description: "Positive number" },
            currency: { type: "string", description: "Default SAR if missing; ريال => SAR" },
            vendor: { type: "string", description: "Merchant/place, else Unknown" },
            category: {
              type: "string",
              enum: [
                "Food",
                "Transport",
                "Utilities",
                "Rent",
                "Business",
                "Personal",
                "Equipment",
                "Raw materials",
                "Uncategorized"
              ]
            },
            description: { type: "string", description: "Short description" }
          },
          required: ["amount"]
        }
      }
    },
    input: [
      {
        role: "system",
        content:
          "You extract ONE expense transaction from Arabic or English user text. Output must match the JSON schema."
      },
      {
        role: "user",
        content: `Today is ${today}.
Message:
"${text}"

Rules:
- "ريال" means currency SAR.
- If it is a meal/coffee/restaurant (غداء/عشاء/فطور/مطعم/قهوة), category must be "Food".
- If unclear category, use "Uncategorized".
- If date missing, use today.
- Keep vendor as the place name if present.`
      }
    ]
  });

  const data = resp.output_parsed || {};
  const amount = Number(data.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("Invalid amount extracted");

  const tx_date = (data.tx_date || today).toString().slice(0, 10);

  let currency = (data.currency || "SAR").toString().trim().toUpperCase();
  if (currency === "ريال" || currency === "SR") currency = "SAR";

  const vendor = (data.vendor || "Unknown").toString().trim() || "Unknown";

  const allowed = new Set([
    "Food",
    "Transport",
    "Utilities",
    "Rent",
    "Business",
    "Personal",
    "Equipment",
    "Raw materials",
    "Uncategorized"
  ]);
  const category = allowed.has(data.category) ? data.category : "Uncategorized";

  const description = (data.description || "").toString().trim();

  return { tx_date, amount, currency, vendor, category, description };
}

// =====================
// COMMANDS
// =====================
bot.command("start", (ctx) => {
  ctx.reply(
    "✅ البوت شغال.\n" +
      "أرسل مصروف مثل:\n" +
      "دفعت 40 ريال للغداء من مطعم رائد البخاري\n\n" +
      "أوامر:\n" +
      "/ping\n" +
      "/version\n" +
      "/env\n" +
      "/help"
  );
});

bot.command("help", (ctx) => {
  ctx.reply(
    "📌 أمثلة:\n" +
      "- غداء 40 ريال مطعم رائد البخاري\n" +
      "- دفعت 25 ريال قهوة\n" +
      "- Uber 18 SAR\n\n" +
      "📟 أوامر:\n" +
      "/ping (اختبار)\n" +
      "/version (تأكد النسخة)\n" +
      "/env (هل OpenAI مفعّل)"
  );
});

bot.command("ping", (ctx) => ctx.reply("pong ✅"));
bot.command("version", (ctx) => ctx.reply("version: railway-bot-v1"));
bot.command("env", (ctx) => {
  ctx.reply(
    `openai: ${openai ? "yes" : "no"}\n` +
    `model: ${OPENAI_MODEL}\n` +
    `last_error: ${LAST_ERROR ? "yes" : "no"}`
  );
});

// =====================
// MESSAGE HANDLER
// =====================
bot.on("text", async (ctx) => {
  const text = (ctx.message?.text || "").trim();
  if (!text) return;
  if (text.startsWith("/")) return; // commands handled above

  if (!openai) {
    return ctx.reply("❌ OpenAI غير مفعّل. أضف OPENAI_API_KEY في Railway Variables ثم Redeploy.");
  }

  try {
    const tx = await extractExpense(text);

    await ctx.reply(
      `✅ تم استخراج المصروف:\n` +
        `💰 ${tx.amount.toFixed(2)} ${tx.currency}\n` +
        `📅 ${tx.tx_date}\n` +
        `🏪 ${tx.vendor}\n` +
        `🏷️ ${tx.category}\n` +
        `📝 ${tx.description || "-"}`
    );
  } catch (e) {
    logErr(e, "EXTRACT_FAIL");
    await ctx.reply(
      "❌ ما قدرت أفهم المصروف.\n" +
        "اكتبها أوضح:\n" +
        "مثال: غداء 40 ريال مطعم رائد البخاري\n" +
        "أو: دفعت 25 ريال قهوة"
    );
  }
});

// =====================
// LAUNCH (POLLING)
// =====================
async function start() {
  try {
    const me = await bot.telegram.getMe();
    console.log("BOT USERNAME:", me.username);

    // Ensure no webhook conflicts
    await bot.telegram.deleteWebhook({ drop_pending_updates: true });

    await bot.launch();
    console.log("BOT READY. Test: /ping");
  } catch (e) {
    logErr(e, "LAUNCH_FAILED");
    process.exit(1);
  }
}

start();

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
