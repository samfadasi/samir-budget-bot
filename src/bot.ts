/**
 * Standalone Telegram Polling Bot
 * 
 * CHECKLIST:
 * 1) Set TELEGRAM_BOT_TOKEN in Secrets
 * 2) Run: npx tsx src/bot.ts
 * 3) Test /ping in Telegram
 * 4) Check console for diagnostics
 */

import { Telegraf } from 'telegraf';
import { message } from 'telegraf/filters';
import pg from 'pg';

interface HealthStatus {
  botRunning: boolean;
  dbConnected: boolean;
  openaiEnabled: boolean;
  lastError: string | null;
}

const health: HealthStatus = {
  botRunning: false,
  dbConnected: false,
  openaiEnabled: false,
  lastError: null,
};

let dbPool: pg.Pool | null = null;

console.log('🚀 [Bot] Starting Telegram bot...');
console.log('📋 [Bot] Environment check:');

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error('❌ [Bot] FATAL: TELEGRAM_BOT_TOKEN is not set!');
  console.error('👉 Set it in Replit Secrets and restart.');
  process.exit(1);
}
console.log('✅ [Bot] TELEGRAM_BOT_TOKEN is set');

const openaiKey = process.env.AI_INTEGRATIONS_OPENAI_API_KEY || process.env.OPENAI_API_KEY;
if (!openaiKey) {
  console.log('⚠️  [Bot] OpenAI disabled (no API key)');
  health.openaiEnabled = false;
} else {
  console.log('✅ [Bot] OpenAI API key found');
  health.openaiEnabled = true;
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.log('⚠️  [Bot] Database disabled (DATABASE_URL not set)');
  health.dbConnected = false;
} else {
  console.log('✅ [Bot] DATABASE_URL is set, attempting connection...');
  try {
    dbPool = new pg.Pool({ connectionString: databaseUrl, max: 3 });
    const client = await dbPool.connect();
    await client.query('SELECT 1');
    client.release();
    console.log('✅ [Bot] Database connected successfully');
    health.dbConnected = true;
  } catch (err) {
    const error = err as Error;
    console.error('⚠️  [Bot] Database connection failed:', error.message);
    console.log('👉 Bot will continue without database features');
    health.dbConnected = false;
    health.lastError = `DB: ${error.message}`;
  }
}

const bot = new Telegraf(token);

bot.catch((err, ctx) => {
  const error = err as Error;
  console.error('❌ [Bot] Error in handler:', error.message);
  health.lastError = error.message;
  ctx.reply('⚠️ حدث خطأ. حاول مرة أخرى.').catch(() => {});
});

process.on('unhandledRejection', (reason) => {
  console.error('❌ [Bot] Unhandled rejection:', reason);
  health.lastError = String(reason);
});

process.on('uncaughtException', (err) => {
  console.error('❌ [Bot] Uncaught exception:', err);
  health.lastError = err.message;
});

bot.command('ping', async (ctx) => {
  console.log('📩 [Bot] /ping received from', ctx.from?.username || ctx.from?.id);
  await ctx.reply('pong ✅');
});

bot.command('start', async (ctx) => {
  console.log('📩 [Bot] /start received from', ctx.from?.username || ctx.from?.id);
  await ctx.reply(
    '👋 مرحباً! أنا بوت المحاسبة الذكي.\n\n' +
    'الأوامر المتاحة:\n' +
    '/ping - اختبار الاتصال\n' +
    '/health - حالة النظام\n' +
    '/balance - الرصيد\n' +
    '/help - المساعدة'
  );
});

bot.command('health', async (ctx) => {
  console.log('📩 [Bot] /health received from', ctx.from?.username || ctx.from?.id);
  const status = [
    `🤖 Bot running: ${health.botRunning ? '✅ yes' : '❌ no'}`,
    `🗄️ DB connected: ${health.dbConnected ? '✅ yes' : '❌ no'}`,
    `🧠 OpenAI enabled: ${health.openaiEnabled ? '✅ yes' : '❌ no'}`,
    `⚠️ Last error: ${health.lastError || 'none'}`,
  ].join('\n');
  await ctx.reply(status);
});

