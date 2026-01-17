import http from "http";
import fs from "fs";
import path from "path";
import PDFDocument from "pdfkit";
import pg from "pg";
import { Telegraf } from "telegraf";
import OpenAI from "openai";

const { Pool } = pg;

// =====================
// ENV
// =====================
const TELEGRAM_BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").trim();
const OPENAI_MODEL = (process.env.OPENAI_MODEL || "gpt-4o-mini").trim();
const DATABASE_URL = (process.env.DATABASE_URL || "").trim();
const AR_FONT_PATH = (process.env.AR_FONT_PATH || "assets/fonts/Cairo-Regular.ttf").trim();
const COMPANY_NAME = (process.env.COMPANY_NAME || "Samir Budget Bot").trim();

if (!TELEGRAM_BOT_TOKEN) {
  console.error("FATAL: TELEGRAM_BOT_TOKEN missing");
  process.exit(1);
}

// =====================
// Keep-alive HTTP (Railway)
// =====================
const PORT = Number(process.env.PORT || 3000);
http.createServer((_, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("ok");
}).listen(PORT, () => console.log("HTTP OK on", PORT));

// =====================
// Bot + OpenAI
// =====================
const bot = new Telegraf(TELEGRAM_BOT_TOKEN);
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

bot.use((ctx, next) => {
  if (!ctx.from) return;
  return next();
});

// =====================
// DB
// =====================
let pool = null;
let DB_STATUS = "disabled";
let DB_ERROR = "";
let LAST_ERROR = "";

function setDbError(e) {
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
      ssl: { rejectUnauthorized: false },
    });
    await pool.query("select 1");

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
        source text,
        created_at timestamptz not null default now()
      );

      create index if not exists idx_tx_user_date on tx (tg_user_id, tx_date);
      create index if not exists idx_tx_user_created on tx (tg_user_id, created_at desc);

      create table if not exists budgets (
        id bigserial primary key,
        tg_user_id bigint not null,
        month text not null,
        category text not null,
        amount numeric(12,2) not null,
        currency text not null default 'SAR',
        created_at timestamptz not null default now(),
        unique (tg_user_id, month, category)
      );
    `);

    DB_STATUS = "enabled";
    console.log("DB READY");
  } catch (e) {
    pool = null;
    DB_STATUS = "error";
    setDbError(e);
  }
}

// =====================
// Helpers
// =====================
const CATEGORIES = [
  "Food","Transport","Utilities","Rent","Business","Personal","Equipment","Raw materials","Uncategorized"
];

const todayISO = () => new Date().toISOString().slice(0, 10);
const thisMonthKey = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};
const ensureMonthFormat = (m) => /^\d{4}-\d{2}$/.test(m);
const safeNum = (n, fb = 0) => (Number.isFinite(Number(n)) ? Number(n) : fb);
const money = (n) => safeNum(n).toFixed(2);

// =====================
// AI Extract (Text)
// =====================
async function extractFromText(text) {
  if (!openai) throw new Error("OpenAI disabled");
  const today = todayISO();

  const r = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: `Return ONLY JSON: tx_date, amount, currency, vendor, category, description. category in: ${CATEGORIES.join(", ")}` },
      { role: "user", content:
        `Today ${today}. Extract ONE expense from:\n"${text}"\n` +
        `Rules: "ريال" => SAR. If date missing use today. Return JSON only.` }
    ]
  });

  const obj = JSON.parse(r.choices?.[0]?.message?.content || "{}");
  const amount = Number(obj.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("Invalid amount");

  return {
    tx_date: String(obj.tx_date || today).slice(0,10),
    amount,
    currency: String(obj.currency || "SAR").toUpperCase(),
    vendor: String(obj.vendor || "Unknown").trim() || "Unknown",
    category: CATEGORIES.includes(obj.category) ? obj.category : "Uncategorized",
    description: String(obj.description || "").trim()
  };
}

// =====================
// AI Extract (Image URL)
// =====================
async function extractFromImageUrl(imageUrl) {
  if (!openai) throw new Error("OpenAI disabled");
  const today = todayISO();

  const r = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: `Return ONLY JSON: tx_date, amount, currency, vendor, category, description. category in: ${CATEGORIES.join(", ")}` },
      { role: "user", content: [
        { type: "text", text:
          `Today ${today}. Extract ONE expense from receipt image.\n` +
          `Pick FINAL total (الإجمالي/Total). If currency missing & Arabic => SAR.\n` +
          `If date missing use today. Return JSON only.` },
        { type: "image_url", image_url: { url: imageUrl } }
      ]}
    ]
  });

  const obj = JSON.parse(r.choices?.[0]?.message?.content || "{}");
  const amount = Number(obj.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("Invalid amount");

  return {
    tx_date: String(obj.tx_date || today).slice(0,10),
    amount,
    currency: String(obj.currency || "SAR").toUpperCase(),
    vendor: String(obj.vendor || "Unknown").trim() || "Unknown",
    category: CATEGORIES.includes(obj.category) ? obj.category : "Uncategorized",
    description: String(obj.description || "Receipt").trim()
  };
}

// =====================
// DB Ops (FIXED: throw real error)
// =====================
async function saveTx(uid, tx, raw, source) {
  if (!pool) throw new Error("DB not initialized");
  try {
    await pool.query(
      `insert into tx (tg_user_id, tx_date, amount, currency, vendor, category, description, raw_text, source)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [uid, tx.tx_date, tx.amount, tx.currency, tx.vendor, tx.category, tx.description, raw, source]
    );
    return "OK";
  } catch (e) {
    setDbError(e);
    throw e; // <-- IMPORTANT
  }
}

