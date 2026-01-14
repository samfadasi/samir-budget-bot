/**
 * Unified Telegram Bot Server
 * 
 * Runs HTTP server + Telegram bot in one process:
 * - Development: HTTP server + polling mode
 * - Production: HTTP server + webhook mode
 * 
 * Binds to 0.0.0.0:PORT (default 3000) to keep Replit deployment healthy.
 */

import { Telegraf } from 'telegraf';
import { message } from 'telegraf/filters';
import pg from 'pg';
import http from 'http';
import crypto from 'crypto';

const isProduction = process.env.NODE_ENV === 'production' || process.env.REPLIT_DEPLOYMENT === '1';
const PORT = parseInt(process.env.PORT || '3000', 10);

interface HealthStatus {
  botRunning: boolean;
  dbConnected: boolean;
  openaiEnabled: boolean;
  mode: 'polling' | 'webhook' | 'not_started';
  lastError: string | null;
  startedAt: Date | null;
}

const health: HealthStatus = {
  botRunning: false,
  dbConnected: false,
  openaiEnabled: false,
  mode: 'not_started',
  lastError: null,
  startedAt: null,
};

let dbPool: pg.Pool | null = null;

function log(level: 'info' | 'warn' | 'error', message: string, data?: unknown) {
  const prefix = level === 'error' ? '❌' : level === 'warn' ? '⚠️' : '✅';
  const timestamp = new Date().toISOString();
  console.log(`${prefix} [${timestamp}] [Bot] ${message}`, data || '');
}

log('info', `Starting in ${isProduction ? 'PRODUCTION' : 'DEVELOPMENT'} mode`);
log('info', `Server will bind to 0.0.0.0:${PORT}`);

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  log('error', 'FATAL: TELEGRAM_BOT_TOKEN is not set!');
  process.exit(1);
}
log('info', 'TELEGRAM_BOT_TOKEN is set');

const openaiKey = process.env.AI_INTEGRATIONS_OPENAI_API_KEY || process.env.OPENAI_API_KEY;
health.openaiEnabled = !!openaiKey;
log(openaiKey ? 'info' : 'warn', openaiKey ? 'OpenAI API key found' : 'OpenAI disabled (no API key)');

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl) {
  log('info', 'Connecting to database...');
  try {
    dbPool = new pg.Pool({ connectionString: databaseUrl, max: 3 });
    const client = await dbPool.connect();
    await client.query('SELECT 1');
    client.release();
    log('info', 'Database connected successfully');
    health.dbConnected = true;
  } catch (err) {
    const error = err as Error;
    log('warn', `Database connection failed: ${error.message}`);
    health.dbConnected = false;
    health.lastError = `DB: ${error.message}`;
  }
} else {
  log('warn', 'Database disabled (DATABASE_URL not set)');
}

const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.TELEGRAM_WEBHOOK_SECRET && isProduction) {
  log('warn', 'TELEGRAM_WEBHOOK_SECRET not set, generated random secret');
  log('info', `Add to secrets: TELEGRAM_WEBHOOK_SECRET=${webhookSecret}`);
}

const bot = new Telegraf(token);

bot.catch((err, ctx) => {
  const error = err as Error;
  log('error', `Error in handler: ${error.message}`);
  health.lastError = error.message;
  ctx.reply('⚠️ حدث خطأ. حاول مرة أخرى.').catch(() => {});
});

process.on('unhandledRejection', (reason) => {
  log('error', `Unhandled rejection: ${reason}`);
  health.lastError = String(reason);
});

process.on('uncaughtException', (err) => {
  log('error', `Uncaught exception: ${err.message}`);
  health.lastError = err.message;
});

bot.command('ping', async (ctx) => {
  log('info', `/ping from ${ctx.from?.username || ctx.from?.id}`);
  await ctx.reply('pong ✅');
});

bot.command('start', async (ctx) => {
  log('info', `/start from ${ctx.from?.username || ctx.from?.id}`);
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
  log('info', `/health from ${ctx.from?.username || ctx.from?.id}`);
  const uptime = health.startedAt ? Math.floor((Date.now() - health.startedAt.getTime()) / 1000) : 0;
  const status = [
    `🤖 Bot: ${health.botRunning ? '✅ running' : '❌ stopped'}`,
    `📡 Mode: ${health.mode}`,
    `🗄️ DB: ${health.dbConnected ? '✅ connected' : '❌ disconnected'}`,
    `🧠 OpenAI: ${health.openaiEnabled ? '✅ enabled' : '❌ disabled'}`,
    `⏱️ Uptime: ${uptime}s`,
    `⚠️ Last error: ${health.lastError || 'none'}`,
  ].join('\n');
  await ctx.reply(status);
});

bot.command('help', async (ctx) => {
  log('info', `/help from ${ctx.from?.username || ctx.from?.id}`);
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
  log('info', `/balance from ${ctx.from?.username || ctx.from?.id}`);
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
    log('error', `Balance query failed: ${error.message}`);
    await ctx.reply('⚠️ خطأ في جلب الرصيد. جرب لاحقاً.');
  }
});

