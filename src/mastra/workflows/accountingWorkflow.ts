import { createStep, createWorkflow } from "../inngest";
import { z } from "zod";
import { accountingAgent } from "../agents/accountingAgent";
import { sendTelegramMessage, sendTelegramDocument } from "../../triggers/telegramTriggers";

const MessageTypeEnum = z.enum(["text", "photo", "voice", "document", "unknown"]);

const workflowInputSchema = z.object({
  telegramUserId: z.number().describe("Telegram user ID"),
  userName: z.string().describe("Telegram username"),
  firstName: z.string().describe("User's first name"),
  lastName: z.string().describe("User's last name"),
  chatId: z.number().describe("Telegram chat ID for sending responses"),
  messageId: z.number().describe("Original message ID"),
  messageType: MessageTypeEnum.describe("Type of message received"),
  message: z.string().describe("Text content of the message"),
  fileId: z.string().optional().describe("File ID for photos, voice, or documents"),
  fileName: z.string().optional().describe("File name for documents"),
  mimeType: z.string().optional().describe("MIME type of the file"),
  caption: z.string().optional().describe("Caption for photos or documents"),
});

const processWithAgentStep = createStep({
  id: "process-with-agent",
  description: "Processes the incoming Telegram message using the accounting agent to extract transactions, generate reports, or handle commands.",
  inputSchema: workflowInputSchema,
  outputSchema: z.object({
    agentResponse: z.string(),
    chatId: z.number(),
    hasCSVExport: z.boolean(),
    csvContent: z.string().optional(),
    csvFileName: z.string().optional(),
  }),
  execute: async ({ inputData, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info("🤖 [Step 1] Processing with accounting agent", {
      telegramUserId: inputData.telegramUserId,
      messageType: inputData.messageType,
      message: inputData.message?.substring(0, 100),
    });

    let prompt = "";
    const userContext = `User: ${inputData.firstName} ${inputData.lastName} (@${inputData.userName}), Telegram ID: ${inputData.telegramUserId}`;

    switch (inputData.messageType) {
      case "text":
        prompt = `${userContext}

The user sent a text message: "${inputData.message}"

If this looks like an expense (e.g., "Paid 250 SAR for packaging"), extract the transaction details and save it.
If this is a command (starting with /), handle it appropriately.
If unclear, ask the user to clarify.`;
        break;

      case "photo":
        prompt = `${userContext}

The user sent a receipt/invoice photo.
File ID: ${inputData.fileId}
Caption: ${inputData.caption || "None"}

Use the extract-transaction-from-image tool with this file ID to extract the transaction details, then save it to the database.`;
        break;

      case "voice":
        prompt = `${userContext}

The user sent a voice message about an expense.
File ID: ${inputData.fileId}

Use the extract-transaction-from-voice tool with this file ID to transcribe and extract the transaction details, then save it.`;
        break;

      case "document":
        prompt = `${userContext}

The user sent a document (likely an invoice or receipt).
File ID: ${inputData.fileId}
File name: ${inputData.fileName || "Unknown"}
MIME type: ${inputData.mimeType || "Unknown"}
Caption: ${inputData.caption || "None"}

If this is a PDF, use the extract-transaction-from-document tool to extract transaction details.`;
        break;

      default:
        prompt = `${userContext}

The user sent an unsupported message type. Let them know you can process text messages, photos of receipts, voice notes, and PDF documents.`;
    }

    try {
      const threadId = `telegram_${inputData.telegramUserId}`;
      
      const response = await accountingAgent.generateLegacy(
        [{ role: "user", content: prompt }],
        {
          resourceId: `user_${inputData.telegramUserId}`,
          threadId,
          maxSteps: 10,
        }
      );

      logger?.info("✅ [Step 1] Agent processing complete", {
        responseLength: response.text?.length,
      });

      let hasCSVExport = false;
      let csvContent: string | undefined;
      let csvFileName: string | undefined;

      if (response.toolResults) {
        for (const result of Object.values(response.toolResults) as any[]) {
          if (result?.csvContent) {
            hasCSVExport = true;
            csvContent = result.csvContent;
            csvFileName = result.fileName || "transactions.csv";
            break;
          }
        }
      }

      return {
        agentResponse: response.text || "I processed your request but couldn't generate a response.",
        chatId: inputData.chatId,
        hasCSVExport,
        csvContent,
        csvFileName,
      };
    } catch (error) {
      logger?.error("❌ [Step 1] Agent processing failed", { error });
      return {
        agentResponse: "Sorry, I encountered an error processing your request. Please try again.",
        chatId: inputData.chatId,
        hasCSVExport: false,
      };
    }
  },
});

const sendToTelegramStep = createStep({
  id: "send-to-telegram",
  description: "Sends the agent's response back to the user via Telegram.",
  inputSchema: z.object({
    agentResponse: z.string(),
    chatId: z.number(),
    hasCSVExport: z.boolean(),
    csvContent: z.string().optional(),
    csvFileName: z.string().optional(),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    message: z.string(),
  }),
  execute: async ({ inputData, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info("📤 [Step 2] Sending response to Telegram", {
      chatId: inputData.chatId,
      responseLength: inputData.agentResponse?.length,
      hasCSVExport: inputData.hasCSVExport,
    });

    try {
      const MAX_MESSAGE_LENGTH = 4000;
      let responseText = inputData.agentResponse;
      
      if (responseText.length > MAX_MESSAGE_LENGTH) {
        responseText = responseText.substring(0, MAX_MESSAGE_LENGTH) + "\n\n[Message truncated due to length]";
      }

      const messageSent = await sendTelegramMessage(inputData.chatId, responseText, null);

      if (!messageSent) {
        logger?.warn("⚠️ [Step 2] First send failed, retrying with plain text");
        const plainSent = await sendTelegramMessage(
          inputData.chatId,
          responseText.replace(/<[^>]*>/g, "").replace(/\*\*/g, "").replace(/\*/g, ""),
          null
        );
        if (!plainSent) {
          throw new Error("Failed to send message to Telegram");
        }
      }

      if (inputData.hasCSVExport && inputData.csvContent && inputData.csvFileName) {
        logger?.info("📎 [Step 2] Sending CSV export", { fileName: inputData.csvFileName });
        
        const csvBuffer = Buffer.from(inputData.csvContent, "utf-8");
        await sendTelegramDocument(
          inputData.chatId,
          csvBuffer,
          inputData.csvFileName,
          "📊 Here's your transaction export"
        );
      }

      logger?.info("✅ [Step 2] Message sent successfully");

      return {
        success: true,
        message: "Response sent to Telegram",
      };
    } catch (error) {
      logger?.error("❌ [Step 2] Failed to send Telegram message", { error });
      return {
        success: false,
        message: error instanceof Error ? error.message : "Unknown error sending message",
      };
    }
  },
});

export const accountingWorkflow = createWorkflow({
  id: "accounting-workflow",
  inputSchema: workflowInputSchema as any,
  outputSchema: z.object({
    success: z.boolean(),
    message: z.string(),
  }),
})
  .then(processWithAgentStep as any)
  .then(sendToTelegramStep as any)
  .commit();
