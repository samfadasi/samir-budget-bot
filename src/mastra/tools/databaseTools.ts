import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import pg from "pg";

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

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

export const getOrCreateUserTool = createTool({
  id: "get-or-create-user",
  description:
    "Gets an existing user by Telegram ID or creates a new user if they don't exist. Use this to ensure the user is registered before processing transactions.",
  inputSchema: z.object({
    telegramUserId: z.number().describe("The Telegram user ID"),
    username: z.string().optional().describe("Telegram username"),
    firstName: z.string().optional().describe("User's first name"),
    lastName: z.string().optional().describe("User's last name"),
  }),
  outputSchema: z.object({
    userId: z.number(),
    isNew: z.boolean(),
    telegramUserId: z.number(),
  }),
  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info("👤 [getOrCreateUser] Looking up user", {
      telegramUserId: context.telegramUserId,
    });

    const client = await pool.connect();
    try {
      const existingUser = await client.query(
        "SELECT id FROM users WHERE telegram_user_id = $1",
        [context.telegramUserId]
      );

      if (existingUser.rows.length > 0) {
        logger?.info("✅ [getOrCreateUser] User found", {
          userId: existingUser.rows[0].id,
        });
        return {
          userId: existingUser.rows[0].id,
          isNew: false,
          telegramUserId: context.telegramUserId,
        };
      }

      const newUser = await client.query(
        `INSERT INTO users (telegram_user_id, telegram_username, first_name, last_name) 
         VALUES ($1, $2, $3, $4) 
         RETURNING id`,
        [
          context.telegramUserId,
          context.username || null,
          context.firstName || null,
          context.lastName || null,
        ]
      );

      logger?.info("🆕 [getOrCreateUser] Created new user", {
        userId: newUser.rows[0].id,
      });

      return {
        userId: newUser.rows[0].id,
        isNew: true,
        telegramUserId: context.telegramUserId,
      };
    } finally {
      client.release();
    }
  },
});

export const saveTransactionTool = createTool({
  id: "save-transaction",
  description:
    "Saves a new financial transaction to the database. Use this after extracting transaction details from user input.",
  inputSchema: z.object({
    userId: z.number().describe("Internal user ID from the database"),
    date: z.string().describe("Transaction date in YYYY-MM-DD format"),
    amount: z.number().describe("Transaction amount"),
    currency: z.string().default("SAR").describe("Currency code"),
    category: CategoryEnum.describe("Expense category"),
    description: z.string().describe("Description of the transaction"),
    vendorName: z.string().optional().describe("Vendor or merchant name"),
    sourceType: z
      .enum(["text", "photo", "voice", "document"])
      .describe("Source of the transaction input"),
    rawInput: z.string().optional().describe("Original raw input from user"),
    isDuplicate: z.boolean().default(false),
    duplicateOfId: z.number().optional(),
    isSuspicious: z.boolean().default(false),
    suspiciousReason: z.string().optional(),
  }),
  outputSchema: z.object({
    transactionId: z.number(),
    saved: z.boolean(),
    message: z.string(),
  }),
  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info("💾 [saveTransaction] Saving transaction", {
      userId: context.userId,
      amount: context.amount,
      category: context.category,
    });

    const client = await pool.connect();
    try {
      let vendorId = null;
      if (context.vendorName) {
        const existingVendor = await client.query(
          "SELECT id FROM vendors WHERE user_id = $1 AND LOWER(name) = LOWER($2)",
          [context.userId, context.vendorName]
        );

        if (existingVendor.rows.length > 0) {
          vendorId = existingVendor.rows[0].id;
        } else {
          const newVendor = await client.query(
            `INSERT INTO vendors (user_id, name, normalized_name) 
             VALUES ($1, $2, LOWER($2)) RETURNING id`,
            [context.userId, context.vendorName]
          );
          vendorId = newVendor.rows[0].id;
        }
      }

      const duplicateOfValue = context.duplicateOfId && context.duplicateOfId > 0 ? context.duplicateOfId : null;
      
      const result = await client.query(
        `INSERT INTO transactions 
         (user_id, vendor_id, date, amount, currency, category, description, 
          source_type, raw_input, is_duplicate, duplicate_of, is_suspicious, suspicious_reason) 
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) 
         RETURNING id`,
        [
          context.userId,
          vendorId,
          context.date,
          context.amount,
          context.currency,
          context.category,
          context.description,
          context.sourceType,
          context.rawInput || null,
          context.isDuplicate,
          duplicateOfValue,
          context.isSuspicious,
          context.suspiciousReason || null,
        ]
      );

      if (vendorId) {
        await client.query(
          `UPDATE vendors SET 
           transaction_count = transaction_count + 1,
           total_spent = total_spent + $1,
           updated_at = NOW()
           WHERE id = $2`,
          [context.amount, vendorId]
        );
      }

      await client.query(
        `INSERT INTO audit_log (user_id, action, entity_type, entity_id, new_value) 
         VALUES ($1, $2, $3, $4, $5)`,
        [
          context.userId,
          "CREATE",
          "transaction",
          result.rows[0].id,
          JSON.stringify(context),
        ]
      );

      logger?.info("✅ [saveTransaction] Transaction saved", {
        transactionId: result.rows[0].id,
      });

      return {
        transactionId: result.rows[0].id,
        saved: true,
        message: `Transaction saved: ${context.amount} ${context.currency} for ${context.category}`,
      };
    } finally {
      client.release();
    }
  },
});

