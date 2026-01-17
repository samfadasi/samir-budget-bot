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
// Keep-alive HTTP
// =====================
const PORT = Number(process.env.PORT || 3000);
http
  .createServer((_, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
  })
  .listen(PORT, () => console.log("HTTP OK on", PORT));

// =====================
// Bot + OpenAI
// =====================
const bot = new Telegraf(TELEGRAM_BOT_TOKEN);
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

// ignore updates without user
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

function setDbError(e) {
  DB_ERROR = String(e?.stack || e?.message || e);
  console.error("[DB]", DB_ERROR);
}

async function ensureSchema() {
  // base tx
  await pool.query(`
    create table if not exists tx (
      id bigserial primary key,
      tg_user_id bigint not null,
      tx_date date not null,
      amount numeric(12,2) not null,
      currency text not null default 'SAR',
      vendor text,
      category text,
      description text
    );
  `);

  // migrations for older installs (idempotent)
  await pool.query(`alter table tx add column if not exists raw_text text;`);
  await pool.query(`alter table tx add column if not exists source text;`);
  await pool.query(`alter table tx add column if not exists created_at timestamptz not null default now();`);

  await pool.query(`create index if not exists idx_tx_user_date on tx (tg_user_id, tx_date);`);
  await pool.query(`create index if not exists idx_tx_user_created on tx (tg_user_id, created_at desc);`);

  // budgets
  await pool.query(`
    create table if not exists budgets (
      id bigserial primary key,
      tg_user_id bigint not null,
      month text not null, -- YYYY-MM
      category text not null,
      amount numeric(12,2) not null,
      currency text not null default 'SAR',
      created_at timestamptz not null default now(),
      unique (tg_user_id, month, category)
    );
  `);

  // persistent bot state (last error)
  await pool.query(`
    create table if not exists bot_state (
      tg_user_id bigint primary key,
      last_error text,
      updated_at timestamptz not null default now()
    );
  `);
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
    await ensureSchema();

    DB_STATUS = "enabled";
    console.log("DB READY");
  } catch (e) {
    pool = null;
    DB_STATUS = "error";
    setDbError(e);
  }
}

async function setLastError(tgUserId, message) {
  try {
    if (!pool) return;
    const msg = String(message || "").slice(0, 8000);
    await pool.query(
      `insert into bot_state (tg_user_id, last_error, updated_at)
       values ($1,$2,now())
       on conflict (tg_user_id)
       do update set last_error=excluded.last_error, updated_at=excluded.updated_at`,
      [tgUserId, msg]
    );
  } catch (e) {
    // do not crash on error logging
    console.error("setLastError failed:", e);
  }
}

async function getLastError(tgUserId) {
  if (!pool) return "";
  const r = await pool.query(`select last_error from bot_state where tg_user_id=$1`, [tgUserId]);
  return r.rowCount ? String(r.rows[0].last_error || "") : "";
}

// =====================
// Helpers
// =====================
const CATEGORIES = [
  "Food",
  "Transport",
  "Utilities",
  "Rent",
  "Business",
  "Personal",
  "Equipment",
  "Raw materials",
  "Uncategorized",
];

const todayISO = () => new Date().toISOString().slice(0, 10);
const thisMonthKey = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};
const ensureMonthFormat = (m) => /^\d{4}-\d{2}$/.test(m);
const safeNum = (n, fb = 0) => (Number.isFinite(Number(n)) ? Number(n) : fb);
const money = (n) => safeNum(n).toFixed(2);

