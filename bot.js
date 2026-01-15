import { Telegraf } from "telegraf";
import OpenAI from "openai";
import pg from "pg";
import crypto from "crypto";

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

const bot = new Telegraf(TELEGRAM_BOT_TOKEN);
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

// DB is optional (but needed for storage/reports)
const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: { rejectUnauthorized: false }
    })
  : null;

console.log("BOOT: accounting-bot v2 (ai + db + budgets)");

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
// CONSTANTS
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

function sha1(s) {
  return crypto.createHash("sha1").update(s, "utf8").digest("hex");
}

// =====================
// DB SCHEMA
// =====================
async function ensureSchema() {
  if (!pool) return;
  await pool.query(`
    create table if not exists users (
      id bigserial primary key,
      tg_user_id bigint unique not null,
      tg_username text,
      base_currency text not null default 'SAR',
      created_at timestamptz not null default now()
    );

    create table if not exists transactions (
      id bigserial primary key,
      user_id bigint not null references users(id) on delete cascade,
      tx_date date not null,
      amount numeric(12,2) not null,
      currency text not null default 'SAR',
      vendor text,
      category text,
      description text,
      raw_text text,
      hash text,
      created_at timestamptz not null default now()
    );

    create unique index if not exists ux_transactions_user_hash
      on transactions(user_id, hash) where hash is not null;

    create table if not exists budgets (
      id bigserial primary key,
      user_id bigint not null references users(id) on delete cascade,
      month text not null, -- YYYY-MM
      category text not null,
      amount numeric(12,2) not null,
      currency text not null default 'SAR',
      created_at timestamptz not null default now(),
      unique(user_id, month, category)
    );
  `);
}

async function ensureUser(ctxFrom) {
  if (!pool) return null;
  const tg_user_id = ctxFrom.id;
  const tg_username = ctxFrom.username || null;

  const r = await pool.query("select id from users where tg_user_id=$1", [tg_user_id]);
  if (r.rowCount) return r.rows[0].id;

  const ins = await pool.query(
    "insert into users (tg_user_id, tg_username) values ($1,$2) returning id",
    [tg_user_id, tg_username]
  );
  return ins.rows[0].id;
}

