bot.command("month", async (ctx) => {
  try {
    if (!pool) return ctx.reply("DB غير جاهزة. شوف /env");

    const uid = ctx.from.id;

    // YYYY-MM (this month)
    const now = new Date();
    const m = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

    const r = await pool.query(
      `select category, coalesce(sum(amount),0)::numeric as total
       from tx
       where tg_user_id=$1 and to_char(tx_date,'YYYY-MM')=$2
       group by category
       order by total desc`,
      [uid, m]
    );

    if (!r.rowCount) return ctx.reply(`📊 شهر ${m}: ما في مصروفات مسجلة.`);

    const total = r.rows.reduce((s, x) => s + Number(x.total), 0);
    const lines = r.rows
      .map((x) => `- ${x.category}: ${Number(x.total).toFixed(2)} SAR`)
      .join("\n");

    return ctx.reply(`📊 ملخص شهر ${m}\n${lines}\n\nالمجموع: ${total.toFixed(2)} SAR`);
  } catch (e) {
    console.error("MONTH_FAIL:", e);
    return ctx.reply("⚠️ حصل خطأ في تقرير الشهر. راجع Logs في Railway.");
  }
});