function shortErr(e) {
  const s = String(e?.message || e || "");
  return s.length > 180 ? s.slice(0, 180) + "..." : s;
}

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
      {
        role: "system",
        content:
          "Return ONLY JSON with keys: tx_date, amount, currency, vendor, category, description. " +
          `category must be one of: ${CATEGORIES.join(", ")}.`,
      },
      {
        role: "user",
        content:
          `Today is ${today}.\nExtract ONE expense from:\n"${text}"\n\n` +
          `Rules: "ريال" => SAR. If date missing use today. Return JSON only.`,
      },
    ],
  });

  const obj = JSON.parse(r.choices?.[0]?.message?.content || "{}");
  const amount = Number(obj.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("Invalid amount");

  let currency = String(obj.currency || "SAR").trim().toUpperCase();
  if (/(ريال|ر\.?س)/i.test(text) || currency === "SR" || currency === "ريال") currency = "SAR";

  let category = String(obj.category || "Uncategorized").trim() || "Uncategorized";
  if (!CATEGORIES.includes(category)) category = "Uncategorized";

  return {
    tx_date: String(obj.tx_date || today).slice(0, 10),
    amount,
    currency,
    vendor: String(obj.vendor || "Unknown").trim() || "Unknown",
    category,
    description: String(obj.description || "").trim(),
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
      {
        role: "system",
        content:
          "Return ONLY JSON with keys: tx_date, amount, currency, vendor, category, description. " +
          "tx_date format YYYY-MM-DD. amount is number. currency like SAR. " +
          `category must be one of: ${CATEGORIES.join(", ")}.`,
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              `Today is ${today}.\nExtract ONE expense from this receipt image.\n` +
              `Pick FINAL total (الإجمالي/Total) not subtotal.\n` +
              `If currency missing & Arabic/ريال => SAR.\n` +
              `Vendor = store/restaurant name.\nIf date missing use today.\nReturn JSON only.`,
          },
          { type: "image_url", image_url: { url: imageUrl } },
        ],
      },
    ],
  });

  const obj = JSON.parse(r.choices?.[0]?.message?.content || "{}");
  const amount = Number(obj.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("Invalid amount");

  let currency = String(obj.currency || "SAR").trim().toUpperCase();
  if (currency === "SR" || currency === "ريال") currency = "SAR";

  let category = String(obj.category || "Uncategorized").trim() || "Uncategorized";
  if (!CATEGORIES.includes(category)) category = "Uncategorized";

  return {
    tx_date: String(obj.tx_date || today).slice(0, 10),
    amount,
    currency,
    vendor: String(obj.vendor || "Unknown").trim() || "Unknown",
    category,
    description: String(obj.description || "Receipt").trim(),
  };
}

