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
http
  .createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
  })
  .listen(PORT, () => console.log("HTTP OK on port", PORT));

// =====================
// Bot + OpenAI
// =====================
const bot = new Telegraf(TELEGRAM_BOT_TOKEN);
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

// avoid crashes on updates without user (channels/system updates)
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
        month text not null, -- YYYY-MM
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
    DB_STATUS = "error";
    pool = null;
    setDbError(e);
  }
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

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}
function thisMonthKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
function ensureMonthFormat(m) {
  return /^\d{4}-\d{2}$/.test(m);
}
function safeNum(n, fallback = 0) {
  const x = Number(n);
  return Number.isFinite(x) ? x : fallback;
}
function formatMoney(n) {
  return safeNum(n).toFixed(2);
}

// =====================
// AI Extract (Text)
// =====================
async function extractExpenseFromText(text) {
  if (!openai) throw new Error("OpenAI disabled");

  const today = todayISO();

  const res = await openai.chat.completions.create({
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
          `Today is ${today}.\n` +
          `Extract ONE expense from Arabic/English:\n` +
          `"${text}"\n\n` +
          `Rules:\n` +
          `- "ريال" means SAR.\n` +
          `- Meals/restaurant/coffee (غداء/عشاء/فطور/مطعم/قهوة) => category Food.\n` +
          `- If date missing => today.\n` +
          `Return JSON only.`,
      },
    ],
  });

  const raw = res.choices?.[0]?.message?.content?.trim() || "{}";
  const obj = JSON.parse(raw);

  const amount = Number(obj.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("Invalid amount");

  const tx_date = String(obj.tx_date || today).slice(0, 10);

  let currency = String(obj.currency || "SAR").trim().toUpperCase();
  if (/(ريال|ر\.?س)/i.test(text) || currency === "ريال" || currency === "SR") currency = "SAR";

  let category = String(obj.category || "Uncategorized").trim() || "Uncategorized";
  if (!CATEGORIES.includes(category)) category = "Uncategorized";

  return {
    tx_date,
    amount,
    currency,
    vendor: String(obj.vendor || "Unknown").trim() || "Unknown",
    category,
    description: String(obj.description || "").trim(),
  };
}

