import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";
import { downloadTelegramFile } from "../../triggers/telegramTriggers";

const openai = createOpenAI({
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
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

const TransactionExtractionSchema = z.object({
  date: z.string().describe("Transaction date in YYYY-MM-DD format"),
  amount: z.number().describe("Transaction amount"),
  currency: z.string().default("SAR").describe("Currency code"),
  category: CategoryEnum.describe("Expense category"),
  description: z.string().describe("Brief description of the expense"),
  vendorName: z.string().optional().describe("Vendor or merchant name if identifiable"),
  confidence: z.number().min(0).max(1).describe("Confidence score of extraction"),
});

export const extractTransactionFromTextTool = createTool({
  id: "extract-transaction-from-text",
  description:
    "Extracts structured transaction data from a text message. Use this when user sends a text description of an expense.",
  inputSchema: z.object({
    text: z.string().describe("The text message to extract transaction from"),
    defaultCurrency: z.string().default("SAR").describe("Default currency if not specified"),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    transaction: TransactionExtractionSchema.optional(),
    error: z.string().optional(),
  }),
  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info("📝 [extractFromText] Processing text", { text: context.text });

    try {
      const today = new Date().toISOString().split("T")[0];
      
      const prompt = `Extract financial transaction details from this text. Today's date is ${today}.

Text: "${context.text}"

Categorize into one of: Food, Transport, Utilities, Rent, Business, Personal, Equipment, Raw materials, Uncategorized.

Respond with a JSON object containing:
- date: YYYY-MM-DD format (use today if not specified)
- amount: number (extract the numeric amount)
- currency: string (default to ${context.defaultCurrency} if not specified)
- category: one of the categories above
- description: brief description
- vendorName: vendor/merchant name if mentioned (optional)
- confidence: number between 0 and 1

Only respond with the JSON object, no other text.`;

      const result = await generateText({
        model: openai("gpt-4o-mini"),
        prompt,
      });

      const jsonMatch = result.text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error("Failed to parse extraction result");
      }

      const extracted = JSON.parse(jsonMatch[0]);

      logger?.info("✅ [extractFromText] Extraction successful", extracted);

      return {
        success: true,
        transaction: {
          date: extracted.date || today,
          amount: extracted.amount,
          currency: extracted.currency || context.defaultCurrency,
          category: extracted.category || "Uncategorized",
          description: extracted.description,
          vendorName: extracted.vendorName,
          confidence: extracted.confidence || 0.8,
        },
      };
    } catch (error) {
      logger?.error("❌ [extractFromText] Extraction failed", { error });
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  },
});

export const extractTransactionFromImageTool = createTool({
  id: "extract-transaction-from-image",
  description:
    "Extracts transaction data from a receipt or invoice image using OCR and AI. Use when user sends a photo.",
  inputSchema: z.object({
    fileId: z.string().describe("Telegram file ID of the image"),
    caption: z.string().optional().describe("Caption provided with the image"),
    defaultCurrency: z.string().default("SAR"),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    transaction: TransactionExtractionSchema.optional(),
    extractedText: z.string().optional(),
    error: z.string().optional(),
  }),
  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info("🖼️ [extractFromImage] Processing image", { fileId: context.fileId });

    try {
      const fileBuffer = await downloadTelegramFile(context.fileId);
      if (!fileBuffer) {
        throw new Error("Failed to download image from Telegram");
      }

      const base64Image = fileBuffer.toString("base64");
      const today = new Date().toISOString().split("T")[0];

      const result = await generateText({
        model: openai("gpt-4o"),
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `Analyze this receipt/invoice image and extract the transaction details. Today's date is ${today}.

${context.caption ? `Additional context: "${context.caption}"` : ""}

Categorize into: Food, Transport, Utilities, Rent, Business, Personal, Equipment, Raw materials, Uncategorized.

Respond with ONLY a JSON object:
{
  "date": "YYYY-MM-DD",
  "amount": number,
  "currency": "${context.defaultCurrency}",
  "category": "category",
  "description": "description",
  "vendorName": "vendor name",
  "confidence": 0.0-1.0,
  "extractedText": "key text from receipt"
}`,
              },
              {
                type: "image",
                image: base64Image,
              },
            ],
          },
        ],
      });

      const jsonMatch = result.text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error("Failed to parse extraction result");
      }

      const extracted = JSON.parse(jsonMatch[0]);

      logger?.info("✅ [extractFromImage] Extraction successful", {
        amount: extracted.amount,
        vendor: extracted.vendorName,
      });

      return {
        success: true,
        transaction: {
          date: extracted.date || today,
          amount: extracted.amount,
          currency: extracted.currency || context.defaultCurrency,
          category: extracted.category || "Uncategorized",
          description: extracted.description,
          vendorName: extracted.vendorName,
          confidence: extracted.confidence || 0.7,
        },
        extractedText: extracted.extractedText,
      };
    } catch (error) {
      logger?.error("❌ [extractFromImage] Extraction failed", { error });
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  },
});