bot.on(message('text'), async (ctx) => {
  const text = ctx.message.text;
  if (text.startsWith('/')) return;
  log('info', `Text message: ${text.substring(0, 50)}`);
  await ctx.reply(`✅ تم استلام رسالتك: "${text.substring(0, 30)}..."\n\n⏳ جاري المعالجة...`);
});

bot.on(message('photo'), async (ctx) => {
  log('info', 'Photo received');
  await ctx.reply('📸 تم استلام الصورة!\n\n⏳ جاري تحليل الإيصال...');
});

bot.on(message('document'), async (ctx) => {
  log('info', `Document received: ${ctx.message.document.file_name}`);
  await ctx.reply('📄 تم استلام الملف!\n\n⏳ جاري المعالجة...');
});

bot.on(message('voice'), async (ctx) => {
  log('info', 'Voice message received');
  await ctx.reply('🎤 تم استلام الرسالة الصوتية!\n\n⏳ جاري النسخ والمعالجة...');
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);
  
  if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      bot: health.botRunning,
      mode: health.mode,
      db: health.dbConnected,
      openai: health.openaiEnabled,
      uptime: health.startedAt ? Math.floor((Date.now() - health.startedAt.getTime()) / 1000) : 0,
      lastError: health.lastError,
    }));
    return;
  }
  
  if (req.method === 'GET' && url.pathname === '/ping') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('pong');
    return;
  }
  
  if (req.method === 'POST' && url.pathname === `/telegram/${webhookSecret}`) {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const update = JSON.parse(body);
        log('info', `Webhook update received: ${update.update_id}`);
        await bot.handleUpdate(update);
        res.writeHead(200);
        res.end('ok');
      } catch (err) {
        const error = err as Error;
        log('error', `Webhook error: ${error.message}`);
        res.writeHead(500);
        res.end('error');
      }
    });
    return;
  }
  
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

async function getPublicUrl(): Promise<string | null> {
  const replitUrl = process.env.REPLIT_DEV_DOMAIN;
  if (replitUrl) {
    return `https://${replitUrl}`;
  }
  
  const replitSlug = process.env.REPL_SLUG;
  const replitOwner = process.env.REPL_OWNER;
  if (replitSlug && replitOwner) {
    return `https://${replitSlug}.${replitOwner}.repl.co`;
  }
  
  return null;
}

async function startBot() {
  try {
    const me = await bot.telegram.getMe();
    log('info', `Connected as @${me.username} (${me.first_name})`);
    
    if (isProduction) {
      const publicUrl = await getPublicUrl();
      if (publicUrl) {
        const webhookUrl = `${publicUrl}/telegram/${webhookSecret}`;
        log('info', `Setting webhook: ${webhookUrl.replace(webhookSecret, '***')}`);
        await bot.telegram.setWebhook(webhookUrl);
        health.mode = 'webhook';
        log('info', 'Webhook mode activated');
        health.botRunning = true;
        health.startedAt = new Date();
      } else {
        log('warn', 'No public URL found, falling back to polling');
        await bot.telegram.deleteWebhook();
        health.mode = 'polling';
        health.botRunning = true;
        health.startedAt = new Date();
        bot.launch({ dropPendingUpdates: true }).catch((err) => {
          const error = err as Error;
          log('error', `Polling error: ${error.message}`);
          health.lastError = error.message;
          health.botRunning = false;
        });
      }
    } else {
      log('info', 'Development mode: deleting any existing webhook');
      await bot.telegram.deleteWebhook();
      log('info', 'Starting polling...');
      health.mode = 'polling';
      health.botRunning = true;
      health.startedAt = new Date();
      bot.launch({ dropPendingUpdates: true }).catch((err) => {
        const error = err as Error;
        log('error', `Polling error: ${error.message}`);
        health.lastError = error.message;
        health.botRunning = false;
      });
    }
    
    log('info', `Bot started in ${health.mode} mode`);
    
  } catch (err) {
    const error = err as Error;
    log('error', `Failed to start bot: ${error.message}`);
    health.lastError = error.message;
    
    if (error.message.includes('401')) {
      log('error', '401 Unauthorized: Bot token is invalid');
    } else if (error.message.includes('409')) {
      log('error', '409 Conflict: Another instance is polling');
    }
  }
}

server.listen(PORT, '0.0.0.0', () => {
  log('info', `HTTP server listening on 0.0.0.0:${PORT}`);
  log('info', `Health check: http://localhost:${PORT}/health`);
  startBot();
});

process.once('SIGINT', () => {
  log('info', 'Received SIGINT, shutting down...');
  bot.stop('SIGINT');
  server.close();
});

process.once('SIGTERM', () => {
  log('info', 'Received SIGTERM, shutting down...');
  bot.stop('SIGTERM');
  server.close();
});