// =====================
// AI Extract (Receipt Image URL)
// =====================
async function extractExpenseFromImageUrl(imageUrl) {
  if (!openai) throw new Error("OpenAI disabled");
  const today = todayISO();

  const res = await openai.chat.completions.create({
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
              `Today is ${today}.\n` +
              `Extract ONE expense from this receipt/invoice image.\n` +
              `Pick FINAL total (Grand Total / Total / الإجمالي / المجموع النهائي) not subtotal.\n` +
              `If currency missing and Arabic/ريال -> SAR.\n` +
              `Vendor = store/restaurant name.\n` +
              `If date missing use today.\n` +
              `Description = short.\n` +
              `Return JSON only.`,
          },
          { type: "image_url", image_url: { url: imageUrl } },
        ],
      },
    ],
  });

  const raw = res.choices?.[0]?.message?.content?.trim() || "{}";
  const obj = JSON.parse(raw);

  const amount = Number(obj.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("Invalid amount");

  const tx_date = String(obj.tx_date || today).slice(0, 10);

  let currency = String(obj.currency || "SAR").trim().toUpperCase();
  if (currency === "SR" || currency === "ريال") currency = "SAR";

  let category = String(obj.category || "Uncategorized").trim() || "Uncategorized";
  if (!CATEGORIES.includes(category)) category = "Uncategorized";

  return {
    tx_date,
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
async function saveTx(tgUserId, tx, rawText, source) {
  if (!pool) return "NO_DB";
  try {
    await pool.query(
      `insert into tx (tg_user_id, tx_date, amount, currency, vendor, category, description, raw_text, source)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [tgUserId, tx.tx_date, tx.amount, tx.currency, tx.vendor, tx.category, tx.description, rawText, source]
    );
    return "OK";
  } catch (e) {
    setDbError(e);
    return "DB_FAIL";
  }
}

async function setBudget(tgUserId, month, category, amount) {
  await pool.query(
    `insert into budgets (tg_user_id, month, category, amount, currency)
     values ($1,$2,$3,$4,'SAR')
     on conflict (tg_user_id, month, category)
     do update set amount=excluded.amount, currency='SAR'`,
    [tgUserId, month, category, amount]
  );
}

async function listBudgetsWithSpent(tgUserId, month) {
  const buds = await pool.query(
    `select category, amount::numeric as budget
     from budgets
     where tg_user_id=$1 and month=$2
     order by category asc`,
    [tgUserId, month]
  );

  const spent = await pool.query(
    `select category, coalesce(sum(amount),0)::numeric as total
     from tx
     where tg_user_id=$1 and to_char(tx_date,'YYYY-MM')=$2
     group by category`,
    [tgUserId, month]
  );

  const spentMap = new Map(spent.rows.map((x) => [x.category, safeNum(x.total)]));
  return buds.rows.map((b) => {
    const s = spentMap.get(b.category) || 0;
    const bud = safeNum(b.budget);
    const pct = bud > 0 ? Math.round((s / bud) * 100) : 0;
    return { category: b.category, spent: s, budget: bud, pct };
  });
}

async function checkBudgetAlerts(ctx, tgUserId, tx) {
  if (!pool) return;
  const month = String(tx.tx_date).slice(0, 7);
  const b = await pool.query(
    `select amount::numeric as budget from budgets where tg_user_id=$1 and month=$2 and category=$3`,
    [tgUserId, month, tx.category]
  );
  if (!b.rowCount) return;

  const budget = safeNum(b.rows[0].budget);
  if (budget <= 0) return;

  const s = await pool.query(
    `select coalesce(sum(amount),0)::numeric as spent
     from tx
     where tg_user_id=$1 and to_char(tx_date,'YYYY-MM')=$2 and category=$3`,
    [tgUserId, month, tx.category]
  );
  const spent = safeNum(s.rows[0].spent);
  const pct = (spent / budget) * 100;

  if (pct >= 100) {
    await ctx.reply(`🚨 تجاوزت ميزانية ${tx.category} لشهر ${month}\n${formatMoney(spent)} / ${formatMoney(budget)} SAR`);
  } else if (pct >= 80) {
    await ctx.reply(`⚠️ وصلت 80% من ميزانية ${tx.category} لشهر ${month}\n${formatMoney(spent)} / ${formatMoney(budget)} SAR`);
  }
}

// =====================
// PDF (Arabic via Cairo only)
// =====================
function registerArabicFont(doc) {
  try {
    const abs = path.isAbsolute(AR_FONT_PATH) ? AR_FONT_PATH : path.join(process.cwd(), AR_FONT_PATH);
    if (fs.existsSync(abs)) doc.registerFont("AR", abs);
  } catch (_) {}
}

function fontForText(doc, text) {
  const isAr = /[\u0600-\u06FF]/.test(text || "");
  // pdfkit stores fonts internally; when registered, it can be used by name safely
  if (isAr) {
    try {
      doc.font("AR");
      return;
    } catch (_) {
      // fall back
    }
  }
  doc.font("Helvetica");
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

    // calc dynamic height
    for (let i = 0; i < cols.length; i++) {
      const cell = String(row[i] ?? "").replace(/\s+/g, " ").trim();
      const w = cols[i].w - paddingX * 2;
      fontForText(doc, cell);
      const h = doc.heightOfString(cell || " ", { width: w, align: "left" });
      doc.font("Helvetica");
      rowH = Math.max(rowH, h + paddingY * 2);
    }

    if (y + rowH > pageBottomY) {
      doc.addPage();
      y = 60;

      // redraw header
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
      fontForText(doc, cell);
      doc.text(cell, x + paddingX, y + paddingY, { width: w - paddingX * 2, align: "left" });
      doc.font("Helvetica");

      x += w;
    }

    y += rowH;
  }

  doc.y = y + 12;
}

async function buildMonthPdf(tgUserId, month) {
  const tx = await pool.query(
    `select to_char(tx_date,'YYYY-MM-DD') as tx_date,
            amount::numeric as amount, currency, vendor, category, description
     from tx
     where tg_user_id=$1 and to_char(tx_date,'YYYY-MM')=$2
     order by tx_date desc, created_at desc`,
    [tgUserId, month]
  );

  const byCat = await pool.query(
    `select category, coalesce(sum(amount),0)::numeric as total
     from tx
     where tg_user_id=$1 and to_char(tx_date,'YYYY-MM')=$2
     group by category
     order by total desc`,
    [tgUserId, month]
  );

  const total = byCat.rows.reduce((s, x) => s + safeNum(x.total), 0);

  const doc = new PDFDocument({ size: "A4", margin: 40 });
  registerArabicFont(doc);

  drawHeader(doc, "Monthly Expense Report", `Month: ${month} | Currency: SAR`);
  doc.font("Helvetica").fontSize(11).text(`Total: ${formatMoney(total)} SAR`);
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
    return [x.category || "Uncategorized", formatMoney(t), pct];
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
    `${formatMoney(x.amount)} ${x.currency || "SAR"}`,
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

bot.command("last_error", (ctx) => {
  if (!LAST_ERROR) return ctx.reply("no");
  return ctx.reply(LAST_ERROR.slice(0, 3500));
});

bot.command("env", (ctx) => {
  ctx.reply(
    `openai: ${openai ? "yes" : "no"}\n` +
      `model: ${OPENAI_MODEL}\n` +
      `db: ${DB_STATUS}\n` +
      `ar_font: ${AR_FONT_PATH}\n` +
      (DB_ERROR ? `db_error: ${DB_ERROR.slice(0, 220)}` : "")
  );
});

bot.command("start", (ctx) => {
  ctx.reply(
    "✅ البوت شغال.\n\n" +
      "📌 أدخل مصروف نص:\n" +
      "دفعت 40 ريال للغداء من مطعم رائد البخاري\n\n" +
      "📷 أو أرسل صورة فاتورة (Photo) وسيتم استخراج المصروف تلقائياً.\n\n" +
      "أوامر:\n" +
      "/today\n" +
      "/month\n" +
      "/setbudget Food 300\n" +
      "/budget\n" +
      "/exportpdf month\n" +
      "/env\n" +
      "/last_error"
  );
});

bot.command("today", async (ctx) => {
  try {
    if (!pool) return ctx.reply("DB غير جاهزة. شوف /env");
    const uid = ctx.from.id;
    const d = todayISO();

    const r = await pool.query(
      `select amount::numeric as amount, currency, vendor, category
       from tx
       where tg_user_id=$1 and tx_date=$2
       order by created_at desc
       limit 30`,
      [uid, d]
    );

    if (!r.rowCount) return ctx.reply("اليوم ما في مصروفات.");

    const total = r.rows.reduce((s, x) => s + safeNum(x.amount), 0);
    const lines = r.rows.map((x) => `- ${formatMoney(x.amount)} ${x.currency} | ${x.category} | ${x.vendor}`).join("\n");

    return ctx.reply(`📅 اليوم ${d}\n${lines}\n\nالمجموع: ${formatMoney(total)} SAR`);
  } catch (e) {
    LAST_ERROR = String(e?.stack || e?.message || e);
    console.error("TODAY_FAIL:", e);
    return ctx.reply("⚠️ خطأ في تقرير اليوم. اكتب /last_error");
  }
});

bot.command("month", async (ctx) => {
  try {
    if (!pool) return ctx.reply("DB غير جاهزة. شوف /env");
    const uid = ctx.from.id;
    const m = thisMonthKey();

    const r = await pool.query(
      `select category, coalesce(sum(amount),0)::numeric as total
       from tx
       where tg_user_id=$1 and to_char(tx_date,'YYYY-MM')=$2
       group by category
       order by total desc`,
      [uid, m]
    );

    if (!r.rowCount) return ctx.reply(`📊 شهر ${m}: ما في مصروفات مسجلة.`);

    const total = r.rows.reduce((s, x) => s + safeNum(x.total), 0);
    const lines = r.rows.map((x) => `- ${x.category}: ${formatMoney(x.total)} SAR`).join("\n");

    return ctx.reply(`📊 ملخص شهر ${m}\n${lines}\n\nالمجموع: ${formatMoney(total)} SAR`);
  } catch (e) {
    LAST_ERROR = String(e?.stack || e?.message || e);
    console.error("MONTH_FAIL:", e);
    return ctx.reply("⚠️ خطأ في تقرير الشهر. اكتب /last_error");
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

    if (!CATEGORIES.includes(category)) {
      return ctx.reply(`❌ فئة غير صحيحة.\nاستخدم واحدة من:\n${CATEGORIES.join(", ")}`);
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      return ctx.reply("❌ المبلغ لازم يكون رقم موجب.\nمثال: /setbudget Food 300");
    }
    if (!ensureMonthFormat(month)) {
      return ctx.reply("❌ صيغة الشهر غلط. استخدم YYYY-MM مثل: 2026-01");
    }

    await setBudget(uid, month, category, amount);
    return ctx.reply(`✅ تم ضبط ميزانية ${category} لشهر ${month}: ${formatMoney(amount)} SAR`);
  } catch (e) {
    LAST_ERROR = String(e?.stack || e?.message || e);
    console.error("SETBUDGET_FAIL:", e);
    return ctx.reply("⚠️ فشل ضبط الميزانية. اكتب /last_error");
  }
});

bot.command("budget", async (ctx) => {
  try {
    if (!pool) return ctx.reply("DB غير جاهزة. شوف /env");
    const uid = ctx.from.id;
    const month = thisMonthKey();

    const rows = await listBudgetsWithSpent(uid, month);
    if (!rows.length) return ctx.reply(`ما في ميزانيات لشهر ${month}.\nاستخدم: /setbudget Food 300`);

    const lines = rows.map((x) => `- ${x.category}: ${formatMoney(x.spent)} / ${formatMoney(x.budget)} SAR (${x.pct}%)`);
    return ctx.reply(`📌 ميزانيات شهر ${month}\n${lines.join("\n")}`);
  } catch (e) {
    LAST_ERROR = String(e?.stack || e?.message || e);
    console.error("BUDGET_FAIL:", e);
    return ctx.reply("⚠️ فشل عرض الميزانيات. اكتب /last_error");
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
    if (!ensureMonthFormat(m)) return ctx.reply("صيغة الشهر غلط. استخدم YYYY-MM مثل 2026-01");

    const buf = await buildMonthPdf(uid, m);
    return ctx.replyWithDocument({ source: buf, filename: `monthly-report-${m}.pdf` });
  } catch (e) {
    LAST_ERROR = String(e?.stack || e?.message || e);
    console.error("EXPORTPDF_FAIL:", e);
    return ctx.reply("⚠️ فشل تصدير PDF. اكتب /last_error");
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
    LAST_ERROR = "";
    const tx = await extractExpenseFromText(text);

    await ctx.reply(
      `✅ تم استخراج المصروف:\n` +
        `💰 ${formatMoney(tx.amount)} ${tx.currency}\n` +
        `📅 ${tx.tx_date}\n` +
        `🏪 ${tx.vendor}\n` +
        `🏷️ ${tx.category}\n` +
        `📝 ${tx.description || "-"}`
    );

    const status = await saveTx(ctx.from.id, tx, text, "TEXT");
    if (status === "OK") {
      await ctx.reply("💾 تم الحفظ.");
      await checkBudgetAlerts(ctx, ctx.from.id, tx);
      return;
    }
    if (status === "NO_DB") return ctx.reply("ℹ️ DB غير مفعلة. أضف DATABASE_URL.");
    return ctx.reply("⚠️ فشل الحفظ في DB. شوف /env");
  } catch (e) {
    LAST_ERROR = String(e?.stack || e?.message || e);
    console.error("TEXT_EXTRACT_FAIL:", e);
    return ctx.reply("❌ ما قدرت أفهم المصروف. مثال: غداء 40 ريال مطعم رائد البخاري");
  }
});

// =====================
// PHOTO receipt expense (FIXED: use Telegram URL, no base64)
// =====================
bot.on("photo", async (ctx) => {
  try {
    LAST_ERROR = "";
    if (!openai) return ctx.reply("❌ OpenAI غير مفعّل. أضف OPENAI_API_KEY.");
    if (!pool) return ctx.reply("DB غير جاهزة. شوف /env");

    const photos = ctx.message?.photo || [];
    if (!photos.length) return ctx.reply("❌ ما لقيت صورة.");

    // pick medium size to avoid huge images
    const pick = photos[Math.floor(photos.length / 2)];
    if (!pick?.file_id) return ctx.reply("❌ ما لقيت file_id.");

    await ctx.reply("⏳ جاري قراءة الفاتورة...");

    const link = await ctx.telegram.getFileLink(pick.file_id);
    const imageUrl = link.href;

    const tx = await extractExpenseFromImageUrl(imageUrl);

    await ctx.reply(
      `✅ تم استخراج الفاتورة:\n` +
        `💰 ${formatMoney(tx.amount)} ${tx.currency}\n` +
        `📅 ${tx.tx_date}\n` +
        `🏪 ${tx.vendor}\n` +
        `🏷️ ${tx.category}\n` +
        `📝 ${tx.description || "-"}`
    );

    const status = await saveTx(ctx.from.id, tx, "RECEIPT_IMAGE_URL", "IMAGE");
    if (status === "OK") {
      await ctx.reply("💾 تم الحفظ.");
      await checkBudgetAlerts(ctx, ctx.from.id, tx);
      return;
    }
    return ctx.reply("⚠️ تم الاستخراج لكن فشل الحفظ في DB. شوف /env");
  } catch (e) {
    LAST_ERROR = String(e?.stack || e?.message || e);
    console.error("PHOTO_RECEIPT_FAIL:", e);
    return ctx.reply("⚠️ فشل قراءة الفاتورة. اكتب /last_error لعرض سبب الخطأ.");
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