export const extractTransactionFromVoiceTool = createTool({
  id: "extract-transaction-from-voice",
  description:
    "Transcribes a voice message and extracts transaction data. Use when user sends a voice note.",
  inputSchema: z.object({
    fileId: z.string().describe("Telegram file ID of the voice message"),
    defaultCurrency: z.string().default("SAR"),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    transaction: TransactionExtractionSchema.optional(),
    transcription: z.string().optional(),
    error: z.string().optional(),
  }),
  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info("🎤 [extractFromVoice] Processing voice message", { fileId: context.fileId });

    try {
      const fileBuffer = await downloadTelegramFile(context.fileId);
      if (!fileBuffer) {
        throw new Error("Failed to download voice message from Telegram");
      }

      const base64Audio = fileBuffer.toString("base64");
      const today = new Date().toISOString().split("T")[0];

      const result = await generateText({
        model: openai("gpt-4o"),
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `This is a voice message about a financial transaction. Today's date is ${today}.
First, transcribe the audio, then extract the transaction details.

Categorize into: Food, Transport, Utilities, Rent, Business, Personal, Equipment, Raw materials, Uncategorized.

Respond with ONLY a JSON object:
{
  "transcription": "what was said",
  "date": "YYYY-MM-DD",
  "amount": number,
  "currency": "${context.defaultCurrency}",
  "category": "category",
  "description": "description",
  "vendorName": "vendor if mentioned",
  "confidence": 0.0-1.0
}`,
              },
              {
                type: "file",
                data: base64Audio,
                mimeType: "audio/ogg",
              },
            ],
          },
        ],
      });

      const jsonMatch = result.text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error("Failed to parse extraction result");
      }

      const extracted = JSON.parse(jsonMatch[0]);

      logger?.info("✅ [extractFromVoice] Extraction successful", {
        transcription: extracted.transcription,
        amount: extracted.amount,
      });

      return {
        success: true,
        transaction: {
          date: extracted.date || today,
          amount: extracted.amount,
          currency: extracted.currency || context.defaultCurrency,
          category: extracted.category || "Uncategorized",
          description: extracted.description,
          vendorName: extracted.vendorName,
          confidence: extracted.confidence || 0.6,
        },
        transcription: extracted.transcription,
      };
    } catch (error) {
      logger?.error("❌ [extractFromVoice] Extraction failed", { error });
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  },
});

