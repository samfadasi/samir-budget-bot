import http from "http";
import fs from "fs";
import path from "path";
import PDFDocument from "pdfkit";
import OpenAI from "openai";
import pg from "pg";
import { Telegraf } from "telegraf";

const { Pool } = pg;

// =====================
// ENV
// =====================
const TELEGRAM_BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").trim();
const OPENAI_MODEL = (process.env.OPENAI_MODEL || "gpt-4o-mini").trim();
const DATABASE_URL = (process.env.DATABASE_URL || "").trim();

const COMPANY_NAME = (process.env.COMPANY_NAME || "Samir Budget Bot").trim();
const LOGO_PATH = (process.env.LOGO_PATH || "").trim(); // e.g. "./assets/logo.png"

if (!TELEGRAM_BOT_TOKEN) {
  console.error("FATAL: TELEGRAM_BOT_TOKEN missing");
  process.exit(1);
}

// =====================
// KEEP-ALIVE HTTP
// =====================
const PORT = Number(process.env.PORT || 3000);
http
  .createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
  })
  .listen(PORT, () => console.log("HTTP OK on port", PORT));

// =====================
// BOT + OPENAI
// =====================
const bot = new Telegraf(TELEGRAM_BOT_TOKEN);
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

// =====================
// DB (SAFE INIT)
// =====================
let pool = null;
let DB_STATUS = "disabled";
let DB_ERROR = "";

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

    // Transactions
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

      create index if not exists idx_tx_user_created
        on tx (tg_user_id, created_at desc);

      create index if not exists idx_tx_user_month_cat
        on tx (tg_user_id, category, tx_date);
    `);

    // Budgets
    await pool.query(`
      create table if not exists budgets (
        id bigserial primary key,
        tg_user_id bigint not null,
        month text not null,      -- YYYY-MM
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
    setDbError(e);
    pool = null; // do not crash
  }
}

// =====================
// HELPERS
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

function safeNum(n, fallback = 0) {
  const x = Number(n);
  return Number.isFinite(x) ? x : fallback;
}

function formatMoney(n) {
  return safeNum(n).toFixed(2);
}

function ensureMonthFormat(m) {
  return /^\d{4}-\d{2}$/.test(m);
}

// =====================
// AI Extract (Strict JSON)
// =====================
async function extractExpense(text) {
  if (!openai) throw new Error("OpenAI disabled");

  const today = todayISO();

  const res = await openai.chat.completions.create({
    model: OPENAI_MODEL,
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
          `"${text}"\n` +
          `Rules:\n` +
          `- "ريال" means SAR.\n` +
          `- Meals/restaurant/coffee (غداء/عشاء/فطور/مطعم/قهوة) => category Food.\n` +
          `- If date missing => today.\n` +
          `Return JSON only.`,
      },
    ],
    response_format: { type: "json_object" },
    temperature: 0,
  });

  const out = res.choices?.[0]?.message?.content?.trim() || "{}";
  const obj = JSON.parse(out);

  const amount = Number(obj.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("Invalid amount");

  const tx_date = String(obj.tx_date || today).slice(0, 10);

  let currency = String(obj.currency || "SAR").trim().toUpperCase();
  if (/(ريال|ر\.?س)/i.test(text) || currency === "ريال" || currency === "SR") currency = "SAR";

  const vendor = String(obj.vendor || "Unknown").trim() || "Unknown";
  let category = String(obj.category || "Uncategorized").trim() || "Uncategorized";
  if (!CATEGORIES.includes(category)) category = "Uncategorized";

  const description = String(obj.description || "").trim();

  return { tx_date, amount, currency, vendor, category, description };
}

