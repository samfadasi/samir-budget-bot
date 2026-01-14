pool
  .query("select 1")
  .then(() => console.log("DB connected"))
  .catch(console.error);
import { Telegraf } from "telegraf";
import crypto from "crypto";
import pg from "pg";
import OpenAI from "openai";
import PDFDocument from "pdfkit";

const { Pool } = pg;

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL;

const ENABLE_PDF_REPORTS =
  (process.env.ENABLE_PDF_REPORTS || "true") === "true";
const ENABLE_SMART_ALERTS =
  (process.env.ENABLE_SMART_ALERTS || "true") === "true";

if (!TELEGRAM_BOT_TOKEN) throw new Error("Missing TELEGRAM_BOT_TOKEN");
if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");
if (!DATABASE_URL) throw new Error("Missing DATABASE_URL");

const bot = new Telegraf(TELEGRAM_BOT_TOKEN);
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

const CATS = [
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

function monthStart(d) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}
function nextMonthStart(d) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
}
function sha1(s) {
  return crypto.createHash("sha1").update(s, "utf8").digest("hex");
}

async function ensureUser(tgUser) {
  const { id: tg_user_id, username } = tgUser;
  const r = await pool.query("select id from users where tg_user_id=$1", [
    tg_user_id,
  ]);
  if (r.rowCount) return r.rows[0].id;
  const ins = await pool.query(
    "insert into users (tg_user_id, tg_username) values ($1,$2) returning id",
    [tg_user_id, username || null],
  );
  return ins.rows[0].id;
}

async function getOrCreateCategory(userId, name) {
  const n = (name || "Uncategorized").trim();
  let r = await pool.query(
    "select id from categories where user_id=$1 and name=$2",
    [userId, n],
  );
  if (r.rowCount) return r.rows[0].id;
  r = await pool.query(
    "insert into categories (user_id, name) values ($1,$2) returning id",
    [userId, n],
  );
  return r.rows[0].id;
}

async function getOrCreateVendor(userId, name) {
  const n = (name || "Unknown").trim();
  let r = await pool.query(
    "select id from vendors where user_id=$1 and name=$2",
    [userId, n],
  );
  if (r.rowCount) return r.rows[0].id;
  r = await pool.query(
    "insert into vendors (user_id, name) values ($1,$2) returning id",
    [userId, n],
  );
  return r.rows[0].id;
}

async function extractTxFromText(text) {
  const today = new Date().toISOString().slice(0, 10);
  const schemaHint = `Return ONLY JSON with keys: tx_date (YYYY-MM-DD), amount (number), currency (string, default SAR), vendor (string), category (one of ${CATS.join(", ")}), description (string), confidence (0..1).`;
  const input = `Today is ${today}. Extract ONE expense transaction from: ${text}\n${schemaHint}`;

  const resp = await openai.responses.create({
    model: "gpt-4o",
    instructions:
      "You are a strict accounting extraction engine. Output valid JSON only. No extra keys.",
    input,
  });

  const out = resp.output
    .filter((o) => o.type === "output_text")
    .map((o) => o.text)
    .join("");

  return JSON.parse(out);
}

