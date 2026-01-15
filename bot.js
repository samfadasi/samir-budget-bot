let pool = null;
let DB_STATUS = "disabled";

async function initDbSafe() {
  try {
    const DATABASE_URL = (process.env.DATABASE_URL || "").trim();
    if (!DATABASE_URL) {
      DB_STATUS = "disabled";
      return;
    }

    // dynamic import عشان لو pg غير مثبت ما يكراش التطبيق
    const pg = await import("pg");
    const { Pool } = pg.default || pg;

    pool = new Pool({
      connectionString: DATABASE_URL,
      ssl: { rejectUnauthorized: false }
    });

    await pool.query("select 1");
    DB_STATUS = "enabled";
    console.log("DB READY");
  } catch (e) {
    DB_STATUS = "error";
    console.error("DB INIT FAIL:", e);
    pool = null; // المهم: ما تكراش
  }
}