// =====================
// DB OPS
// =====================
async function saveTx(tgUserId, tx, rawText) {
  if (!pool) return "NO_DB";
  try {
    await pool.query(
      `insert into tx (tg_user_id, tx_date, amount, currency, vendor, category, description, raw_text)
       values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [tgUserId, tx.tx_date, tx.amount, tx.currency, tx.vendor, tx.category, tx.description, rawText]
    );
    return "OK";
  } catch (e) {
    setDbError(e);
    return "DB_FAIL";
  }
}

async function getBudget(tgUserId, month, category) {
  if (!pool) return null;
  const r = await pool.query(
    `select amount::numeric as budget, currency
     from budgets
     where tg_user_id=$1 and month=$2 and category=$3`,
    [tgUserId, month, category]
  );
  return r.rowCount ? { budget: safeNum(r.rows[0].budget), currency: r.rows[0].currency } : null;
}

async function getSpent(tgUserId, month, category) {
  if (!pool) return 0;
  const r = await pool.query(
    `select coalesce(sum(amount),0)::numeric as spent
     from tx
     where tg_user_id=$1 and to_char(tx_date,'YYYY-MM')=$2 and category=$3`,
    [tgUserId, month, category]
  );
  return safeNum(r.rows[0]?.spent || 0);
}

async function checkBudgetAlerts(ctx, tgUserId, tx) {
  if (!pool) return;

  const month = String(tx.tx_date).slice(0, 7);
  const b = await getBudget(tgUserId, month, tx.category);
  if (!b || !Number.isFinite(b.budget) || b.budget <= 0) return;

  const spent = await getSpent(tgUserId, month, tx.category);
  const pct = (spent / b.budget) * 100;

  if (pct >= 100) {
    await ctx.reply(`🚨 تجاوزت الميزانية لفئة ${tx.category} في ${month}\n${formatMoney(spent)} / ${formatMoney(b.budget)} SAR`);
  } else if (pct >= 80) {
    await ctx.reply(`⚠️ وصلت 80% من ميزانية ${tx.category} في ${month}\n${formatMoney(spent)} / ${formatMoney(b.budget)} SAR`);
  }
}

// =====================
// PDF GENERATION
// =====================
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
  const top = 40;

  // Logo (optional)
  try {
    if (LOGO_PATH) {
      const abs = path.isAbsolute(LOGO_PATH) ? LOGO_PATH : path.join(process.cwd(), LOGO_PATH);
      if (fs.existsSync(abs)) {
        doc.image(abs, 40, top, { width: 60 });
      }
    }
  } catch (e) {
    // don't fail PDF for logo
  }

  doc
    .fontSize(16)
    .text(COMPANY_NAME, 110, top, { align: "left" })
    .moveDown(0.2);

  doc
    .fontSize(14)
    .text(title, 110, top + 22, { align: "left" })
    .moveDown(0.2);

  doc
    .fontSize(10)
    .fillColor("#444444")
    .text(sub, 110, top + 42, { align: "left" })
    .fillColor("#000000");

  doc.moveTo(40, top + 75).lineTo(555, top + 75).stroke();
  doc.moveDown(2);
}

function drawTable(doc, columns, rows, options = {}) {
  const startX = 40;
  let y = options.startY || doc.y;
  const rowH = options.rowH || 18;

  const colWidths = columns.map((c) => c.width);
  const headers = columns.map((c) => c.header);

  // Header background
  doc.rect(startX, y, colWidths.reduce((a, b) => a + b, 0), rowH).fill("#f0f0f0");
  doc.fillColor("#000000").fontSize(10);

  let x = startX;
  for (let i = 0; i < headers.length; i++) {
    doc.text(headers[i], x + 4, y + 4, { width: colWidths[i] - 8, align: "left" });
    x += colWidths[i];
  }
  y += rowH;

  // Rows
  doc.fontSize(10);
  for (const r of rows) {
    // page break
    if (y > 760) {
      doc.addPage();
      y = 60;
    }

    x = startX;
    for (let i = 0; i < columns.length; i++) {
      doc.rect(x, y, colWidths[i], rowH).strokeColor("#dddddd").stroke();
      doc.strokeColor("#000000");
      doc.text(String(r[i] ?? ""), x + 4, y + 4, { width: colWidths[i] - 8, align: "left" });
      x += colWidths[i];
    }
    y += rowH;
  }

  doc.moveDown(1);
  doc.y = y + 10;
}

async function buildTodayPdf(tgUserId) {
  if (!pool) throw new Error("DB not ready");

  const d = todayISO();

  const r = await pool.query(
    `select tx_date, amount::numeric as amount, currency, vendor, category, description
     from tx
     where tg_user_id=$1 and tx_date=$2
     order by created_at desc`,
    [tgUserId, d]
  );

  const total = r.rows.reduce((s, x) => s + safeNum(x.amount), 0);

  const doc = new PDFDocument({ size: "A4", margin: 40 });
  drawHeader(doc, "Daily Expense Report", `Date: ${d}   |   Currency: SAR`);

  doc.fontSize(11).text(`Total: ${formatMoney(total)} SAR`).moveDown(0.6);

  const columns = [
    { header: "Date", width: 70 },
    { header: "Amount", width: 70 },
    { header: "Category", width: 90 },
    { header: "Vendor", width: 170 },
    { header: "Notes", width: 155 },
  ];

  const rows = r.rows.map((x) => [
    String(x.tx_date || d),
    `${formatMoney(x.amount)} ${x.currency || "SAR"}`,
    x.category || "",
    x.vendor || "",
    x.description || "",
  ]);

  if (!rows.length) {
    doc.fontSize(12).text("No transactions found for today.");
  } else {
    drawTable(doc, columns, rows);
  }

  doc
    .fontSize(9)
    .fillColor("#444444")
    .text(`Generated by ${COMPANY_NAME} • ${new Date().toISOString()}`, { align: "left" })
    .fillColor("#000000");

  return await collectPdfBuffer(doc);
}

async function buildMonthPdf(tgUserId, month) {
  if (!pool) throw new Error("DB not ready");
  if (!ensureMonthFormat(month)) throw new Error("Bad month format");

  const r = await pool.query(
    `select tx_date, amount::numeric as amount, currency, vendor, category, description
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
  drawHeader(doc, "Monthly Expense Report", `Month: ${month}   |   Currency: SAR`);

  doc.fontSize(11).text(`Total: ${formatMoney(total)} SAR`).moveDown(0.8);

  // Summary table
  doc.fontSize(12).text("Summary by Category").moveDown(0.4);
  drawTable(
    doc,
    [
      { header: "Category", width: 260 },
      { header: "Total (SAR)", width: 120 },
      { header: "Share", width: 135 },
    ],
    byCat.rows.map((x) => {
      const t = safeNum(x.total);
      const pct = total > 0 ? `${Math.round((t / total) * 100)}%` : "0%";
      return [x.category || "Uncategorized", formatMoney(t), pct];
    }),
    { startY: doc.y }
  );

  // Detailed table
  doc.fontSize(12).text("Detailed Transactions").moveDown(0.4);

  const columns = [
    { header: "Date", width: 70 },
    { header: "Amount", width: 70 },
    { header: "Category", width: 90 },
    { header: "Vendor", width: 170 },
    { header: "Notes", width: 155 },
  ];

  const rows = r.rows.map((x) => [
    String(x.tx_date || ""),
    `${formatMoney(x.amount)} ${x.currency || "SAR"}`,
    x.category || "",
    x.vendor || "",
    x.description || "",
  ]);

  if (!rows.length) {
    doc.fontSize(12).text("No transactions found for this month.");
  } else {
    drawTable(doc, columns, rows);
  }

  doc
    .fontSize(9)
    .fillColor("#444444")
    .text(`Generated by ${COMPANY_NAME} • ${new Date().toISOString()}`, { align: "left" })
    .fillColor("#000000");

  return await collectPdfBuffer(doc);
}

// =====================
// ERROR LOGGING
// =====================
bot.catch((e) => console.error("BOT ERROR:", e));
process.on("unhandledRejection", (e) => console.error("UNHANDLED:", e));
process.on("uncaughtException", (e) => console.error("UNCAUGHT:", e));

console.log("BOOT: accounting-bot v5 (budgets + pdf)");

// =====================
// COMMANDS
// =====================
bot.command("start", (ctx) =>
  ctx.reply(
    "✅ شغال.\n" +
      "أرسل مصروف مثل: دفعت 40 ريال للغداء من مطعم...\n\n" +
      "تقارير:\n" +
      "/today\n" +
      "/month\n" +
      "/last 10\n" +
      "/sum Food\n\n" +
      "ميزانيات:\n" +
      "/setbudget Food 300\n" +
      "/budget\n\n" +
      "PDF:\n" +
      "/exportpdf today\n" +
      "/exportpdf month\n\n" +
      "تصحيح:\n" +
      "/del last\n\n" +
      "تشخيص:\n" +
      "/ping /env /version"
  )
);

bot.command("ping", (ctx) => ctx.reply("pong ✅"));
bot.command("version", (ctx) => ctx.reply("version: accounting-bot-v5"));

bot.command("env", (ctx) => {
  ctx.reply(
    `openai: ${openai ? "yes" : "no"}\n` +
      `model: ${OPENAI_MODEL}\n` +
      `db: ${DB_STATUS}\n` +
      (DB_ERROR ? `db_error: ${DB_ERROR.slice(0, 120)}` : "")
  );
});

// /today
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
    const lines = r.rows
      .map((x) => `- ${formatMoney(x.amount)} ${x.currency} | ${x.category} | ${x.vendor}`)
      .join("\n");

    return ctx.reply(`📅 اليوم ${d}\n${lines}\n\nالمجموع: ${formatMoney(total)} SAR`);
  } catch (e) {
    console.error("TODAY_FAIL:", e);
    return ctx.reply("⚠️ خطأ في تقرير اليوم. راجع Logs.");
  }
});