async function setBudget(uid, month, category, amount) {
  await pool.query(
    `insert into budgets (tg_user_id, month, category, amount)
     values ($1,$2,$3,$4)
     on conflict (tg_user_id, month, category)
     do update set amount=excluded.amount`,
    [uid, month, category, amount]
  );
}

// =====================
// Commands
// =====================
bot.command("ping", (ctx) => ctx.reply("pong ✅"));

bot.command("env", (ctx) => {
  ctx.reply(
    `openai: ${openai ? "yes" : "no"}\n` +
    `model: ${OPENAI_MODEL}\n` +
    `db: ${DB_STATUS}\n` +
    `db_error: ${DB_ERROR ? DB_ERROR.slice(0,200) : "no"}`
  );
});

bot.command("last_error", (ctx) => {
  ctx.reply(LAST_ERROR || "no");
});

// =====================
// TEXT
// =====================
bot.on("text", async (ctx) => {
  const t = (ctx.message?.text || "").trim();
  if (!t || t.startsWith("/")) return;

  try {
    LAST_ERROR = "";
    const tx = await extractFromText(t);
    await ctx.reply(
      `✅ تم استخراج المصروف:\n` +
      `💰 ${money(tx.amount)} ${tx.currency}\n` +
      `📅 ${tx.tx_date}\n` +
      `🏪 ${tx.vendor}\n` +
      `🏷️ ${tx.category}\n` +
      `📝 ${tx.description || "-"}`
    );
    await saveTx(ctx.from.id, tx, t, "TEXT");
    await ctx.reply("💾 تم الحفظ.");
  } catch (e) {
    LAST_ERROR = String(e?.stack || e?.message || e);
    return ctx.reply("❌ فشل الحفظ/الاستخراج. اكتب /last_error");
  }
});

// =====================
// PHOTO (Telegram URL – FIXED)
// =====================
bot.on("photo", async (ctx) => {
  try {
    LAST_ERROR = "";
    if (!pool) throw new Error("DB not initialized");
    const photos = ctx.message?.photo || [];
    if (!photos.length) throw new Error("No photo");
    const pick = photos[Math.floor(photos.length / 2)];
    const link = await ctx.telegram.getFileLink(pick.file_id);

    await ctx.reply("⏳ جاري قراءة الفاتورة...");
    const tx = await extractFromImageUrl(link.href);

    await ctx.reply(
      `✅ تم استخراج الفاتورة:\n` +
      `💰 ${money(tx.amount)} ${tx.currency}\n` +
      `📅 ${tx.tx_date}\n` +
      `🏪 ${tx.vendor}\n` +
      `🏷️ ${tx.category}\n` +
      `📝 ${tx.description || "-"}`
    );

    await saveTx(ctx.from.id, tx, "IMAGE_URL", "IMAGE");
    await ctx.reply("💾 تم الحفظ.");
  } catch (e) {
    LAST_ERROR = String(e?.stack || e?.message || e);
    return ctx.reply("⚠️ فشل قراءة/حفظ الفاتورة. اكتب /last_error");
  }
});

// =====================
// Launch
// =====================
bot.catch((e) => console.error("BOT ERROR:", e));
process.on("unhandledRejection", (e) => console.error("UNHANDLED:", e));
process.on("uncaughtException", (e) => console.error("UNCAUGHT:", e));

(async () => {
  try {
    await initDb();
    await bot.telegram.deleteWebhook({ drop_pending_updates: true });
    const me = await bot.telegram.getMe();
    console.log("BOT USERNAME:", me.username);
    await bot.launch();
    console.log("BOT READY");
  } catch (e) {
    console.error("LAUNCH FAILED:", e);
    process.exit(1);
  }
})();

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
