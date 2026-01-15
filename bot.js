async function extractExpenseFromText(text) {
  if (!openai) throw new Error("OpenAI disabled");

  const today = new Date().toISOString().slice(0, 10);

  const resp = await openai.responses.create({
    model: OPENAI_MODEL,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "expense",
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            tx_date: {
              type: "string",
              description: "YYYY-MM-DD, use today if missing",
            },
            amount: {
              type: "number",
              description: "Positive number",
            },
            currency: {
              type: "string",
              description: "SAR if missing or if message contains ريال",
            },
            vendor: {
              type: "string",
              description: "Merchant or place name",
            },
            category: {
              type: "string",
              enum: [
                "Food",
                "Transport",
                "Utilities",
                "Rent",
                "Business",
                "Personal",
                "Equipment",
                "Raw materials",
                "Uncategorized",
              ],
            },
            description: {
              type: "string",
            },
          },
          required: ["amount"],
        },
      },
    },
    input: [
      {
        role: "system",
        content:
          "You extract ONE expense transaction from Arabic or English text.",
      },
      {
        role: "user",
        content: `Today is ${today}.
Message:
"${text}"

Rules:
- ريال = SAR
- Food keywords: غداء، عشاء، فطور، مطعم، قهوة
- If unsure category, use Food for meals, else Uncategorized.`,
      },
    ],
  });

  const data = resp.output_parsed;

  // تطبيع
  return normalizeTx({
    tx_date: data.tx_date || today,
    amount: data.amount,
    currency: data.currency || "SAR",
    vendor: data.vendor || "Unknown",
    category: data.category || "Uncategorized",
    description: data.description || "",
  });
}