bot.command('help', async (ctx) => {
  console.log('📩 [Bot] /help received from', ctx.from?.username || ctx.from?.id);
  await ctx.reply(
    '📚 المساعدة:\n\n' +
    '/ping - اختبار الاتصال\n' +
    '/health - حالة النظام\n' +
    '/balance - عرض الرصيد\n' +
    '/budget - إدارة الميزانيات\n' +
    '/report - تقرير المصروفات\n' +
    '/export - تصدير البيانات\n\n' +
    '💡 أرسل أي رسالة نصية أو صورة إيصال لتسجيل معاملة.'
  );
});

bot.command('balance', async (ctx) => {
  console.log('📩 [Bot] /balance received');
  if (!health.dbConnected || !dbPool) {
    await ctx.reply('⚠️ قاعدة البيانات غير متصلة. جرب /health للتفاصيل.');
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
      `💰 الرصيد الحالي:\n\n` +
      `📈 الدخل: ${parseFloat(income).toFixed(2)} ر.س\n` +
      `📉 المصروفات: ${parseFloat(expenses).toFixed(2)} ر.س\n` +
      `━━━━━━━━━━━━\n` +
      `💵 الرصيد: ${balance.toFixed(2)} ر.س`
    );
  } catch (err) {
    const error = err as Error;
    console.error('❌ [Bot] Balance query failed:', error.message);
    await ctx.reply('⚠️ خطأ في جلب الرصيد. جرب لاحقاً.');
  }
});

bot.on(message('text'), async (ctx) => {
  const text = ctx.message.text;
  if (text.startsWith('/')) return;
  
  console.log('📩 [Bot] Text message received:', text.substring(0, 50));
  await ctx.reply(`✅ تم استلام رسالتك: "${text.substring(0, 30)}..."\n\n⏳ جاري المعالجة...`);
});

bot.on(message('photo'), async (ctx) => {
  console.log('📩 [Bot] Photo received');
  await ctx.reply('📸 تم استلام الصورة!\n\n⏳ جاري تحليل الإيصال...');
});

bot.on(message('document'), async (ctx) => {
  console.log('📩 [Bot] Document received:', ctx.message.document.file_name);
  await ctx.reply('📄 تم استلام الملف!\n\n⏳ جاري المعالجة...');
});

bot.on(message('voice'), async (ctx) => {
  console.log('📩 [Bot] Voice message received');
  await ctx.reply('🎤 تم استلام الرسالة الصوتية!\n\n⏳ جاري النسخ والمعالجة...');
});

async function startBot() {
  try {
    console.log('🔄 [Bot] Launching bot with polling...');
    
    const me = await bot.telegram.getMe();
    console.log(`✅ [Bot] Connected as @${me.username} (${me.first_name})`);
    
    await bot.launch({
      dropPendingUpdates: true,
    });
    
    health.botRunning = true;
    console.log('🎉 [Bot] Bot started successfully (polling mode)');
    console.log('👉 Test it: send /ping to your bot');
    
  } catch (err) {
    const error = err as Error;
    console.error('❌ [Bot] Failed to start:', error.message);
    
    if (error.message.includes('401')) {
      console.error('👉 401 Unauthorized: Your bot token is invalid.');
      console.error('   Get a new token from @BotFather and update TELEGRAM_BOT_TOKEN');
    } else if (error.message.includes('409')) {
      console.error('👉 409 Conflict: Another instance is already polling.');
      console.error('   Stop other instances or wait a few minutes.');
    }
    
    health.lastError = error.message;
    process.exit(1);
  }
}

process.once('SIGINT', () => {
  console.log('🛑 [Bot] Received SIGINT, stopping...');
  bot.stop('SIGINT');
});

process.once('SIGTERM', () => {
  console.log('🛑 [Bot] Received SIGTERM, stopping...');
  bot.stop('SIGTERM');
});

startBot();
