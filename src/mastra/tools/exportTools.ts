import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import pg from "pg";
import PDFDocument from "pdfkit";

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const isPdfReportsEnabled = () => process.env.ENABLE_PDF_REPORTS === "true";

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

export const generatePdfReportTool = createTool({
  id: "generate-pdf-report",
  description:
    "Generates a professional PDF report of transactions for a given period. Only works when ENABLE_PDF_REPORTS is true. Returns a base64-encoded PDF buffer.",
  inputSchema: z.object({
    userId: z.number().describe("Internal user ID"),
    reportType: z
      .enum(["today", "week", "month", "custom"])
      .describe("Type of report to generate"),
    startDate: z.string().optional().describe("Start date for custom report"),
    endDate: z.string().optional().describe("End date for custom report"),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    pdfBuffer: z.string().optional().describe("Base64-encoded PDF buffer"),
    fileName: z.string().optional(),
    totalSpent: z.number().optional(),
    transactionCount: z.number().optional(),
    error: z.string().optional(),
    disabled: z.boolean().optional(),
  }),
  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();

    if (!isPdfReportsEnabled()) {
      logger?.info("⏭️ [generatePdfReport] PDF reports disabled");
      return {
        success: false,
        disabled: true,
        error: "PDF reports are disabled (ENABLE_PDF_REPORTS=false)",
      };
    }

    logger?.info("📄 [generatePdfReport] Generating PDF report", {
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
        periodLabel = "Daily Report";
        break;
      case "week":
        const weekAgo = new Date(now);
        weekAgo.setDate(weekAgo.getDate() - 7);
        startDate = weekAgo.toISOString().split("T")[0];
        periodLabel = "Weekly Report";
        break;
      case "month":
        startDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
        periodLabel = "Monthly Report";
        break;
      case "custom":
        startDate = context.startDate || endDate;
        endDate = context.endDate || endDate;
        periodLabel = `Report: ${startDate} to ${endDate}`;
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

      const budgetResult = await client.query(
        `SELECT b.category, b.monthly_limit::float as budget_limit,
                COALESCE(SUM(t.amount), 0)::float as spent
         FROM budgets b
         LEFT JOIN transactions t ON b.user_id = t.user_id 
           AND b.category = t.category 
           AND t.date >= $2 AND t.date <= $3
         WHERE b.user_id = $1 AND b.year_month = $4
         GROUP BY b.category, b.monthly_limit`,
        [context.userId, startDate, endDate, now.toISOString().substring(0, 7)]
      );

      const userResult = await client.query(
        `SELECT first_name, last_name, telegram_username 
         FROM users WHERE id = $1`,
        [context.userId]
      );

      const transactions = txResult.rows;
      const categories = catResult.rows;
      const budgets = budgetResult.rows;
      const user = userResult.rows[0];
      const totalSpent = categories.reduce((sum, c) => sum + c.total, 0);
      const transactionCount = transactions.length;

      const pdfBuffer = await new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = [];
        const doc = new PDFDocument({ margin: 50, size: "A4" });

        doc.on("data", (chunk) => chunks.push(chunk));
        doc.on("end", () => resolve(Buffer.concat(chunks)));
        doc.on("error", reject);

        doc.fontSize(24).font("Helvetica-Bold").text("Expense Report", { align: "center" });
        doc.fontSize(14).font("Helvetica").text(periodLabel, { align: "center" });
        doc.moveDown();

        if (user) {
          doc.fontSize(10).text(`User: ${user.first_name || ""} ${user.last_name || ""} (@${user.telegram_username || "N/A"})`, { align: "center" });
        }
        doc.text(`Generated: ${new Date().toLocaleString()}`, { align: "center" });
        doc.moveDown(2);

        doc.fontSize(16).font("Helvetica-Bold").text("Summary");
        doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke();
        doc.moveDown(0.5);

        doc.fontSize(12).font("Helvetica");
        doc.text(`Total Spent: ${totalSpent.toFixed(2)} SAR`);
        doc.text(`Number of Transactions: ${transactionCount}`);
        doc.text(`Period: ${startDate} to ${endDate}`);
        doc.moveDown(2);

        if (categories.length > 0) {
          doc.fontSize(16).font("Helvetica-Bold").text("Spending by Category");
          doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke();
          doc.moveDown(0.5);

          doc.fontSize(10).font("Helvetica");
          for (const cat of categories) {
            const pct = totalSpent > 0 ? ((cat.total / totalSpent) * 100).toFixed(1) : "0";
            doc.text(`${cat.category}: ${cat.total.toFixed(2)} SAR (${pct}%) - ${cat.count} transactions`);
          }
          doc.moveDown(2);
        }

        if (budgets.length > 0) {
          doc.fontSize(16).font("Helvetica-Bold").text("Budget Status");
          doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke();
          doc.moveDown(0.5);

          doc.fontSize(10).font("Helvetica");
          for (const budget of budgets) {
            const pctUsed = budget.budget_limit > 0 ? ((budget.spent / budget.budget_limit) * 100).toFixed(0) : "0";
            const remaining = Math.max(0, budget.budget_limit - budget.spent);
            const status = parseInt(pctUsed) >= 100 ? "EXCEEDED" : parseInt(pctUsed) >= 80 ? "WARNING" : "OK";
            doc.text(`${budget.category}: ${budget.spent.toFixed(2)} / ${budget.budget_limit.toFixed(2)} SAR (${pctUsed}%) - ${status} - Remaining: ${remaining.toFixed(2)} SAR`);
          }
          doc.moveDown(2);
        }

        if (transactions.length > 0) {
          doc.fontSize(16).font("Helvetica-Bold").text("Transaction Details");
          doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke();
          doc.moveDown(0.5);

          doc.fontSize(9).font("Helvetica");
          const displayTxs = transactions.slice(0, 50);
          for (const tx of displayTxs) {
            const vendor = tx.vendor_name ? ` @ ${tx.vendor_name}` : "";
            doc.text(`${tx.date} | ${tx.amount} ${tx.currency} | ${tx.category} | ${tx.description}${vendor}`);
          }

          if (transactions.length > 50) {
            doc.moveDown();
            doc.text(`... and ${transactions.length - 50} more transactions`);
          }
        }

        doc.moveDown(3);
        doc.fontSize(8).fillColor("gray").text("Generated by @SamirBudgetBot - Your AI Accounting Assistant", { align: "center" });

        doc.end();
      });

      await client.query(
        `INSERT INTO reports_log (user_id, report_type, format, start_date, end_date, row_count, file_size, telegram_sent)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [context.userId, context.reportType, "pdf", startDate, endDate, transactionCount, pdfBuffer.length, false]
      );

      const fileName = `expense_report_${context.reportType}_${startDate}_${endDate}.pdf`;

      logger?.info("✅ [generatePdfReport] PDF generated", {
        fileName,
        size: pdfBuffer.length,
        transactionCount,
      });

      return {
        success: true,
        pdfBuffer: pdfBuffer.toString("base64"),
        fileName,
        totalSpent,
        transactionCount,
      };
    } catch (error) {
      logger?.error("❌ [generatePdfReport] PDF generation failed", { error });
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error generating PDF",
      };
    } finally {
      client.release();
    }
  },
});

export const logReportGenerationTool = createTool({
  id: "log-report-generation",
  description:
    "Logs a report generation event to the reports_log table for tracking purposes.",
  inputSchema: z.object({
    userId: z.number().describe("Internal user ID"),
    reportType: z.string().describe("Type of report generated"),
    format: z.enum(["text", "csv", "pdf"]).describe("Format of the report"),
    startDate: z.string().describe("Start date of the report"),
    endDate: z.string().describe("End date of the report"),
    rowCount: z.number().describe("Number of rows/transactions in the report"),
    fileSize: z.number().optional().describe("Size of the file in bytes"),
    telegramSent: z.boolean().default(false),
  }),
  outputSchema: z.object({
    logged: z.boolean(),
    reportId: z.number().optional(),
  }),
  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info("📝 [logReportGeneration] Logging report", {
      userId: context.userId,
      reportType: context.reportType,
      format: context.format,
    });

    const client = await pool.connect();

    try {
      const result = await client.query(
        `INSERT INTO reports_log (user_id, report_type, format, start_date, end_date, row_count, file_size, telegram_sent)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id`,
        [
          context.userId,
          context.reportType,
          context.format,
          context.startDate,
          context.endDate,
          context.rowCount,
          context.fileSize || null,
          context.telegramSent,
        ]
      );

      logger?.info("✅ [logReportGeneration] Report logged", { reportId: result.rows[0].id });

      return {
        logged: true,
        reportId: result.rows[0].id,
      };
    } catch (error) {
      logger?.error("❌ [logReportGeneration] Failed to log report", { error });
      return {
        logged: false,
      };
    } finally {
      client.release();
    }
  },
});