export const extractTransactionFromDocumentTool = createTool({
  id: "extract-transaction-from-document",
  description:
    "Extracts transaction data from a PDF document (invoice, receipt). Use when user sends a PDF file.",
  inputSchema: z.object({
    fileId: z.string().describe("Telegram file ID of the document"),
    fileName: z.string().optional().describe("Name of the file"),
    caption: z.string().optional().describe("Caption provided with the document"),
    defaultCurrency: z.string().default("SAR"),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    transaction: TransactionExtractionSchema.optional(),
    error: z.string().optional(),
  }),
  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info("📄 [extractFromDocument] Processing document", {
      fileId: context.fileId,
      fileName: context.fileName,
    });

    try {
      const fileBuffer = await downloadTelegramFile(context.fileId);
      if (!fileBuffer) {
        throw new Error("Failed to download document from Telegram");
      }

      const base64Doc = fileBuffer.toString("base64");
      const today = new Date().toISOString().split("T")[0];

      const result = await generateText({
        model: openai("gpt-4o"),
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `Analyze this PDF document (invoice/receipt) and extract the transaction details. Today's date is ${today}.

${context.caption ? `Additional context: "${context.caption}"` : ""}
${context.fileName ? `File name: "${context.fileName}"` : ""}

Categorize into: Food, Transport, Utilities, Rent, Business, Personal, Equipment, Raw materials, Uncategorized.

Respond with ONLY a JSON object:
{
  "date": "YYYY-MM-DD",
  "amount": number,
  "currency": "${context.defaultCurrency}",
  "category": "category",
  "description": "description",
  "vendorName": "vendor name",
  "confidence": 0.0-1.0
}`,
              },
              {
                type: "file",
                data: base64Doc,
                mimeType: "application/pdf",
              },
            ],
          },
        ],
      });

      const jsonMatch = result.text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error("Failed to parse extraction result");
      }

      const extracted = JSON.parse(jsonMatch[0]);

      logger?.info("✅ [extractFromDocument] Extraction successful", {
        amount: extracted.amount,
        vendor: extracted.vendorName,
      });

      return {
        success: true,
        transaction: {
          date: extracted.date || today,
          amount: extracted.amount,
          currency: extracted.currency || context.defaultCurrency,
          category: extracted.category || "Uncategorized",
          description: extracted.description,
          vendorName: extracted.vendorName,
          confidence: extracted.confidence || 0.7,
        },
      };
    } catch (error) {
      logger?.error("❌ [extractFromDocument] Extraction failed", { error });
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  },
});

export const detectAnomalyTool = createTool({
  id: "detect-anomaly",
  description:
    "Detects if a transaction amount is unusually high or suspicious compared to historical spending patterns.",
  inputSchema: z.object({
    userId: z.number().describe("Internal user ID"),
    category: CategoryEnum.describe("Transaction category"),
    amount: z.number().describe("Transaction amount to check"),
  }),
  outputSchema: z.object({
    isSuspicious: z.boolean(),
    reason: z.string().optional(),
    averageSpending: z.number(),
    deviation: z.number(),
  }),
  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info("🔍 [detectAnomaly] Checking for anomalies", {
      category: context.category,
      amount: context.amount,
    });

    const pg = await import("pg");
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    const client = await pool.connect();

    try {
      const result = await client.query(
        `SELECT AVG(amount)::float as avg_amount, 
                STDDEV(amount)::float as stddev_amount,
                MAX(amount)::float as max_amount
         FROM transactions 
         WHERE user_id = $1 AND category = $2 
         AND date > NOW() - INTERVAL '90 days'`,
        [context.userId, context.category]
      );

      const stats = result.rows[0];
      const avgAmount = stats.avg_amount || 0;
      const stddev = stats.stddev_amount || 0;
      const maxAmount = stats.max_amount || 0;

      const deviation = avgAmount > 0 ? (context.amount - avgAmount) / (stddev || avgAmount) : 0;
      const isSuspicious = deviation > 2 || context.amount > maxAmount * 2;

      let reason: string | undefined;
      if (isSuspicious) {
        if (deviation > 3) {
          reason = `Amount is ${Math.round(deviation)} standard deviations above average`;
        } else if (context.amount > maxAmount * 2) {
          reason = `Amount is more than 2x the historical maximum (${maxAmount})`;
        } else {
          reason = "Unusual spending pattern detected";
        }
      }

      logger?.info("✅ [detectAnomaly] Analysis complete", {
        isSuspicious,
        deviation: Math.round(deviation * 100) / 100,
      });

      return {
        isSuspicious,
        reason,
        averageSpending: Math.round(avgAmount * 100) / 100,
        deviation: Math.round(deviation * 100) / 100,
      };
    } finally {
      client.release();
      await pool.end();
    }
  },
});