// /month
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
    console.error("MONTH_FAIL:", e);
    return ctx.reply("⚠️ حصل خطأ في تقرير الشهر. راجع Logs.");
  }
});

// /last 10
bot.command("last", async (ctx) => {
  try {
    if (!pool) return ctx.reply("DB غير جاهزة. شوف /env");
    const uid = ctx.from.id;

    const parts = (ctx.message?.text || "").trim().split(/\s+/);
    const n = Math.min(Math.max(Number(parts[1] || 10), 1), 50);

    const r = await pool.query(
      `select tx_date, amount::numeric as amount, currency, vendor, category
       from tx
       where tg_user_id=$1
       order by created_at desc
       limit $2`,
      [uid, n]
    );

    if (!r.rowCount) return ctx.reply("ما في عمليات مسجلة.");

    const lines = r.rows
      .map((x) => `- ${x.tx_date} | ${formatMoney(x.amount)} ${x.currency} | ${x.category} | ${x.vendor}`)
      .join("\n");

    return ctx.reply(`🧾 آخر ${n} عمليات:\n${lines}`);
  } catch (e) {
    console.error("LAST_FAIL:", e);
    return ctx.reply("⚠️ خطأ في /last. راجع Logs.");
  }
});

// /sum Food [YYYY-MM]
bot.command("sum", async (ctx) => {
  try {
    if (!pool) return ctx.reply("DB غير جاهزة. شوف /env");
    const uid = ctx.from.id;

    const parts = (ctx.message?.text || "").trim().split(/\s+/);
    const category = parts[1];
    const month = (parts[2] || thisMonthKey()).trim();

    if (!category) return ctx.reply("استخدم: /sum Food أو /sum Food 2026-01");
    if (!ensureMonthFormat(month)) return ctx.reply("صيغة الشهر غلط. استخدم YYYY-MM مثل 2026-01");

    const r = await pool.query(
      `select coalesce(sum(amount),0)::numeric as total
       from tx
       where tg_user_id=$1 and to_char(tx_date,'YYYY-MM')=$2 and category=$3`,
      [uid, month, category]
    );

    return ctx.reply(`📌 مجموع ${category} لشهر ${month}: ${formatMoney(r.rows[0].total)} SAR`);
  } catch (e) {
    console.error("SUM_FAIL:", e);
    return ctx.reply("⚠️ خطأ في /sum. راجع Logs.");
  }
});