async function saveTransaction(userId, tx, rawText) {
  if (!pool) return { status: "NO_DB" };

  const h = sha1(
    `${userId}|${tx.tx_date}|${Number(tx.amount).toFixed(2)}|${tx.currency}|${tx.vendor}|${tx.category}|${tx.description}`.toLowerCase()
  );

  try {
    await pool.query(
      `insert into transactions (user_id, tx_date, amount, currency, vendor, category, description, raw_text, hash)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [userId, tx.tx_date, tx.amount, tx.currency, tx.vendor, tx.category, tx.description, rawText, h]
    );
    return { status: "OK" };
  } catch (e) {
    if (String(e?.code) === "23505") return { status: "DUPLICATE" };
    throw e;
  }
}

// =====================
// AI EXTRACTION (STRICT JSON)
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
          "Extract ONE expense transaction from Arabic/English text. Return ONLY valid JSON with keys: tx_date, amount, currency, vendor, category, description. Category must be one of: " +
          CATEGORIES.join(", ") +
          "."
      },
      {
        role: "user",
        content:
          `Today is ${today}.\n` +
          `Text: "${text}"\n` +
          `Rules:\n` +
          `- "ريال" means SAR.\n` +
          `- If meal/coffee/restaurant (غداء/عشاء/فطور/مطعم/قهوة) => category Food.\n` +
          `- If date missing => today.\n` +
          `Return JSON only.`
      }
    ],
    response_format: { type: "json_object" },
    temperature: 0
  });

  const out = res.choices?.[0]?.message?.content?.trim() || "";
  const obj = JSON.parse(out);

  const amount = Number(obj.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("Invalid amount from AI");

  const tx_date = String(obj.tx_date || today).slice(0, 10);

  let currency = String(obj.currency || "SAR").trim().toUpperCase();
  if (/(ريال|ر\.?س)/i.test(text) || currency === "ريال" || currency === "SR") currency = "SAR";

  const vendor = String(obj.vendor || "Unknown").trim() || "Unknown";

  const category = CATEGORIES.includes(obj.category) ? obj.category : "Uncategorized";
  const description = String(obj.description || "").trim();

  return { tx_date, amount, currency, vendor, category, description };
}

// =====================
// BUDGET HELPERS
// =====================
function monthKey(isoDate) {
  // YYYY-MM from YYYY-MM-DD
  return String(isoDate).slice(0, 7);
}

async function setBudget(userId, month, category, amount, currency = "SAR") {
  if (!pool) return { status: "NO_DB" };
  await pool.query(
    `insert into budgets (user_id, month, category, amount, currency)
     values ($1,$2,$3,$4,$5)
     on conflict (user_id, month, category)
     do update set amount=excluded.amount, currency=excluded.currency`,
    [userId, month, category, amount, currency]
  );
  return { status: "OK" };
}

async function getMonthSpend(userId, month) {
  if (!pool) return null;
  const r = await pool.query(
    `select category, coalesce(sum(amount),0)::numeric as total
     from transactions
     where user_id=$1 and to_char(tx_date,'YYYY-MM')=$2
     group by category
     order by total desc`,
    [userId, month]
  );
  return r.rows;
}

async function getBudgets(userId, month) {
  if (!pool) return null;
  const r = await pool.query(
    `select category, amount::numeric as budget, currency
     from budgets
     where user_id=$1 and month=$2
     order by category asc`,
    [userId, month]
  );
  return r.rows;
}

async function checkBudgetAlerts(ctx, userId, tx) {
  if (!pool) return;
  const month = monthKey(tx.tx_date);

  const b = await pool.query(
    `select amount::numeric as budget, currency
     from budgets
     where user_id=$1 and month=$2 and category=$3`,
    [userId, month, tx.category]
  );
  if (!b.rowCount) return;

  const budget = Number(b.rows[0].budget);
  if (!Number.isFinite(budget) || budget <= 0) return;

  const spentR = await pool.query(
    `select coalesce(sum(amount),0)::numeric as spent
     from transactions
     where user_id=$1 and to_char(tx_date,'YYYY-MM')=$2 and category=$3`,
    [userId, month, tx.category]
  );
  const spent = Number(spentR.rows[0].spent || 0);
  const pct = (spent / budget) * 100;

  if (pct >= 100) {
    await ctx.reply(`🚨 تجاوزت الميزانية لفئة ${tx.category} هذا الشهر. (${spent.toFixed(2)} / ${budget.toFixed(2)} SAR)`);
  } else if (pct >= 80) {
    await ctx.reply(`⚠️ وصلت 80% من ميزانية ${tx.category}. (${spent.toFixed(2)} / ${budget.toFixed(2)} SAR)`);
  }
}

// =====================
// COMMANDS
// =====================
bot.command("start", (ctx) => {
  ctx.reply(
    "✅ شغال.\n" +
      "أرسل مصروف مثل: دفعت 40 ريال للغداء من مطعم...\n\n" +
      "تقارير:\n" +
      "/today\n" +
      "/month\n" +
      "/last 10\n" +
      "/budget\n" +
      "إعداد ميزانية:\n" +
      "/setbudget Food 300\n\n" +
      "تشخيص:\n" +
      "/ping /version /env"
  );
});

bot.command("ping", (ctx) => ctx.reply("pong ✅"));
bot.command("version", (ctx) => ctx.reply("version: accounting-bot-v2"));

bot.command("env", (ctx) => {
  ctx.reply(
    `openai: ${openai ? "yes" : "no"}\n` +
      `model: ${OPENAI_MODEL}\n` +
      `db: ${pool ? "enabled" : "disabled"}\n` +
      `last_error: ${LAST_ERROR ? "yes" : "no"}`
  );
});

bot.command("today", async (ctx) => {
  if (!pool) return ctx.reply("DB غير مفعلة. أضف DATABASE_URL.");
  const userId = await ensureUser(ctx.from);
  const d = todayISO();
  const r = await pool.query(
    `select tx_date, amount::numeric as amount, currency, vendor, category, description
     from transactions
     where user_id=$1 and tx_date=$2
     order by created_at desc`,
    [userId, d]
  );

  if (!r.rowCount) return ctx.reply("اليوم ما في مصروفات مسجلة.");

  const total = r.rows.reduce((s, x) => s + Number(x.amount), 0);
  const lines = r.rows
    .slice(0, 15)
    .map((x) => `- ${Number(x.amount).toFixed(2)} ${x.currency} | ${x.category} | ${x.vendor}`)
    .join("\n");

  return ctx.reply(`📅 مصروفات اليوم (${d})\n${lines}\n\nالمجموع: ${total.toFixed(2)} SAR`);
});

bot.command("month", async (ctx) => {
  if (!pool) return ctx.reply("DB غير مفعلة. أضف DATABASE_URL.");
  const userId = await ensureUser(ctx.from);
  const m = monthKey(todayISO());
  const rows = await getMonthSpend(userId, m);
  if (!rows || !rows.length) return ctx.reply("هذا الشهر ما في مصروفات مسجلة.");

  const total = rows.reduce((s, x) => s + Number(x.total), 0);
  const lines = rows.map((x) => `- ${x.category}: ${Number(x.total).toFixed(2)} SAR`).join("\n");
  return ctx.reply(`📊 ملخص شهر ${m}\n${lines}\n\nالمجموع: ${total.toFixed(2)} SAR`);
});

bot.command("last", async (ctx) => {
  if (!pool) return ctx.reply("DB غير مفعلة. أضف DATABASE_URL.");
  const userId = await ensureUser(ctx.from);

  const parts = (ctx.message?.text || "").trim().split(/\s+/);
  const n = Math.min(Math.max(Number(parts[1] || 10), 1), 50);

  const r = await pool.query(
    `select tx_date, amount::numeric as amount, currency, vendor, category
     from transactions
     where user_id=$1
     order by created_at desc
     limit $2`,
    [userId, n]
  );

  if (!r.rowCount) return ctx.reply("ما في عمليات مسجلة.");

  const lines = r.rows
    .map((x) => `- ${x.tx_date} | ${Number(x.amount).toFixed(2)} ${x.currency} | ${x.category} | ${x.vendor}`)
    .join("\n");

  return ctx.reply(`🧾 آخر ${n} عمليات:\n${lines}`);
});

bot.command("setbudget", async (ctx) => {
  if (!pool) return ctx.reply("DB غير مفعلة. أضف DATABASE_URL.");
  const userId = await ensureUser(ctx.from);

  // /setbudget Food 300 [YYYY-MM]
  const parts = (ctx.message?.text || "").trim().split(/\s+/);
  const category = parts[1];
  const amount = Number(parts[2]);
  const m = parts[3] || monthKey(todayISO());

  if (!CATEGORIES.includes(category)) {
    return ctx.reply(`❌ فئة غير صحيحة. استخدم واحدة من:\n${CATEGORIES.join(", ")}`);
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    return ctx.reply("❌ المبلغ لازم يكون رقم موجب. مثال: /setbudget Food 300");
  }

  await setBudget(userId, m, category, amount, "SAR");
  return ctx.reply(`✅ تم ضبط ميزانية ${category} لشهر ${m}: ${amount.toFixed(2)} SAR`);
});

bot.command("budget", async (ctx) => {
  if (!pool) return ctx.reply("DB غير مفعلة. أضف DATABASE_URL.");
  const userId = await ensureUser(ctx.from);

  const m = monthKey(todayISO());
  const spend = await getMonthSpend(userId, m);
  const buds = await getBudgets(userId, m);

  if (!buds || !buds.length) return ctx.reply(`ما في ميزانيات مضبوطة لشهر ${m}. استخدم /setbudget`);

  const spendMap = new Map((spend || []).map((x) => [x.category, Number(x.total)]));
  const lines = buds.map((b) => {
    const s = spendMap.get(b.category) || 0;
    const pct = b.budget > 0 ? Math.round((s / Number(b.budget)) * 100) : 0;
    return `- ${b.category}: ${s.toFixed(2)} / ${Number(b.budget).toFixed(2)} SAR (${pct}%)`;
  }).join("\n");

  return ctx.reply(`📌 ميزانيات شهر ${m}\n${lines}`);
});

// =====================
// MAIN HANDLER
// =====================
bot.on("text", async (ctx) => {
  const text = (ctx.message?.text || "").trim();
  if (!text || text.startsWith("/")) return;

  if (!openai) {
    return ctx.reply("❌ OpenAI غير مفعّل. أضف OPENAI_API_KEY.");
  }

  try {
    const tx = await aiExtract(text);

    // Reply extraction
    await ctx.reply(
      `✅ تم استخراج المصروف:\n` +
        `💰 ${tx.amount.toFixed(2)} ${tx.currency}\n` +
        `📅 ${tx.tx_date}\n` +
        `🏪 ${tx.vendor}\n` +
        `🏷️ ${tx.category}\n` +
        `📝 ${tx.description || "-"}`
    );

    // Save to DB if enabled
    if (pool) {
      const userId = await ensureUser(ctx.from);
      const saved = await saveTransaction(userId, tx, text);

      if (saved.status === "OK") {
        await ctx.reply("💾 تم الحفظ.");
        await checkBudgetAlerts(ctx, userId, tx);
      } else if (saved.status === "DUPLICATE") {
        await ctx.reply("ℹ️ يبدو مكرر. ما تم حفظه.");
      }
    } else {
      await ctx.reply("ℹ️ DB غير مفعلة. ما تم حفظه.");
    }
  } catch (e) {
    logErr(e, "EXTRACT_FAIL");
    await ctx.reply(
      "❌ ما قدرت أفهم المصروف.\n" +
        "اكتبها أوضح:\n" +
        "مثال: غداء 40 ريال مطعم رائد البخاري"
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

    await bot.telegram.deleteWebhook({ drop_pending_updates: true });

    if (pool) await ensureSchema();

    await bot.launch();
    console.log("BOT READY. Test: /ping");
  } catch (e) {
    logErr(e, "LAUNCH_FAILED");
    process.exit(1);
  }
})();

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
