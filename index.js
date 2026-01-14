/**
 * Minimal Always-On Telegram Bot (ESM)
 * Polling only - NO webhooks
 * Guaranteed to respond to /ping under ALL circumstances
 */

import { Telegraf } from 'telegraf';
import pg from 'pg';

let LAST_ERROR = null;
let dbEnabled = false;
let openaiEnabled = false;
let dbPool = null;
let botStartedAt = null;

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error('❌ FATAL: TELEGRAM_BOT_TOKEN is not set! Exiting.');
  process.exit(1);
}
console.log('✅ TELEGRAM_BOT_TOKEN is present');

openaiEnabled = !!(process.env.AI_INTEGRATIONS_OPENAI_API_KEY || process.env.OPENAI_API_KEY);
console.log(`🧠 OpenAI: ${openaiEnabled ? 'enabled' : 'disabled'}`);

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl) {
  try {
    dbPool = new pg.Pool({ connectionString: databaseUrl, max: 3 });
    const client = await dbPool.connect();
    await client.query('SELECT 1');
    client.release();
    dbEnabled = true;
    console.log('✅ Database: connected');
  } catch (err) {
    console.warn(`⚠️ Database connection failed: ${err.message}`);
    dbEnabled = false;
    LAST_ERROR = `DB: ${err.message}`;
  }
} else {
  console.log('⚠️ Database: disabled (no DATABASE_URL)');
}

const bot = new Telegraf(token);

bot.catch((err, ctx) => {
  console.error(`❌ Bot handler error: ${err.stack || err.message}`);
  LAST_ERROR = err.message;
  ctx.reply('⚠️ حدث خطأ. حاول مرة أخرى.').catch(() => {});
});

process.on('unhandledRejection', (reason) => {
  console.error(`❌ Unhandled rejection: ${reason}`);
  LAST_ERROR = String(reason);
});

process.on('uncaughtException', (err) => {
  console.error(`❌ Uncaught exception: ${err.stack || err.message}`);
  LAST_ERROR = err.message;
});

bot.command('ping', async (ctx) => {
  console.log(`📩 /ping from ${ctx.from?.username || ctx.from?.id}`);
  await ctx.reply('pong ✅');
});

bot.command('start', async (ctx) => {
  console.log(`📩 /start from ${ctx.from?.username || ctx.from?.id}`);
  await ctx.reply('✅ bot online');
});

bot.command('health', async (ctx) => {
  console.log(`📩 /health from ${ctx.from?.username || ctx.from?.id}`);
  const uptime = botStartedAt ? Math.floor((Date.now() - botStartedAt) / 1000) : 0;
  const status = [
    `running: yes`,
    `token: present`,
    `db: ${dbEnabled ? 'enabled' : 'disabled'}`,
    `openai: ${openaiEnabled ? 'enabled' : 'disabled'}`,
    `uptime: ${uptime}s`,
    `last_error: ${LAST_ERROR || 'none'}`,
  ].join('\n');
  await ctx.reply(status);
});

bot.command('help', async (ctx) => {
  console.log(`📩 /help from ${ctx.from?.username || ctx.from?.id}`);
  await ctx.reply(
    '📚 الأوامر:\n' +
    '/ping - اختبار\n' +
    '/health - الحالة\n' +
    '/balance - الرصيد\n' +
    '/start - بدء'
  );
});

bot.command('balance', async (ctx) => {
  console.log(`📩 /balance from ${ctx.from?.username || ctx.from?.id}`);
  if (!dbEnabled || !dbPool) {
    await ctx.reply('⚠️ قاعدة البيانات غير متصلة.');
    return;
  }
  try {
    const result = await dbPool.query(`
      SELECT 
        COALESCE(SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END), 0) as income,
        COALESCE(SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END), 0) as expenses
      FROM transactions
    `);
    const { income, expenses } = result.rows[0];
    const balance = parseFloat(income) - parseFloat(expenses);
    await ctx.reply(
      `💰 الرصيد:\n` +
      `📈 دخل: ${parseFloat(income).toFixed(2)}\n` +
      `📉 مصروفات: ${parseFloat(expenses).toFixed(2)}\n` +
      `💵 الرصيد: ${balance.toFixed(2)}`
    );
  } catch (err) {
    console.error(`❌ Balance query failed: ${err.message}`);
    LAST_ERROR = err.message;
    await ctx.reply('⚠️ خطأ في جلب الرصيد.');
  }
});

bot.on('text', async (ctx) => {
  const text = ctx.message.text;
  if (text.startsWith('/')) return;
  console.log(`📩 Text: ${text.substring(0, 30)}`);
  await ctx.reply('received ✅');
});

bot.on('photo', async (ctx) => {
  console.log('📩 Photo received');
  await ctx.reply('📸 received ✅');
});

bot.on('document', async (ctx) => {
  console.log(`📩 Document: ${ctx.message.document.file_name}`);
  await ctx.reply('📄 received ✅');
});

bot.on('voice', async (ctx) => {
  console.log('📩 Voice received');
  await ctx.reply('🎤 received ✅');
});

setInterval(() => {
  console.log(`💓 HEARTBEAT: bot alive ${new Date().toISOString()}`);
}, 30000);

async function launchBot() {
  try {
    console.log('🔄 Deleting any existing webhook...');
    await bot.telegram.deleteWebhook({ drop_pending_updates: true });
    
    const me = await bot.telegram.getMe();
    console.log(`✅ Connected as @${me.username} (${me.first_name})`);
    
    console.log('🚀 Starting polling...');
    botStartedAt = Date.now();
    
    await bot.launch({ dropPendingUpdates: true });
    console.log('✅ BOT READY. Test in Telegram: /ping');
    
  } catch (err) {
    console.error(`❌ Launch error: ${err.message}`);
    LAST_ERROR = err.message;
    
    if (err.message.includes('401')) {
      console.error('❌ 401 Unauthorized: TELEGRAM_BOT_TOKEN is wrong. Stopping.');
      process.exit(1);
    }
    
    if (err.message.includes('409')) {
      console.error('⚠️ 409 Conflict: another instance is polling. Retrying in 15 seconds...');
      setTimeout(launchBot, 15000);
      return;
    }
    
    console.error('⚠️ Unknown error. Retrying in 15 seconds...');
    setTimeout(launchBot, 15000);
  }
}

process.once('SIGINT', () => {
  console.log('🛑 SIGINT received, stopping...');
  bot.stop('SIGINT');
});

process.once('SIGTERM', () => {
  console.log('🛑 SIGTERM received, stopping...');
  bot.stop('SIGTERM');
});

launchBot();
