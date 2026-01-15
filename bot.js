import http from "http";
import { Telegraf } from "telegraf";
import OpenAI from "openai";
import pg from "pg";

const { Pool } = pg;

// =====================
// ENV
// =====================
const TELEGRAM_BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").trim();
const OPENAI_MODEL = (process.env.OPENAI_MODEL || "gpt-4o-mini").trim();
const DATABASE_URL = (process.env.DATABASE_URL || "").trim();

if (!TELEGRAM_BOT_TOKEN) {
  console.error("FATAL: TELEGRAM_BOT_TOKEN missing");
  process.exit(1);
}

// Keep-alive HTTP (some platforms expect PORT)
const PORT = Number(process.env.PORT || 3000);
http.createServer((req, res) => res.end("ok")).listen(PORT, () => {
  console.log("HTTP OK on port", PORT);
});

const bot = new Telegraf(TELEGRAM_BOT_TOKEN);
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

// =====================
// DB (SAFE)
// =====================
let pool = null;
let DB_STATUS = "disabled";
let DB_ERROR = "";

function dbErr(e) {
  DB_ERROR = String(e?.stack || e?.message || e);
  console.error("[DB]", DB_ERROR);
}

async function initDb() {
  if (!DATABASE_URL) {
    DB_STATUS = "disabled";
    return;
  }

  try {
    pool = new Pool({
      connectionString: DATABASE_URL,
      ssl: { rejectUnauthorized: false }
    });

    // quick ping
    await pool.query("select 1 as ok");

    // schema (safe, idempotent)
    await pool.query(`
      create table if not exists tx (
        id bigserial primary key,
        tg_user_id bigint not null,
        tx_date date not null,
        amount numeric(12,2) not null,
        currency text not null default 'SAR',
        vendor text,
        category text,
        description text,
        raw_text text,
        created_at timestamptz not null default now()
      );

      create index if not exists idx_tx_user_date
        on tx (tg_user_id, tx_date);

      create table if not exists budgets (
        id bigserial primary key,
        tg_user_id bigint not null,
        month text not null,
        category text not null,
        amount numeric(12,2) not null,
        currency text not null default 'SAR',
        unique(tg_user_id, month, category)
      );
    `);

    DB_STATUS = "enabled";
    console.log("DB READY");
  } catch (e) {
    DB_STATUS = "error";
    dbErr(e);
    // IMPORTANT: do not crash the bot
    pool = null;
  }
}

async function saveTx(ctxUserId, tx, rawText) {
  if (!pool) return "NO_DB";
  try {
    await pool.query(
      `insert into tx (tg_user_id, tx_date, amount, currency, vendor, category, description, raw_text)
       values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [ctxUserId, tx.tx_date, tx.amount, tx.currency, tx.vendor, tx.category, tx.description, rawText]
    );
    return "OK";
  } catch (e) {
    dbErr(e);
    return "DB_FAIL";
  }
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

// =====================
// AI Extraction (stable)
// =====================
async function aiExtract(text) {
  if (!openai) throw new Error("OpenAI disabled");

  const today = todayISO();

  const res = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    messages: [
      {
        role: "system",
        content:
          "Return ONLY JSON with keys: tx_date, amount, currency, vendor, category, description. category one of: Food, Transport, Utilities, Rent, Business, Personal, Equipment, Raw materials, Uncategorized."
      },
      {
        role: "user",
        content:
          `Today is ${today}. Extract ONE expense from Arabic/English:\n"${text}"\nRules: ريال=SAR. Meals/restaurant/coffee => Food. If date missing => today.`
      }
    ],
    response_format: { type: "json_object" },
    temperature: 0
  });

  const out = res.choices?.[0]?.message?.content?.trim() || "{}";
  const obj = JSON.parse(out);

  const amount = Number(obj.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("Invalid amount");

  const tx_date = String(obj.tx_date || today).slice(0, 10);
  let currency = String(obj.currency || "SAR").trim().toUpperCase();
  if (/(ريال|ر\.?س)/i.test(text) || currency === "ريال" || currency === "SR") currency = "SAR";

  const vendor = String(obj.vendor || "Unknown").trim() || "Unknown";
  const category = String(obj.category || "Uncategorized").trim();
  const description = String(obj.description || "").trim();

  return { tx_date, amount, currency, vendor, category, description };
}

// =====================
// Commands
// =====================
bot.command("ping", (ctx) => ctx.reply("pong ✅"));
bot.command("version", (ctx) => ctx.reply("version: db-bot-v1"));
bot.command("env", (ctx) => {
  ctx.reply(
    `openai: ${openai ? "yes" : "no"}\n` +
      `model: ${OPENAI_MODEL}\n` +
      `db: ${DB_STATUS}\n` +
      (DB_ERROR ? `db_error: ${DB_ERROR.slice(0, 120)}` : "")
  );
});

bot.command("today", async (ctx) => {
  if (!pool) return ctx.reply("DB غير جاهزة. شوف /env");
  const uid = ctx.from.id;
  const d = todayISO();
  const r = await pool.query(
    `select amount::numeric as amount, currency, vendor, category
     from tx
     where tg_user_id=$1 and tx_date=$2
     order by created_at desc
     limit 20`,
    [uid, d]
  );

  if (!r.rowCount) return ctx.reply("اليوم ما في مصروفات.");

  const total = r.rows.reduce((s, x) => s + Number(x.amount), 0);
  const lines = r.rows.map(x => `- ${Number(x.amount).toFixed(2)} ${x.currency} | ${x.category} | ${x.vendor}`).join("\n");
  ctx.reply(`📅 اليوم ${d}\n${lines}\n\nالمجموع: ${total.toFixed(2)} SAR`);
});

// =====================
// Main handler
// =====================
bot.on("text", async (ctx) => {
  const text = (ctx.message?.text || "").trim();
  if (!text || text.startsWith("/")) return;

  if (!openai) return ctx.reply("❌ OpenAI غير مفعّل.");

  try {
    const tx = await aiExtract(text);

    await ctx.reply(
      `✅ تم استخراج المصروف:\n` +
        `💰 ${tx.amount.toFixed(2)} ${tx.currency}\n` +
        `📅 ${tx.tx_date}\n` +
        `🏪 ${tx.vendor}\n` +
        `🏷️ ${tx.category}\n` +
        `📝 ${tx.description || "-"}`
    );

    const status = await saveTx(ctx.from.id, tx, text);

    if (status === "OK") return ctx.reply("💾 تم الحفظ.");
    if (status === "NO_DB") return ctx.reply("ℹ️ DB غير مفعلة. أضف DATABASE_URL.");
    return ctx.reply("⚠️ فشل الحفظ في DB. شوف /env");
  } catch (e) {
    console.error("EXTRACT_FAIL:", e);
    ctx.reply("❌ ما قدرت أفهم المصروف. مثال: غداء 40 ريال مطعم رائد البخاري");
  }
});

// =====================
// Launch
// =====================
(async () => {
  try {
    await initDb(); // safe (never crashes)
    await bot.telegram.deleteWebhook({ drop_pending_updates: true });
    await bot.launch();
    console.log("BOT READY");
  } catch (e) {
    console.error("LAUNCH FAILED:", e);
    process.exit(1);
  }
})();

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