export const getTransactionsTool = createTool({
  id: "get-transactions",
  description:
    "Retrieves transactions for a user within a date range. Use this for reports, summaries, or checking transaction history.",
  inputSchema: z.object({
    userId: z.number().describe("Internal user ID"),
    startDate: z.string().describe("Start date in YYYY-MM-DD format"),
    endDate: z.string().describe("End date in YYYY-MM-DD format"),
    category: CategoryEnum.optional().describe("Filter by category"),
    limit: z.number().default(100).describe("Maximum number of transactions"),
  }),
  outputSchema: z.object({
    transactions: z.array(
      z.object({
        id: z.number(),
        date: z.string(),
        amount: z.number(),
        currency: z.string(),
        category: z.string(),
        description: z.string(),
        vendorName: z.string().nullable(),
      })
    ),
    totalAmount: z.number(),
    count: z.number(),
  }),
  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info("📊 [getTransactions] Fetching transactions", {
      userId: context.userId,
      startDate: context.startDate,
      endDate: context.endDate,
    });

    const client = await pool.connect();
    try {
      let query = `
        SELECT t.id, t.date::text, t.amount::float, t.currency, t.category, 
               t.description, v.name as vendor_name
        FROM transactions t
        LEFT JOIN vendors v ON t.vendor_id = v.id
        WHERE t.user_id = $1 AND t.date >= $2 AND t.date <= $3
      `;
      const params: any[] = [context.userId, context.startDate, context.endDate];

      if (context.category) {
        query += " AND t.category = $4";
        params.push(context.category);
      }

      query += " ORDER BY t.date DESC LIMIT $" + (params.length + 1);
      params.push(context.limit);

      const result = await client.query(query, params);

      const transactions = result.rows.map((row) => ({
        id: row.id,
        date: row.date,
        amount: row.amount,
        currency: row.currency,
        category: row.category,
        description: row.description,
        vendorName: row.vendor_name,
      }));

      const totalAmount = transactions.reduce((sum, t) => sum + t.amount, 0);

      logger?.info("✅ [getTransactions] Retrieved transactions", {
        count: transactions.length,
        totalAmount,
      });

      return {
        transactions,
        totalAmount,
        count: transactions.length,
      };
    } finally {
      client.release();
    }
  },
});

export const checkDuplicateTool = createTool({
  id: "check-duplicate",
  description:
    "Checks if a similar transaction already exists to prevent duplicates. Use before saving a new transaction.",
  inputSchema: z.object({
    userId: z.number().describe("Internal user ID"),
    date: z.string().describe("Transaction date"),
    amount: z.number().describe("Transaction amount"),
    description: z.string().describe("Transaction description"),
  }),
  outputSchema: z.object({
    isDuplicate: z.boolean(),
    existingTransactionId: z.number().nullable(),
    similarity: z.string(),
  }),
  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info("🔍 [checkDuplicate] Checking for duplicates", {
      userId: context.userId,
      amount: context.amount,
    });

    const client = await pool.connect();
    try {
      const result = await client.query(
        `SELECT id, description FROM transactions 
         WHERE user_id = $1 AND date = $2 AND amount = $3
         AND created_at > NOW() - INTERVAL '24 hours'`,
        [context.userId, context.date, context.amount]
      );

      if (result.rows.length > 0) {
        logger?.info("⚠️ [checkDuplicate] Potential duplicate found", {
          existingId: result.rows[0].id,
        });
        return {
          isDuplicate: true,
          existingTransactionId: result.rows[0].id,
          similarity: "Same date and amount within 24 hours",
        };
      }

      return {
        isDuplicate: false,
        existingTransactionId: null,
        similarity: "No duplicate found",
      };
    } finally {
      client.release();
    }
  },
});

export const setBudgetTool = createTool({
  id: "set-budget",
  description:
    "Sets or updates a monthly budget limit for a specific category. Use when user wants to set spending limits.",
  inputSchema: z.object({
    userId: z.number().describe("Internal user ID"),
    category: CategoryEnum.describe("Expense category"),
    monthlyLimit: z.number().describe("Monthly budget limit amount"),
    yearMonth: z
      .string()
      .optional()
      .describe("Year-month in YYYY-MM format, defaults to current month"),
  }),
  outputSchema: z.object({
    budgetId: z.number(),
    message: z.string(),
  }),
  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    const yearMonth =
      context.yearMonth || new Date().toISOString().substring(0, 7);

    logger?.info("💰 [setBudget] Setting budget", {
      userId: context.userId,
      category: context.category,
      limit: context.monthlyLimit,
    });

    const client = await pool.connect();
    try {
      const result = await client.query(
        `INSERT INTO budgets (user_id, category, monthly_limit, year_month) 
         VALUES ($1, $2, $3, $4) 
         ON CONFLICT (user_id, category, year_month) 
         DO UPDATE SET monthly_limit = $3, updated_at = NOW()
         RETURNING id`,
        [context.userId, context.category, context.monthlyLimit, yearMonth]
      );

      logger?.info("✅ [setBudget] Budget set", { budgetId: result.rows[0].id });

      return {
        budgetId: result.rows[0].id,
        message: `Budget set: ${context.monthlyLimit} for ${context.category} in ${yearMonth}`,
      };
    } finally {
      client.release();
    }
  },
});