// =====================
// DB Ops
// =====================
async function saveTx(uid, tx, rawText, source) {
  if (!pool) throw new Error("DB not initialized");
  await pool.query(
    `insert into tx (tg_user_id, tx_date, amount, currency, vendor, category, description, raw_text, source)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [uid, tx.tx_date, tx.amount, tx.currency, tx.vendor, tx.category, tx.description, rawText, source]
  );
}

async function setBudget(uid, month, category, amount) {
  await pool.query(
    `insert into budgets (tg_user_id, month, category, amount, currency)
     values ($1,$2,$3,$4,'SAR')
     on conflict (tg_user_id, month, category)
     do update set amount=excluded.amount, currency='SAR'`,
    [uid, month, category, amount]
  );
}

async function listBudgetsWithSpent(uid, month) {
  const buds = await pool.query(
    `select category, amount::numeric as budget
     from budgets where tg_user_id=$1 and month=$2 order by category asc`,
    [uid, month]
  );

  const spent = await pool.query(
    `select category, coalesce(sum(amount),0)::numeric as total
     from tx
     where tg_user_id=$1 and to_char(tx_date,'YYYY-MM')=$2
     group by category`,
    [uid, month]
  );

  const spentMap = new Map(spent.rows.map((x) => [x.category, safeNum(x.total)]));
  return buds.rows.map((b) => {
    const s = spentMap.get(b.category) || 0;
    const bud = safeNum(b.budget);
    const pct = bud > 0 ? Math.round((s / bud) * 100) : 0;
    return { category: b.category, spent: s, budget: bud, pct };
  });
}

async function checkBudgetAlerts(ctx, uid, tx) {
  if (!pool) return;
  const month = String(tx.tx_date).slice(0, 7);

  const b = await pool.query(
    `select amount::numeric as budget from budgets where tg_user_id=$1 and month=$2 and category=$3`,
    [uid, month, tx.category]
  );
  if (!b.rowCount) return;

  const budget = safeNum(b.rows[0].budget);
  if (budget <= 0) return;

  const s = await pool.query(
    `select coalesce(sum(amount),0)::numeric as spent
     from tx
     where tg_user_id=$1 and to_char(tx_date,'YYYY-MM')=$2 and category=$3`,
    [uid, month, tx.category]
  );

  const spent = safeNum(s.rows[0].spent);
  const pct = (spent / budget) * 100;

  if (pct >= 100) {
    await ctx.reply(`🚨 تجاوزت ميزانية ${tx.category} لشهر ${month}\n${money(spent)} / ${money(budget)} SAR`);
  } else if (pct >= 80) {
    await ctx.reply(`⚠️ وصلت 80% من ميزانية ${tx.category} لشهر ${month}\n${money(spent)} / ${money(budget)} SAR`);
  }
}

// =====================
// PDF (kept stable)
// =====================
function registerArabicFont(doc) {
  try {
    const abs = path.isAbsolute(AR_FONT_PATH) ? AR_FONT_PATH : path.join(process.cwd(), AR_FONT_PATH);
    if (fs.existsSync(abs)) doc.registerFont("AR", abs);
  } catch (_) {}
}

function collectPdfBuffer(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.end();
  });
}

function drawHeader(doc, title, sub) {
  doc.font("Helvetica").fontSize(16).text(COMPANY_NAME, 40, 40);
  doc.font("Helvetica").fontSize(14).text(title, 40, 62);
  doc.font("Helvetica").fontSize(10).fillColor("#444").text(sub, 40, 84).fillColor("#000");
  doc.moveTo(40, 118).lineTo(555, 118).stroke();
  doc.y = 140;
}

function drawTable(doc, cols, rows) {
  const startX = 40;
  let y = doc.y;
  const headerH = 22;
  const paddingX = 4;
  const paddingY = 6;
  const pageBottomY = 780;
  const minRowH = 20;

  const totalW = cols.reduce((s, c) => s + c.w, 0);
  doc.rect(startX, y, totalW, headerH).fill("#f0f0f0");
  doc.fillColor("#000").fontSize(10).font("Helvetica");

  let x = startX;
  for (const c of cols) {
    doc.text(c.h, x + paddingX, y + 6, { width: c.w - paddingX * 2 });
    x += c.w;
  }
  y += headerH;

  for (const row of rows) {
    let rowH = minRowH;
    for (let i = 0; i < cols.length; i++) {
      const cell = String(row[i] ?? "").replace(/\s+/g, " ").trim();
      const w = cols[i].w - paddingX * 2;
      const h = doc.heightOfString(cell || " ", { width: w, align: "left" });
      rowH = Math.max(rowH, h + paddingY * 2);
    }

    if (y + rowH > pageBottomY) {
      doc.addPage();
      y = 60;
      doc.rect(startX, y, totalW, headerH).fill("#f0f0f0");
      doc.fillColor("#000").fontSize(10).font("Helvetica");
      x = startX;
      for (const c of cols) {
        doc.text(c.h, x + paddingX, y + 6, { width: c.w - paddingX * 2 });
        x += c.w;
      }
      y += headerH;
    }

    x = startX;
    for (let i = 0; i < cols.length; i++) {
      const w = cols[i].w;
      doc.rect(x, y, w, rowH).strokeColor("#dddddd").stroke();
      doc.strokeColor("#000000");
      const cell = String(row[i] ?? "").replace(/\s+/g, " ").trim();
      doc.font("Helvetica").text(cell, x + paddingX, y + paddingY, { width: w - paddingX * 2, align: "left" });
      x += w;
    }
    y += rowH;
  }
  doc.y = y + 12;
}

async function buildMonthPdf(uid, month) {
  const tx = await pool.query(
    `select to_char(tx_date,'YYYY-MM-DD') as tx_date, amount::numeric as amount, currency, vendor, category, description
     from tx where tg_user_id=$1 and to_char(tx_date,'YYYY-MM')=$2
     order by tx_date desc, created_at desc`,
    [uid, month]
  );

  const byCat = await pool.query(
    `select category, coalesce(sum(amount),0)::numeric as total
     from tx where tg_user_id=$1 and to_char(tx_date,'YYYY-MM')=$2
     group by category order by total desc`,
    [uid, month]
  );

  const total = byCat.rows.reduce((s, x) => s + safeNum(x.total), 0);

  const doc = new PDFDocument({ size: "A4", margin: 40 });
  registerArabicFont(doc);

  drawHeader(doc, "Monthly Expense Report", `Month: ${month} | Currency: SAR`);
  doc.font("Helvetica").fontSize(11).text(`Total: ${money(total)} SAR`);
  doc.y += 12;

  doc.font("Helvetica").fontSize(12).text("Summary by Category");
  doc.y += 8;

  const summaryCols = [
    { h: "Category", w: 260 },
    { h: "Total (SAR)", w: 120 },
    { h: "Share", w: 135 },
  ];
  const summaryRows = byCat.rows.map((x) => {
    const t = safeNum(x.total);
    const pct = total > 0 ? `${Math.round((t / total) * 100)}%` : "0%";
    return [x.category || "Uncategorized", money(t), pct];
  });
  if (summaryRows.length) drawTable(doc, summaryCols, summaryRows);
  else doc.font("Helvetica").fontSize(11).text("No summary data.");

  doc.font("Helvetica").fontSize(12).text("Detailed Transactions");
  doc.y += 8;

  const cols = [
    { h: "Date", w: 70 },
    { h: "Amount", w: 80 },
    { h: "Category", w: 90 },
    { h: "Vendor", w: 160 },
    { h: "Notes", w: 155 },
  ];
  const rows = tx.rows.map((x) => [
    x.tx_date,
    `${money(x.amount)} ${x.currency || "SAR"}`,
    x.category || "",
    x.vendor || "",
    x.description || "",
  ]);
  if (rows.length) drawTable(doc, cols, rows);
  else doc.font("Helvetica").fontSize(12).text("No transactions found for this month.");

  doc.font("Helvetica").fontSize(9).fillColor("#444").text(`Generated • ${new Date().toISOString()}`).fillColor("#000");
  return await collectPdfBuffer(doc);
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
      `ar_font: ${AR_FONT_PATH}\n` +
      `db_error: ${DB_ERROR ? DB_ERROR.slice(0, 220) : "no"}`
  );
});

bot.command("last_error", async (ctx) => {
  try {
    if (!pool) return ctx.reply("no (db disabled)");
    const msg = await getLastError(ctx.from.id);
    return ctx.reply(msg || "no");
  } catch (e) {
    return ctx.reply("no");
  }
});

bot.command("today", async (ctx) => {
  try {
    if (!pool) return ctx.reply("DB غير جاهزة. شوف /env");
    const uid = ctx.from.id;
    const d = todayISO();

    const r = await pool.query(
      `select amount::numeric as amount, currency, vendor, category
       from tx where tg_user_id=$1 and tx_date=$2
       order by created_at desc limit 30`,
      [uid, d]
    );

    if (!r.rowCount) return ctx.reply("اليوم ما في مصروفات.");
    const total = r.rows.reduce((s, x) => s + safeNum(x.amount), 0);
    const lines = r.rows.map((x) => `- ${money(x.amount)} ${x.currency} | ${x.category} | ${x.vendor}`).join("\n");
    return ctx.reply(`📅 اليوم ${d}\n${lines}\n\nالمجموع: ${money(total)} SAR`);
  } catch (e) {
    await setLastError(ctx.from.id, e?.stack || e?.message || e);
    return ctx.reply("⚠️ خطأ في تقرير اليوم. /last_error");
  }
});

bot.command("month", async (ctx) => {
  try {
    if (!pool) return ctx.reply("DB غير جاهزة. شوف /env");
    const uid = ctx.from.id;
    const m = thisMonthKey();

    const r = await pool.query(
      `select category, coalesce(sum(amount),0)::numeric as total
       from tx where tg_user_id=$1 and to_char(tx_date,'YYYY-MM')=$2
       group by category order by total desc`,
      [uid, m]
    );

    if (!r.rowCount) return ctx.reply(`📊 شهر ${m}: ما في مصروفات مسجلة.`);
    const total = r.rows.reduce((s, x) => s + safeNum(x.total), 0);
    const lines = r.rows.map((x) => `- ${x.category}: ${money(x.total)} SAR`).join("\n");
    return ctx.reply(`📊 ملخص شهر ${m}\n${lines}\n\nالمجموع: ${money(total)} SAR`);
  } catch (e) {
    await setLastError(ctx.from.id, e?.stack || e?.message || e);
    return ctx.reply("⚠️ خطأ في تقرير الشهر. /last_error");
  }
});

bot.command("setbudget", async (ctx) => {
  try {
    if (!pool) return ctx.reply("DB غير جاهزة. شوف /env");
    const uid = ctx.from.id;
    const parts = (ctx.message?.text || "").trim().split(/\s+/);
    const category = parts[1];
    const amount = Number(parts[2]);
    const month = (parts[3] || thisMonthKey()).trim();

    if (!CATEGORIES.includes(category)) return ctx.reply(`❌ فئة غير صحيحة:\n${CATEGORIES.join(", ")}`);
    if (!Number.isFinite(amount) || amount <= 0) return ctx.reply("❌ مثال: /setbudget Food 300");
    if (!ensureMonthFormat(month)) return ctx.reply("❌ صيغة الشهر YYYY-MM مثل 2026-01");

    await setBudget(uid, month, category, amount);
    return ctx.reply(`✅ تم ضبط ميزانية ${category} لشهر ${month}: ${money(amount)} SAR`);
  } catch (e) {
    await setLastError(ctx.from.id, e?.stack || e?.message || e);
    return ctx.reply("⚠️ فشل ضبط الميزانية. /last_error");
  }
});

bot.command("budget", async (ctx) => {
  try {
    if (!pool) return ctx.reply("DB غير جاهزة. شوف /env");
    const uid = ctx.from.id;
    const month = thisMonthKey();
    const rows = await listBudgetsWithSpent(uid, month);
    if (!rows.length) return ctx.reply(`ما في ميزانيات لشهر ${month}.\nاستخدم: /setbudget Food 300`);
    const lines = rows.map((x) => `- ${x.category}: ${money(x.spent)} / ${money(x.budget)} SAR (${x.pct}%)`);
    return ctx.reply(`📌 ميزانيات شهر ${month}\n${lines.join("\n")}`);
  } catch (e) {
    await setLastError(ctx.from.id, e?.stack || e?.message || e);
    return ctx.reply("⚠️ فشل عرض الميزانيات. /last_error");
  }
});

bot.command("exportpdf", async (ctx) => {
  try {
    if (!pool) return ctx.reply("DB غير جاهزة. شوف /env");
    const uid = ctx.from.id;
    const parts = (ctx.message?.text || "").trim().split(/\s+/);
    const mode = (parts[1] || "").toLowerCase();
    if (mode !== "month") return ctx.reply("استخدم: /exportpdf month أو /exportpdf month 2026-01");
    const m = (parts[2] || thisMonthKey()).trim();
    if (!ensureMonthFormat(m)) return ctx.reply("صيغة الشهر YYYY-MM مثل 2026-01");

    const buf = await buildMonthPdf(uid, m);
    return ctx.replyWithDocument({ source: buf, filename: `monthly-report-${m}.pdf` });
  } catch (e) {
    await setLastError(ctx.from.id, e?.stack || e?.message || e);
    return ctx.reply("⚠️ فشل تصدير PDF. /last_error");
  }
});

// =====================
// TEXT expense
// =====================
bot.on("text", async (ctx) => {
  const text = (ctx.message?.text || "").trim();
  if (!text || text.startsWith("/")) return;
  if (!openai) return ctx.reply("❌ OpenAI غير مفعّل. أضف OPENAI_API_KEY.");

  try {
    const tx = await extractFromText(text);

    await ctx.reply(
      `✅ تم استخراج المصروف:\n` +
        `💰 ${money(tx.amount)} ${tx.currency}\n` +
        `📅 ${tx.tx_date}\n` +
        `🏪 ${tx.vendor}\n` +
        `🏷️ ${tx.category}\n` +
        `📝 ${tx.description || "-"}`
    );

    await saveTx(ctx.from.id, tx, text, "TEXT");
    await ctx.reply("💾 تم الحفظ.");
    await checkBudgetAlerts(ctx, ctx.from.id, tx);
  } catch (e) {
    await setLastError(ctx.from.id, e?.stack || e?.message || e);
    return ctx.reply(`❌ فشل الحفظ/الاستخراج. السبب: ${shortErr(e)}\nاكتب /last_error للتفاصيل.`);
  }
});

// =====================
// PHOTO receipt expense (Telegram URL)
// =====================
bot.on("photo", async (ctx) => {
  try {
    if (!openai) return ctx.reply("❌ OpenAI غير مفعّل. أضف OPENAI_API_KEY.");
    if (!pool) return ctx.reply("DB غير جاهزة. شوف /env");

    const photos = ctx.message?.photo || [];
    if (!photos.length) return ctx.reply("❌ ما لقيت صورة.");

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
    await checkBudgetAlerts(ctx, ctx.from.id, tx);
  } catch (e) {
    await setLastError(ctx.from.id, e?.stack || e?.message || e);
    return ctx.reply(`⚠️ فشل قراءة/حفظ الفاتورة. السبب: ${shortErr(e)}\nاكتب /last_error للتفاصيل.`);
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
