import { Hono } from "hono";
import pg from "pg";

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const isDashboardEnabled = () => process.env.ENABLE_DASHBOARD === "true";

const authMiddleware = async (c: any, next: any) => {
  const token = c.req.header("Authorization")?.replace("Bearer ", "") || 
                c.req.query("token");
  
  const validToken = process.env.DASHBOARD_ACCESS_TOKEN;
  
  if (!validToken) {
    return c.json({ error: "Dashboard not configured. Set DASHBOARD_ACCESS_TOKEN." }, 500);
  }
  
  if (token !== validToken) {
    return c.json({ error: "Unauthorized. Provide valid token." }, 401);
  }
  
  await next();
};

export function createDashboardRoutes() {
  const app = new Hono();

  app.get("/", async (c) => {
    if (!isDashboardEnabled()) {
      return c.json({ 
        enabled: false, 
        message: "Dashboard is disabled. Set ENABLE_DASHBOARD=true to enable." 
      });
    }
    return c.json({ 
      enabled: true, 
      message: "Dashboard API is active",
      endpoints: [
        "GET /dashboard/overview - Dashboard KPIs",
        "GET /dashboard/transactions - Transaction list",
        "GET /dashboard/budgets - Budget status",
        "GET /dashboard/alerts - Recent alerts",
      ]
    });
  });

  app.get("/overview", authMiddleware, async (c) => {
    if (!isDashboardEnabled()) {
      return c.json({ error: "Dashboard disabled" }, 403);
    }

    const userId = parseInt(c.req.query("userId") || "0");
    if (!userId) {
      return c.json({ error: "userId query parameter required" }, 400);
    }

    const client = await pool.connect();
    try {
      const now = new Date();
      const yearMonth = now.toISOString().substring(0, 7);
      const startOfMonth = `${yearMonth}-01`;
      const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().split("T")[0];
      const startOfWeek = new Date(now.setDate(now.getDate() - now.getDay())).toISOString().split("T")[0];
      const today = new Date().toISOString().split("T")[0];

      const [totalMonth, totalWeek, totalToday, categoryBreakdown, topVendors, recentAlerts] = await Promise.all([
        client.query(
          `SELECT COALESCE(SUM(amount), 0)::float as total, COUNT(*)::int as count 
           FROM transactions WHERE user_id = $1 AND date >= $2 AND date <= $3`,
          [userId, startOfMonth, endOfMonth]
        ),
        client.query(
          `SELECT COALESCE(SUM(amount), 0)::float as total, COUNT(*)::int as count 
           FROM transactions WHERE user_id = $1 AND date >= $2`,
          [userId, startOfWeek]
        ),
        client.query(
          `SELECT COALESCE(SUM(amount), 0)::float as total, COUNT(*)::int as count 
           FROM transactions WHERE user_id = $1 AND date = $2`,
          [userId, today]
        ),
        client.query(
          `SELECT category, SUM(amount)::float as total, COUNT(*)::int as count 
           FROM transactions WHERE user_id = $1 AND date >= $2 
           GROUP BY category ORDER BY total DESC LIMIT 10`,
          [userId, startOfMonth]
        ),
        client.query(
          `SELECT v.name, SUM(t.amount)::float as total, COUNT(*)::int as count 
           FROM transactions t 
           JOIN vendors v ON t.vendor_id = v.id 
           WHERE t.user_id = $1 AND t.date >= $2 
           GROUP BY v.name ORDER BY total DESC LIMIT 5`,
          [userId, startOfMonth]
        ),
        client.query(
          `SELECT alert_type, category, message, created_at::text 
           FROM alerts_log WHERE user_id = $1 
           ORDER BY created_at DESC LIMIT 5`,
          [userId]
        ),
      ]);

      return c.json({
        overview: {
          monthTotal: totalMonth.rows[0].total,
          monthTransactions: totalMonth.rows[0].count,
          weekTotal: totalWeek.rows[0].total,
          weekTransactions: totalWeek.rows[0].count,
          todayTotal: totalToday.rows[0].total,
          todayTransactions: totalToday.rows[0].count,
        },
        categoryBreakdown: categoryBreakdown.rows,
        topVendors: topVendors.rows,
        recentAlerts: recentAlerts.rows,
      });
    } finally {
      client.release();
    }
  });

  app.get("/transactions", authMiddleware, async (c) => {
    if (!isDashboardEnabled()) {
      return c.json({ error: "Dashboard disabled" }, 403);
    }

    const userId = parseInt(c.req.query("userId") || "0");
    const limit = parseInt(c.req.query("limit") || "50");
    const offset = parseInt(c.req.query("offset") || "0");
    const category = c.req.query("category");
    const startDate = c.req.query("startDate");
    const endDate = c.req.query("endDate");

    if (!userId) {
      return c.json({ error: "userId query parameter required" }, 400);
    }

    const client = await pool.connect();
    try {
      let query = `
        SELECT t.id, t.date::text, t.amount::float, t.currency, t.category, 
               t.description, v.name as vendor_name, t.source_type, t.created_at::text
        FROM transactions t
        LEFT JOIN vendors v ON t.vendor_id = v.id
        WHERE t.user_id = $1
      `;
      const params: any[] = [userId];
      let paramIndex = 2;

      if (category) {
        query += ` AND t.category = $${paramIndex}`;
        params.push(category);
        paramIndex++;
      }
      if (startDate) {
        query += ` AND t.date >= $${paramIndex}`;
        params.push(startDate);
        paramIndex++;
      }
      if (endDate) {
        query += ` AND t.date <= $${paramIndex}`;
        params.push(endDate);
        paramIndex++;
      }

      query += ` ORDER BY t.date DESC, t.created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
      params.push(limit, offset);

      const result = await client.query(query, params);

      const countResult = await client.query(
        `SELECT COUNT(*)::int as total FROM transactions WHERE user_id = $1`,
        [userId]
      );

      return c.json({
        transactions: result.rows,
        pagination: {
          total: countResult.rows[0].total,
          limit,
          offset,
        },
      });
    } finally {
      client.release();
    }
  });

  app.get("/budgets", authMiddleware, async (c) => {
    if (!isDashboardEnabled()) {
      return c.json({ error: "Dashboard disabled" }, 403);
    }

    const userId = parseInt(c.req.query("userId") || "0");
    if (!userId) {
      return c.json({ error: "userId query parameter required" }, 400);
    }

    const client = await pool.connect();
    try {
      const now = new Date();
      const yearMonth = now.toISOString().substring(0, 7);
      const startOfMonth = `${yearMonth}-01`;
      const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().split("T")[0];

      const result = await client.query(
        `SELECT b.id, b.category, b.monthly_limit::float as budget_limit, b.year_month,
                COALESCE(SUM(t.amount), 0)::float as spent
         FROM budgets b
         LEFT JOIN transactions t ON b.user_id = t.user_id 
           AND b.category = t.category 
           AND t.date >= $2 AND t.date <= $3
         WHERE b.user_id = $1 AND b.year_month = $4
         GROUP BY b.id, b.category, b.monthly_limit, b.year_month`,
        [userId, startOfMonth, endOfMonth, yearMonth]
      );

      const budgets = result.rows.map((row) => ({
        id: row.id,
        category: row.category,
        limit: row.budget_limit,
        spent: row.spent,
        remaining: Math.max(0, row.budget_limit - row.spent),
        percentUsed: row.budget_limit > 0 ? Math.round((row.spent / row.budget_limit) * 100) : 0,
        yearMonth: row.year_month,
      }));

      return c.json({ budgets });
    } finally {
      client.release();
    }
  });

  app.get("/alerts", authMiddleware, async (c) => {
    if (!isDashboardEnabled()) {
      return c.json({ error: "Dashboard disabled" }, 403);
    }

    const userId = parseInt(c.req.query("userId") || "0");
    const limit = parseInt(c.req.query("limit") || "20");
    const alertType = c.req.query("alertType");

    if (!userId) {
      return c.json({ error: "userId query parameter required" }, 400);
    }

    const client = await pool.connect();
    try {
      let query = `
        SELECT id, alert_type, category, transaction_id, budget_id, 
               year_month, threshold_percent, amount_spent::float, 
               budget_limit::float, message, telegram_sent, created_at::text
        FROM alerts_log WHERE user_id = $1
      `;
      const params: any[] = [userId];

      if (alertType) {
        query += ` AND alert_type = $2`;
        params.push(alertType);
      }

      query += ` ORDER BY created_at DESC LIMIT $${params.length + 1}`;
      params.push(limit);

      const result = await client.query(query, params);

      return c.json({ alerts: result.rows });
    } finally {
      client.release();
    }
  });

  app.get("/reports", authMiddleware, async (c) => {
    if (!isDashboardEnabled()) {
      return c.json({ error: "Dashboard disabled" }, 403);
    }

    const userId = parseInt(c.req.query("userId") || "0");
    const limit = parseInt(c.req.query("limit") || "20");

    if (!userId) {
      return c.json({ error: "userId query parameter required" }, 400);
    }

    const client = await pool.connect();
    try {
      const result = await client.query(
        `SELECT id, report_type, format, start_date::text, end_date::text, 
                row_count, file_size, telegram_sent, created_at::text
         FROM reports_log WHERE user_id = $1
         ORDER BY created_at DESC LIMIT $2`,
        [userId, limit]
      );

      return c.json({ reports: result.rows });
    } finally {
      client.release();
    }
  });

  return app;
}
