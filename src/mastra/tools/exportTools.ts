import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import pg from "pg";

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

export const generateReportTool = createTool({
  id: "generate-report",
  description:
    "Generates a formatted text report of transactions for a given period. Use for daily, weekly, or monthly reports.",
  inputSchema: z.object({
    userId: z.number().describe("Internal user ID"),
    reportType: z
      .enum(["today", "week", "month", "custom"])
      .describe("Type of report to generate"),
    startDate: z.string().optional().describe("Start date for custom report"),
    endDate: z.string().optional().describe("End date for custom report"),
  }),
  outputSchema: z.object({
    report: z.string(),
    totalSpent: z.number(),
    transactionCount: z.number(),
    topCategory: z.string().optional(),
  }),
  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info("📊 [generateReport] Creating report", {
      userId: context.userId,
      reportType: context.reportType,
    });

    const now = new Date();
    let startDate: string;
    let endDate: string = now.toISOString().split("T")[0];
    let periodLabel: string;

    switch (context.reportType) {
      case "today":
        startDate = endDate;
        periodLabel = "Today";
        break;
      case "week":
        const weekAgo = new Date(now);
        weekAgo.setDate(weekAgo.getDate() - 7);
        startDate = weekAgo.toISOString().split("T")[0];
        periodLabel = "This Week";
        break;
      case "month":
        startDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
        periodLabel = "This Month";
        break;
      case "custom":
        startDate = context.startDate || endDate;
        endDate = context.endDate || endDate;
        periodLabel = `${startDate} to ${endDate}`;
        break;
    }

    const client = await pool.connect();
    try {
      const txResult = await client.query(
        `SELECT t.date::text, t.amount::float, t.currency, t.category, 
                t.description, v.name as vendor_name
         FROM transactions t
         LEFT JOIN vendors v ON t.vendor_id = v.id
         WHERE t.user_id = $1 AND t.date >= $2 AND t.date <= $3
         ORDER BY t.date DESC, t.created_at DESC`,
        [context.userId, startDate, endDate]
      );

      const catResult = await client.query(
        `SELECT category, SUM(amount)::float as total, COUNT(*)::int as count
         FROM transactions
         WHERE user_id = $1 AND date >= $2 AND date <= $3
         GROUP BY category
         ORDER BY total DESC`,
        [context.userId, startDate, endDate]
      );

      const transactions = txResult.rows;
      const categories = catResult.rows;
      const totalSpent = categories.reduce((sum, c) => sum + c.total, 0);
      const transactionCount = transactions.length;
      const topCategory = categories[0]?.category;

      let report = `📊 <b>Expense Report - ${periodLabel}</b>\n`;
      report += `━━━━━━━━━━━━━━━━━━━━━\n\n`;

      if (transactionCount === 0) {
        report += `No transactions found for this period.\n`;
      } else {
        report += `<b>Summary:</b>\n`;
        report += `💰 Total Spent: <b>${totalSpent.toFixed(2)} SAR</b>\n`;
        report += `📝 Transactions: ${transactionCount}\n\n`;

        report += `<b>By Category:</b>\n`;
        for (const cat of categories) {
          const pct = ((cat.total / totalSpent) * 100).toFixed(1);
          report += `• ${cat.category}: ${cat.total.toFixed(2)} SAR (${pct}%)\n`;
        }

        if (transactions.length <= 10) {
          report += `\n<b>Transactions:</b>\n`;
          for (const tx of transactions) {
            const vendor = tx.vendor_name ? ` @ ${tx.vendor_name}` : "";
            report += `• ${tx.date}: ${tx.amount} ${tx.currency} - ${tx.description}${vendor}\n`;
          }
        } else {
          report += `\n<b>Recent Transactions (10 of ${transactionCount}):</b>\n`;
          for (const tx of transactions.slice(0, 10)) {
            const vendor = tx.vendor_name ? ` @ ${tx.vendor_name}` : "";
            report += `• ${tx.date}: ${tx.amount} ${tx.currency} - ${tx.description}${vendor}\n`;
          }
        }
      }

      logger?.info("✅ [generateReport] Report generated", {
        transactionCount,
        totalSpent,
      });

      return {
        report,
        totalSpent,
        transactionCount,
        topCategory,
      };
    } finally {
      client.release();
    }
  },
});