async function insertTransaction(userId, tx, rawText) {
  const h = sha1(
    `${userId}|${tx.tx_date}|${Number(tx.amount).toFixed(2)}|${tx.currency}|${tx.vendor}|${tx.description}`.toLowerCase(),
  );
  const vendorId = await getOrCreateVendor(userId, tx.vendor);
  const categoryId = await getOrCreateCategory(userId, tx.category);

  try {
    await pool.query(
      `insert into transactions (user_id, vendor_id, category_id, tx_date, amount, currency, description, raw_text, hash)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        userId,
        vendorId,
        categoryId,
        tx.tx_date,
        tx.amount,
        tx.currency || "SAR",
        tx.description || "",
        rawText,
        h,
      ],
    );
    return { status: "OK", categoryId };
  } catch (e) {
    if (String(e?.code) === "23505") return { status: "DUPLICATE", categoryId };
    throw e;
  }
}

async function budgetCheckAndAlert(ctx, userId, categoryId, txDateStr) {
  const d = new Date(txDateStr + "T00:00:00Z");
  const m = monthStart(d);
  const nm = nextMonthStart(d);

  const b = await pool.query(
    `select amount from budgets where user_id=$1 and category_id=$2 and month=$3`,
    [userId, categoryId, m.toISOString().slice(0, 10)],
  );
  if (!b.rowCount) return;

  const budget = Number(b.rows[0].amount);
  const spentQ = await pool.query(
    `select coalesce(sum(amount),0) as spent
     from transactions
     where user_id=$1 and category_id=$2 and tx_date >= $3 and tx_date < $4`,
    [
      userId,
      categoryId,
      m.toISOString().slice(0, 10),
      nm.toISOString().slice(0, 10),
    ],
  );
  const spent = Number(spentQ.rows[0].spent);
  const pct = budget > 0 ? spent / budget : 0;

  // send alerts once per threshold
  if (pct >= 1.0) {
    const key = `${m.toISOString().slice(0, 7)}:${categoryId}:100`;
    const ok = await pool.query(
      `insert into alerts_log (user_id, alert_type, alert_key) values ($1,'BUDGET', $2) on conflict do nothing`,
      [userId, key],
    );
    if (ok.rowCount)
      await ctx.reply(
        `🚨 تجاوزت ميزانية الفئة. المصروف: ${spent.toFixed(2)} / ${budget.toFixed(2)} SAR`,
      );
  } else if (pct >= 0.8) {
    const key = `${m.toISOString().slice(0, 7)}:${categoryId}:80`;
    const ok = await pool.query(
      `insert into alerts_log (user_id, alert_type, alert_key) values ($1,'BUDGET', $2) on conflict do nothing`,
      [userId, key],
    );
    if (ok.rowCount)
      await ctx.reply(
        `⚠️ وصلت 80% من ميزانية الفئة. المصروف: ${spent.toFixed(2)} / ${budget.toFixed(2)} SAR`,
      );
  }
}

bot.start(async (ctx) => {
  await ensureUser(ctx.from);
  await ctx.reply(
    "جاهز. أرسل مصروف نصي. أوامر: /today /month /setbudget <Category> <Amount> /exportpdf",
  );
});

bot.command("setbudget", async (ctx) => {
  const userId = await ensureUser(ctx.from);
  const parts = (ctx.message.text || "").split(" ").filter(Boolean);
  if (parts.length < 3) return ctx.reply("الاستخدام: /setbudget Food 1200");

  const cat = parts[1];
  const amt = Number(parts[2]);
  if (!Number.isFinite(amt) || amt <= 0) return ctx.reply("Amount غير صحيح.");

  const catId = await getOrCreateCategory(userId, cat);
  const m = monthStart(new Date());
  await pool.query(
    `insert into budgets (user_id, category_id, month, amount, currency)
     values ($1,$2,$3,$4,'SAR')
     on conflict (user_id, category_id, month) do update set amount=excluded.amount`,
    [userId, catId, m.toISOString().slice(0, 10), amt],
  );

  await ctx.reply(
    `✅ تم ضبط ميزانية ${cat} لشهر ${m.toISOString().slice(0, 7)} = ${amt.toFixed(2)} SAR`,
  );
});

bot.command("today", async (ctx) => {
  const userId = await ensureUser(ctx.from);
  const d = new Date().toISOString().slice(0, 10);
  const r = await pool.query(
    `select coalesce(sum(amount),0) as total from transactions where user_id=$1 and tx_date=$2`,
    [userId, d],
  );
  await ctx.reply(
    `مصروفات اليوم (${d}): ${Number(r.rows[0].total).toFixed(2)} SAR`,
  );
});

bot.command("month", async (ctx) => {
  const userId = await ensureUser(ctx.from);
  const now = new Date();
  const m = monthStart(now);
  const nm = nextMonthStart(now);
  const r = await pool.query(
    `select coalesce(sum(amount),0) as total from transactions where user_id=$1 and tx_date >= $2 and tx_date < $3`,
    [userId, m.toISOString().slice(0, 10), nm.toISOString().slice(0, 10)],
  );
  await ctx.reply(
    `مصروفات الشهر (${m.toISOString().slice(0, 7)}): ${Number(r.rows[0].total).toFixed(2)} SAR`,
  );
});

bot.command("exportpdf", async (ctx) => {
  if (!ENABLE_PDF_REPORTS) return ctx.reply("PDF reports disabled.");
  const userId = await ensureUser(ctx.from);

  const now = new Date();
  const m = monthStart(now);
  const nm = nextMonthStart(now);

  const txs = await pool.query(
    `select tx_date, amount, currency, description from transactions
     where user_id=$1 and tx_date >= $2 and tx_date < $3
     order by tx_date asc`,
    [userId, m.toISOString().slice(0, 10), nm.toISOString().slice(0, 10)],
  );

  const doc = new PDFDocument({ size: "A4", margin: 40 });
  const chunks = [];
  doc.on("data", (c) => chunks.push(c));
  const done = new Promise((res) => doc.on("end", res));

  doc.fontSize(16).text(`Monthly Report ${m.toISOString().slice(0, 7)}`);
  doc.moveDown();
  doc.fontSize(10);

  let total = 0;
  for (const t of txs.rows) {
    total += Number(t.amount);
    doc.text(
      `${t.tx_date}  |  ${Number(t.amount).toFixed(2)} ${t.currency}  |  ${t.description || ""}`,
    );
  }
  doc.moveDown();
  doc.fontSize(12).text(`Total: ${total.toFixed(2)} SAR`);
  doc.end();

  await done;
  const pdf = Buffer.concat(chunks);

  await ctx.replyWithDocument({
    source: pdf,
    filename: `report-${m.toISOString().slice(0, 7)}.pdf`,
  });
});

bot.on("text", async (ctx) => {
  const userId = await ensureUser(ctx.from);
  const raw = ctx.message.text.trim();

  let tx;
  try {
    tx = await extractTxFromText(raw);
  } catch (e) {
    console.error(e);
    return ctx.reply(
      "ما قدرت أفهم المصروف. اكتبها مثلاً: Paid 45 SAR for lunch",
    );
  }

  // sanitize category
  if (!CATS.includes(tx.category)) tx.category = "Uncategorized";
  if (!tx.currency) tx.currency = "SAR";
  if (!tx.tx_date) tx.tx_date = new Date().toISOString().slice(0, 10);

  const ins = await insertTransaction(userId, tx, raw);
  if (ins.status === "DUPLICATE") return ctx.reply("دي مكررة. ما سجلتها.");

  await ctx.reply(
    `✅ سجلت: ${Number(tx.amount).toFixed(2)} ${tx.currency}\n🏷️ ${tx.category}\n🏪 ${tx.vendor}\n📅 ${tx.tx_date}\n📝 ${tx.description || "-"}`,
  );

  // budget alerts
  await budgetCheckAndAlert(ctx, userId, ins.categoryId, tx.tx_date);
});

bot
  .launch()
  .then(() => console.log("Bot started (polling)"))
  .catch((e) => console.error("Bot launch failed:", e));

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