// /setbudget Food 300 [YYYY-MM]
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

    await pool.query(
      `insert into budgets (tg_user_id, month, category, amount, currency)
       values ($1,$2,$3,$4,'SAR')
       on conflict (tg_user_id, month, category)
       do update set amount=excluded.amount, currency='SAR'`,
      [uid, month, category, amount]
    );

    return ctx.reply(`✅ تم ضبط ميزانية ${category} لشهر ${month}: ${formatMoney(amount)} SAR`);
  } catch (e) {
    console.error("SETBUDGET_FAIL:", e);
    return ctx.reply("⚠️ فشل ضبط الميزانية. راجع Logs.");
  }
});

// /budget
bot.command("budget", async (ctx) => {
  try {
    if (!pool) return ctx.reply("DB غير جاهزة. شوف /env");
    const uid = ctx.from.id;
    const month = thisMonthKey();

    const buds = await pool.query(
      `select category, amount::numeric as budget
       from budgets
       where tg_user_id=$1 and month=$2
       order by category asc`,
      [uid, month]
    );

    if (!buds.rowCount) {
      return ctx.reply(`ما في ميزانيات لشهر ${month}.\nاستخدم: /setbudget Food 300`);
    }

    const spent = await pool.query(
      `select category, coalesce(sum(amount),0)::numeric as total
       from tx
       where tg_user_id=$1 and to_char(tx_date,'YYYY-MM')=$2
       group by category`,
      [uid, month]
    );
    const spentMap = new Map(spent.rows.map((x) => [x.category, safeNum(x.total)]));

    const lines = buds.rows.map((b) => {
      const s = spentMap.get(b.category) || 0;
      const bud = safeNum(b.budget);
      const pct = bud > 0 ? Math.round((s / bud) * 100) : 0;
      return `- ${b.category}: ${formatMoney(s)} / ${formatMoney(bud)} SAR (${pct}%)`;
    });

    return ctx.reply(`📌 ميزانيات شهر ${month}\n${lines.join("\n")}`);
  } catch (e) {
    console.error("BUDGET_FAIL:", e);
    return ctx.reply("⚠️ فشل عرض الميزانيات. راجع Logs.");
  }
});