export const getBudgetStatusTool = createTool({
  id: "get-budget-status",
  description:
    "Gets the current budget status for all categories or a specific category. Shows spent, remaining, and percentage used.",
  inputSchema: z.object({
    userId: z.number().describe("Internal user ID"),
    category: CategoryEnum.optional().describe("Specific category to check"),
    yearMonth: z.string().optional().describe("Year-month in YYYY-MM format"),
  }),
  outputSchema: z.object({
    budgets: z.array(
      z.object({
        category: z.string(),
        monthlyLimit: z.number(),
        spent: z.number(),
        remaining: z.number(),
        percentUsed: z.number(),
        isOver80: z.boolean(),
        isOver100: z.boolean(),
      })
    ),
  }),
  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    const yearMonth =
      context.yearMonth || new Date().toISOString().substring(0, 7);
    const [year, month] = yearMonth.split("-");
    const startDate = `${yearMonth}-01`;
    const endDate = new Date(parseInt(year), parseInt(month), 0)
      .toISOString()
      .split("T")[0];

    logger?.info("📈 [getBudgetStatus] Checking budget status", {
      userId: context.userId,
      yearMonth,
    });

    const client = await pool.connect();
    try {
      let budgetQuery = `
        SELECT category, monthly_limit::float 
        FROM budgets 
        WHERE user_id = $1 AND year_month = $2
      `;
      const budgetParams: any[] = [context.userId, yearMonth];

      if (context.category) {
        budgetQuery += " AND category = $3";
        budgetParams.push(context.category);
      }

      const budgetResult = await client.query(budgetQuery, budgetParams);

      const budgets = await Promise.all(
        budgetResult.rows.map(async (budget) => {
          const spentResult = await client.query(
            `SELECT COALESCE(SUM(amount), 0)::float as spent 
             FROM transactions 
             WHERE user_id = $1 AND category = $2 AND date >= $3 AND date <= $4`,
            [context.userId, budget.category, startDate, endDate]
          );

          const spent = spentResult.rows[0].spent;
          const remaining = Math.max(0, budget.monthly_limit - spent);
          const percentUsed =
            budget.monthly_limit > 0
              ? Math.round((spent / budget.monthly_limit) * 100)
              : 0;

          return {
            category: budget.category,
            monthlyLimit: budget.monthly_limit,
            spent,
            remaining,
            percentUsed,
            isOver80: percentUsed >= 80,
            isOver100: percentUsed >= 100,
          };
        })
      );

      logger?.info("✅ [getBudgetStatus] Budget status retrieved", {
        budgetCount: budgets.length,
      });

      return { budgets };
    } finally {
      client.release();
    }
  },
});

export const getCategorySummaryTool = createTool({
  id: "get-category-summary",
  description:
    "Gets a summary of spending by category for a given time period. Use for reports and analysis.",
  inputSchema: z.object({
    userId: z.number().describe("Internal user ID"),
    startDate: z.string().describe("Start date in YYYY-MM-DD format"),
    endDate: z.string().describe("End date in YYYY-MM-DD format"),
  }),
  outputSchema: z.object({
    summary: z.array(
      z.object({
        category: z.string(),
        totalAmount: z.number(),
        transactionCount: z.number(),
        percentage: z.number(),
      })
    ),
    grandTotal: z.number(),
  }),
  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info("📊 [getCategorySummary] Generating category summary", {
      userId: context.userId,
    });

    const client = await pool.connect();
    try {
      const result = await client.query(
        `SELECT category, 
                SUM(amount)::float as total_amount, 
                COUNT(*)::int as transaction_count
         FROM transactions 
         WHERE user_id = $1 AND date >= $2 AND date <= $3
         GROUP BY category
         ORDER BY total_amount DESC`,
        [context.userId, context.startDate, context.endDate]
      );

      const grandTotal = result.rows.reduce(
        (sum, row) => sum + row.total_amount,
        0
      );

      const summary = result.rows.map((row) => ({
        category: row.category,
        totalAmount: row.total_amount,
        transactionCount: row.transaction_count,
        percentage:
          grandTotal > 0
            ? Math.round((row.total_amount / grandTotal) * 100)
            : 0,
      }));

      logger?.info("✅ [getCategorySummary] Summary generated", {
        categories: summary.length,
        grandTotal,
      });

      return { summary, grandTotal };
    } finally {
      client.release();
    }
  },
});