export const exportCSVTool = createTool({
  id: "export-csv",
  description:
    "Exports transactions to CSV format. Returns the CSV content as a string.",
  inputSchema: z.object({
    userId: z.number().describe("Internal user ID"),
    startDate: z.string().describe("Start date in YYYY-MM-DD format"),
    endDate: z.string().describe("End date in YYYY-MM-DD format"),
  }),
  outputSchema: z.object({
    csvContent: z.string(),
    rowCount: z.number(),
    fileName: z.string(),
  }),
  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info("📄 [exportCSV] Exporting to CSV", {
      userId: context.userId,
      startDate: context.startDate,
      endDate: context.endDate,
    });

    const client = await pool.connect();
    try {
      const result = await client.query(
        `SELECT t.date::text, t.amount::float, t.currency, t.category, 
                t.description, v.name as vendor_name, t.source_type
         FROM transactions t
         LEFT JOIN vendors v ON t.vendor_id = v.id
         WHERE t.user_id = $1 AND t.date >= $2 AND t.date <= $3
         ORDER BY t.date DESC`,
        [context.userId, context.startDate, context.endDate]
      );

      const headers = ["Date", "Amount", "Currency", "Category", "Description", "Vendor", "Source"];
      const rows = result.rows.map((row) => [
        row.date,
        row.amount.toString(),
        row.currency,
        row.category,
        `"${(row.description || "").replace(/"/g, '""')}"`,
        `"${(row.vendor_name || "").replace(/"/g, '""')}"`,
        row.source_type || "unknown",
      ]);

      const csvContent = [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");
      const fileName = `transactions_${context.startDate}_to_${context.endDate}.csv`;

      logger?.info("✅ [exportCSV] Export complete", { rowCount: rows.length });

      return {
        csvContent,
        rowCount: rows.length,
        fileName,
      };
    } finally {
      client.release();
    }
  },
});

export const predictCashflowTool = createTool({
  id: "predict-cashflow",
  description:
    "Predicts monthly cashflow based on historical spending patterns. Use to help users plan their finances.",
  inputSchema: z.object({
    userId: z.number().describe("Internal user ID"),
    months: z.number().default(3).describe("Number of months to analyze"),
  }),
  outputSchema: z.object({
    prediction: z.string(),
    averageMonthlySpend: z.number(),
    trendDirection: z.enum(["increasing", "stable", "decreasing"]),
    categoryTrends: z.array(
      z.object({
        category: z.string(),
        avgSpend: z.number(),
        trend: z.string(),
      })
    ),
  }),
  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info("📈 [predictCashflow] Analyzing spending patterns", {
      userId: context.userId,
      months: context.months,
    });

    const client = await pool.connect();
    try {
      const result = await client.query(
        `SELECT 
           TO_CHAR(date, 'YYYY-MM') as month,
           category,
           SUM(amount)::float as total
         FROM transactions
         WHERE user_id = $1 AND date > NOW() - INTERVAL '${context.months} months'
         GROUP BY TO_CHAR(date, 'YYYY-MM'), category
         ORDER BY month`,
        [context.userId]
      );

      const monthlyTotals: Record<string, number> = {};
      const categoryData: Record<string, number[]> = {};

      for (const row of result.rows) {
        monthlyTotals[row.month] = (monthlyTotals[row.month] || 0) + row.total;
        if (!categoryData[row.category]) categoryData[row.category] = [];
        categoryData[row.category].push(row.total);
      }

      const months = Object.keys(monthlyTotals).sort();
      const totals = months.map((m) => monthlyTotals[m]);
      const averageMonthlySpend =
        totals.length > 0 ? totals.reduce((a, b) => a + b, 0) / totals.length : 0;

      let trendDirection: "increasing" | "stable" | "decreasing" = "stable";
      if (totals.length >= 2) {
        const firstHalf = totals.slice(0, Math.floor(totals.length / 2));
        const secondHalf = totals.slice(Math.floor(totals.length / 2));
        const firstAvg = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length;
        const secondAvg = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length;
        const change = ((secondAvg - firstAvg) / firstAvg) * 100;
        if (change > 10) trendDirection = "increasing";
        else if (change < -10) trendDirection = "decreasing";
      }

      const categoryTrends = Object.entries(categoryData).map(([category, amounts]) => {
        const avgSpend = amounts.reduce((a, b) => a + b, 0) / amounts.length;
        let trend = "stable";
        if (amounts.length >= 2) {
          const change = ((amounts[amounts.length - 1] - amounts[0]) / amounts[0]) * 100;
          if (change > 20) trend = "increasing";
          else if (change < -20) trend = "decreasing";
        }
        return { category, avgSpend: Math.round(avgSpend * 100) / 100, trend };
      });

      let prediction = `📈 <b>Cashflow Prediction</b>\n\n`;
      prediction += `Based on the last ${context.months} months:\n`;
      prediction += `• Average monthly spending: <b>${averageMonthlySpend.toFixed(2)} SAR</b>\n`;
      prediction += `• Trend: ${trendDirection === "increasing" ? "📈 Increasing" : trendDirection === "decreasing" ? "📉 Decreasing" : "➡️ Stable"}\n\n`;

      if (categoryTrends.length > 0) {
        prediction += `<b>Category Trends:</b>\n`;
        for (const ct of categoryTrends.slice(0, 5)) {
          const trendIcon = ct.trend === "increasing" ? "⬆️" : ct.trend === "decreasing" ? "⬇️" : "➡️";
          prediction += `• ${ct.category}: ${ct.avgSpend} SAR/month ${trendIcon}\n`;
        }
      }

      logger?.info("✅ [predictCashflow] Prediction complete", {
        averageMonthlySpend,
        trendDirection,
      });

      return {
        prediction,
        averageMonthlySpend: Math.round(averageMonthlySpend * 100) / 100,
        trendDirection,
        categoryTrends,
      };
    } finally {
      client.release();
    }
  },
});
