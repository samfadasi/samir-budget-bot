import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import pg from "pg";
import { sendTelegramMessage } from "../../triggers/telegramTriggers";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const openai = createOpenAI({
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
});

const isSmartAlertsEnabled = () => process.env.ENABLE_SMART_ALERTS === "true";

const CategoryEnum = z.enum([
  "Food",
  "Transport",
  "Utilities",
  "Rent",
  "Business",
  "Personal",
  "Equipment",
  "Raw materials",
  "Uncategorized",
]);

export const checkBudgetAndAlertTool = createTool({
  id: "check-budget-and-alert",
  description:
    "Checks if the user's spending has crossed budget thresholds (80% or 100%) after a transaction and sends alerts. This should be called after saving a transaction.",
  inputSchema: z.object({
    userId: z.number().describe("Internal user ID"),
    telegramChatId: z.number().describe("Telegram chat ID for sending alerts"),
    category: CategoryEnum.describe("Category of the transaction just saved"),
    transactionAmount: z.number().describe("Amount of the transaction just saved"),
  }),
  outputSchema: z.object({
    alertsSent: z.array(
      z.object({
        category: z.string(),
        threshold: z.number(),
        message: z.string(),
      })
    ),
    budgetStatus: z.array(
      z.object({
        category: z.string(),
        spent: z.number(),
        limit: z.number(),
        percentUsed: z.number(),
      })
    ),
  }),
  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info("🔔 [checkBudgetAndAlert] Checking budget thresholds", {
      userId: context.userId,
      category: context.category,
    });

    const client = await pool.connect();
    const alertsSent: Array<{ category: string; threshold: number; message: string }> = [];
    const budgetStatus: Array<{ category: string; spent: number; limit: number; percentUsed: number }> = [];

    try {
      const yearMonth = new Date().toISOString().substring(0, 7);
      const [year, month] = yearMonth.split("-");
      const startDate = `${yearMonth}-01`;
      const endDate = new Date(parseInt(year), parseInt(month), 0).toISOString().split("T")[0];

      const budgetsResult = await client.query(
        `SELECT id, category, monthly_limit::float as limit 
         FROM budgets 
         WHERE user_id = $1 AND year_month = $2`,
        [context.userId, yearMonth]
      );

      for (const budget of budgetsResult.rows) {
        const spentResult = await client.query(
          `SELECT COALESCE(SUM(amount), 0)::float as spent 
           FROM transactions 
           WHERE user_id = $1 AND category = $2 AND date >= $3 AND date <= $4`,
          [context.userId, budget.category, startDate, endDate]
        );

        const spent = spentResult.rows[0].spent;
        const limit = budget.limit;
        const percentUsed = limit > 0 ? Math.round((spent / limit) * 100) : 0;

        budgetStatus.push({
          category: budget.category,
          spent,
          limit,
          percentUsed,
        });

        const thresholdsToCheck = [
          { threshold: 100, message: `🚨 <b>Budget Exceeded!</b>\n\nYou've spent ${spent.toFixed(2)} SAR on <b>${budget.category}</b>, which is ${percentUsed}% of your ${limit.toFixed(2)} SAR budget.\n\nConsider reviewing your spending in this category.` },
          { threshold: 80, message: `⚠️ <b>Budget Warning</b>\n\nYou've reached ${percentUsed}% of your <b>${budget.category}</b> budget.\n\nSpent: ${spent.toFixed(2)} SAR\nLimit: ${limit.toFixed(2)} SAR\nRemaining: ${Math.max(0, limit - spent).toFixed(2)} SAR` },
        ];

        for (const check of thresholdsToCheck) {
          if (percentUsed >= check.threshold) {
            const existingAlert = await client.query(
              `SELECT id FROM alerts_log 
               WHERE user_id = $1 AND category = $2 AND year_month = $3 AND threshold_percent = $4`,
              [context.userId, budget.category, yearMonth, check.threshold]
            );

            if (existingAlert.rows.length === 0) {
              logger?.info("🔔 [checkBudgetAndAlert] Sending threshold alert", {
                category: budget.category,
                threshold: check.threshold,
                percentUsed,
              });

              await client.query(
                `INSERT INTO alerts_log 
                 (user_id, alert_type, category, budget_id, year_month, threshold_percent, 
                  amount_spent, budget_limit, message, telegram_sent)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
                [
                  context.userId,
                  `BUDGET_${check.threshold}`,
                  budget.category,
                  budget.id,
                  yearMonth,
                  check.threshold,
                  spent,
                  limit,
                  check.message,
                  true,
                ]
              );

              const sent = await sendTelegramMessage(context.telegramChatId, check.message, "HTML");
              
              if (sent) {
                alertsSent.push({
                  category: budget.category,
                  threshold: check.threshold,
                  message: check.message,
                });
                logger?.info("✅ [checkBudgetAndAlert] Alert sent to Telegram");
              }

              break;
            }
          }
        }
      }

      logger?.info("✅ [checkBudgetAndAlert] Budget check complete", {
        alertsSent: alertsSent.length,
        budgetsChecked: budgetStatus.length,
      });

      return { alertsSent, budgetStatus };
    } finally {
      client.release();
    }
  },
});

export const sendSmartAlertTool = createTool({
  id: "send-smart-alert",
  description:
    "Sends an AI-powered smart alert when an anomaly is detected in spending. Uses AI to generate an actionable explanation. Only works when ENABLE_SMART_ALERTS is true.",
  inputSchema: z.object({
    userId: z.number().describe("Internal user ID"),
    telegramChatId: z.number().describe("Telegram chat ID for sending alerts"),
    transactionId: z.number().describe("ID of the suspicious transaction"),
    category: CategoryEnum.describe("Category of the transaction"),
    amount: z.number().describe("Transaction amount"),
    description: z.string().describe("Transaction description"),
    vendorName: z.string().optional().describe("Vendor name if available"),
    averageSpending: z.number().describe("Historical average spending in this category"),
    deviation: z.number().describe("Standard deviation from normal"),
    reason: z.string().describe("Initial reason for flagging as suspicious"),
  }),
  outputSchema: z.object({
    alertSent: z.boolean(),
    alertMessage: z.string().optional(),
    aiExplanation: z.string().optional(),
    skipped: z.boolean(),
    skipReason: z.string().optional(),
  }),
  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    
    if (!isSmartAlertsEnabled()) {
      logger?.info("⏭️ [sendSmartAlert] Smart alerts disabled, skipping");
      return {
        alertSent: false,
        skipped: true,
        skipReason: "Smart alerts are disabled (ENABLE_SMART_ALERTS=false)",
      };
    }

    logger?.info("🧠 [sendSmartAlert] Generating smart alert", {
      transactionId: context.transactionId,
      amount: context.amount,
      category: context.category,
    });

    const client = await pool.connect();

    try {
      const existingAlert = await client.query(
        `SELECT id FROM alerts_log 
         WHERE user_id = $1 AND transaction_id = $2 AND alert_type = 'ANOMALY'`,
        [context.userId, context.transactionId]
      );

      if (existingAlert.rows.length > 0) {
        logger?.info("⏭️ [sendSmartAlert] Alert already sent for this transaction");
        return {
          alertSent: false,
          skipped: true,
          skipReason: "Alert already sent for this transaction",
        };
      }

      const prompt = `You are a financial advisor analyzing a potentially unusual expense. Generate a short, friendly, and actionable alert message.

Transaction Details:
- Amount: ${context.amount} SAR
- Category: ${context.category}
- Description: ${context.description}
${context.vendorName ? `- Vendor: ${context.vendorName}` : ""}

Historical Context:
- Average spending in ${context.category}: ${context.averageSpending.toFixed(2)} SAR
- This transaction is ${context.deviation.toFixed(1)}x the average
- Initial flag reason: ${context.reason}

Generate a 2-3 sentence alert that:
1. Clearly states the unusual spending detected
2. Provides brief context (comparison to normal)
3. Suggests a simple action (verify, review, or ignore if expected)

Be concise and helpful, not alarming. Use simple language.`;

      const result = await generateText({
        model: openai("gpt-4o-mini"),
        prompt,
      });

      const aiExplanation = result.text.trim();
      const alertMessage = `🔍 <b>Smart Spending Alert</b>\n\n${aiExplanation}\n\n📊 Details:\n• Amount: ${context.amount} SAR\n• Category: ${context.category}\n• Avg for this category: ${context.averageSpending.toFixed(2)} SAR`;

      await client.query(
        `INSERT INTO alerts_log 
         (user_id, alert_type, category, transaction_id, amount_spent, message, telegram_sent)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          context.userId,
          "ANOMALY",
          context.category,
          context.transactionId,
          context.amount,
          alertMessage,
          true,
        ]
      );

      const sent = await sendTelegramMessage(context.telegramChatId, alertMessage, "HTML");

      logger?.info("✅ [sendSmartAlert] Smart alert sent", {
        sent,
        messageLength: alertMessage.length,
      });

      return {
        alertSent: sent,
        alertMessage,
        aiExplanation,
        skipped: false,
      };
    } finally {
      client.release();
    }
  },
});

export const getRecentAlertsTool = createTool({
  id: "get-recent-alerts",
  description:
    "Retrieves recent alerts for a user. Use this to show the user their alert history.",
  inputSchema: z.object({
    userId: z.number().describe("Internal user ID"),
    limit: z.number().default(10).describe("Maximum number of alerts to retrieve"),
    alertType: z.enum(["BUDGET_80", "BUDGET_100", "ANOMALY", "all"]).default("all"),
  }),
  outputSchema: z.object({
    alerts: z.array(
      z.object({
        id: z.number(),
        alertType: z.string(),
        category: z.string().nullable(),
        message: z.string(),
        createdAt: z.string(),
      })
    ),
    count: z.number(),
  }),
  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info("📋 [getRecentAlerts] Fetching alerts", {
      userId: context.userId,
      alertType: context.alertType,
    });

    const client = await pool.connect();

    try {
      let query = `
        SELECT id, alert_type, category, message, created_at::text
        FROM alerts_log
        WHERE user_id = $1
      `;
      const params: any[] = [context.userId];

      if (context.alertType !== "all") {
        query += " AND alert_type = $2";
        params.push(context.alertType);
      }

      query += ` ORDER BY created_at DESC LIMIT $${params.length + 1}`;
      params.push(context.limit);

      const result = await client.query(query, params);

      const alerts = result.rows.map((row) => ({
        id: row.id,
        alertType: row.alert_type,
        category: row.category,
        message: row.message,
        createdAt: row.created_at,
      }));

      logger?.info("✅ [getRecentAlerts] Alerts retrieved", { count: alerts.length });

      return { alerts, count: alerts.length };
    } finally {
      client.release();
    }
  },
});