// /del last  (delete last tx)
bot.command("del", async (ctx) => {
  try {
    if (!pool) return ctx.reply("DB غير جاهزة. شوف /env");
    const uid = ctx.from.id;

    const parts = (ctx.message?.text || "").trim().split(/\s+/);
    if ((parts[1] || "").toLowerCase() !== "last") {
      return ctx.reply("استخدم: /del last");
    }

    const r = await pool.query(
      `delete from tx
       where id = (
         select id from tx
         where tg_user_id=$1
         order by created_at desc
         limit 1
       )
       returning tx_date, amount::numeric as amount, currency, vendor, category`,
      [uid]
    );

    if (!r.rowCount) return ctx.reply("ما في عمليات للحذف.");

    const x = r.rows[0];
    return ctx.reply(
      `🗑️ تم حذف آخر عملية:\n` +
        `${x.tx_date} | ${formatMoney(x.amount)} ${x.currency} | ${x.category} | ${x.vendor}`
    );
  } catch (e) {
    console.error("DEL_FAIL:", e);
    return ctx.reply("⚠️ فشل الحذف. راجع Logs.");
  }
});

// /exportpdf today | month [YYYY-MM]
bot.command("exportpdf", async (ctx) => {
  try {
    if (!pool) return ctx.reply("DB غير جاهزة. شوف /env");
    const uid = ctx.from.id;

    const parts = (ctx.message?.text || "").trim().split(/\s+/);
    const mode = (parts[1] || "").toLowerCase();

    if (!mode) return ctx.reply("استخدم: /exportpdf today أو /exportpdf month أو /exportpdf month 2026-01");

    if (mode === "today") {
      const buf = await buildTodayPdf(uid);
      return ctx.replyWithDocument({ source: buf, filename: `daily-report-${todayISO()}.pdf` });
    }

    if (mode === "month") {
      const m = (parts[2] || thisMonthKey()).trim();
      if (!ensureMonthFormat(m)) return ctx.reply("صيغة الشهر غلط. استخدم YYYY-MM مثل 2026-01");
      const buf = await buildMonthPdf(uid, m);
      return ctx.replyWithDocument({ source: buf, filename: `monthly-report-${m}.pdf` });
    }

    return ctx.reply("استخدم: /exportpdf today أو /exportpdf month");
  } catch (e) {
    console.error("EXPORTPDF_FAIL:", e);
    return ctx.reply("⚠️ فشل تصدير PDF. راجع Logs.");
  }
});

// =====================
// MAIN HANDLER (expense message)
// =====================
bot.on("text", async (ctx) => {
  const text = (ctx.message?.text || "").trim();
  if (!text || text.startsWith("/")) return;

  if (!openai) return ctx.reply("❌ OpenAI غير مفعّل. أضف OPENAI_API_KEY.");

  try {
    const tx = await extractExpense(text);

    await ctx.reply(
      `✅ تم استخراج المصروف:\n` +
        `💰 ${formatMoney(tx.amount)} ${tx.currency}\n` +
        `📅 ${tx.tx_date}\n` +
        `🏪 ${tx.vendor}\n` +
        `🏷️ ${tx.category}\n` +
        `📝 ${tx.description || "-"}`
    );

    const status = await saveTx(ctx.from.id, tx, text);

    if (status === "OK") {
      await ctx.reply("💾 تم الحفظ.");
      await checkBudgetAlerts(ctx, ctx.from.id, tx);
      return;
    }

    if (status === "NO_DB") return ctx.reply("ℹ️ DB غير مفعلة. أضف DATABASE_URL.");
    return ctx.reply("⚠️ فشل الحفظ في DB. شوف /env");
  } catch (e) {
    console.error("EXTRACT_FAIL:", e);
    return ctx.reply("❌ ما قدرت أفهم المصروف. مثال: غداء 40 ريال مطعم رائد البخخاري");
  }
});

// =====================
// LAUNCH
// =====================
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
