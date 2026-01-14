/**
 * Telegram Trigger - Webhook-based Workflow Triggering for Accounting Bot
 *
 * This module provides Telegram bot event handling for Mastra workflows.
 * Handles text messages, photos, voice notes, and documents (PDFs).
 */

import type { ContentfulStatusCode } from "hono/utils/http-status";
import { registerApiRoute } from "../mastra/inngest";
import { Mastra } from "@mastra/core";

if (!process.env.TELEGRAM_BOT_TOKEN) {
  console.warn(
    "Trying to initialize Telegram triggers without TELEGRAM_BOT_TOKEN. Can you confirm that the Telegram integration is configured correctly?",
  );
}

export type MessageType = "text" | "photo" | "voice" | "document" | "unknown";

export type TriggerInfoTelegramOnNewMessage = {
  type: "telegram/message";
  params: {
    telegramUserId: number;
    userName: string;
    firstName: string;
    lastName: string;
    chatId: number;
    messageId: number;
    messageType: MessageType;
    message: string;
    fileId?: string;
    fileName?: string;
    mimeType?: string;
    caption?: string;
  };
  payload: any;
};

function getMessageType(message: any): MessageType {
  if (message.photo && message.photo.length > 0) return "photo";
  if (message.voice) return "voice";
  if (message.document) return "document";
  if (message.text) return "text";
  return "unknown";
}

function extractFileInfo(message: any, messageType: MessageType): { fileId?: string; fileName?: string; mimeType?: string } {
  switch (messageType) {
    case "photo":
      const photos = message.photo;
      const largestPhoto = photos[photos.length - 1];
      return { fileId: largestPhoto?.file_id };
    case "voice":
      return {
        fileId: message.voice?.file_id,
        mimeType: message.voice?.mime_type,
      };
    case "document":
      return {
        fileId: message.document?.file_id,
        fileName: message.document?.file_name,
        mimeType: message.document?.mime_type,
      };
    default:
      return {};
  }
}

export function registerTelegramTrigger({
  triggerType,
  handler,
}: {
  triggerType: string;
  handler: (
    mastra: Mastra,
    triggerInfo: TriggerInfoTelegramOnNewMessage,
  ) => Promise<void>;
}) {
  return [
    registerApiRoute("/webhooks/telegram/action", {
      method: "POST",
      handler: async (c) => {
        const mastra = c.get("mastra");
        const logger = mastra.getLogger();
        try {
          const payload = await c.req.json();
          logger?.info("📨 [Telegram] Received payload", { payload });

          const message = payload.message;
          if (!message) {
            logger?.warn("📭 [Telegram] No message in payload");
            return c.text("OK", 200);
          }

          const messageType = getMessageType(message);
          const fileInfo = extractFileInfo(message, messageType);

          const triggerInfo: TriggerInfoTelegramOnNewMessage = {
            type: triggerType as "telegram/message",
            params: {
              telegramUserId: message.from?.id,
              userName: message.from?.username || "",
              firstName: message.from?.first_name || "",
              lastName: message.from?.last_name || "",
              chatId: message.chat?.id,
              messageId: message.message_id,
              messageType,
              message: message.text || message.caption || "",
              fileId: fileInfo.fileId,
              fileName: fileInfo.fileName,
              mimeType: fileInfo.mimeType,
              caption: message.caption,
            },
            payload,
          };

          logger?.info("🔄 [Telegram] Processing message", {
            messageType,
            telegramUserId: triggerInfo.params.telegramUserId,
            hasFile: !!fileInfo.fileId,
          });

          await handler(mastra, triggerInfo);

          return c.text("OK", 200);
        } catch (error) {
          logger?.error("❌ [Telegram] Error handling webhook:", { error });
          return c.text("Internal Server Error", 500);
        }
      },
    }),
  ];
}

export async function downloadTelegramFile(fileId: string): Promise<Buffer | null> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error("TELEGRAM_BOT_TOKEN not set");
    return null;
  }

  try {
    const fileInfoResponse = await fetch(
      `https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`
    );
    const fileInfo = await fileInfoResponse.json() as any;

    if (!fileInfo.ok || !fileInfo.result?.file_path) {
      console.error("Failed to get file info:", fileInfo);
      return null;
    }

    const fileUrl = `https://api.telegram.org/file/bot${token}/${fileInfo.result.file_path}`;
    const fileResponse = await fetch(fileUrl);
    const arrayBuffer = await fileResponse.arrayBuffer();

    return Buffer.from(arrayBuffer);
  } catch (error) {
    console.error("Error downloading file from Telegram:", error);
    return null;
  }
}

export async function sendTelegramMessage(
  chatId: number,
  text: string,
  parseMode: "HTML" | "Markdown" | "MarkdownV2" | null = null
): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error("❌ [sendTelegramMessage] TELEGRAM_BOT_TOKEN not set");
    return false;
  }

  try {
    console.log(`📤 [sendTelegramMessage] Sending to chat ${chatId}, length: ${text.length}`);
    
    const body: any = {
      chat_id: chatId,
      text,
    };
    
    if (parseMode) {
      body.parse_mode = parseMode;
    }
    
    const response = await fetch(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    );

    const result = await response.json() as any;
    
    if (result.ok !== true) {
      console.error("❌ [sendTelegramMessage] Telegram API error:", result);
    } else {
      console.log("✅ [sendTelegramMessage] Message sent successfully");
    }
    
    return result.ok === true;
  } catch (error) {
    console.error("❌ [sendTelegramMessage] Exception:", error);
    return false;
  }
}

export async function sendTelegramDocument(
  chatId: number,
  document: Buffer,
  filename: string,
  caption?: string
): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error("TELEGRAM_BOT_TOKEN not set");
    return false;
  }

  try {
    const formData = new FormData();
    formData.append("chat_id", chatId.toString());
    const arrayBuffer = document.buffer.slice(document.byteOffset, document.byteOffset + document.byteLength) as ArrayBuffer;
    formData.append("document", new Blob([arrayBuffer]), filename);
    if (caption) {
      formData.append("caption", caption);
    }

    const response = await fetch(
      `https://api.telegram.org/bot${token}/sendDocument`,
      {
        method: "POST",
        body: formData,
      }
    );

    const result = await response.json() as any;
    return result.ok === true;
  } catch (error) {
    console.error("Error sending Telegram document:", error);
    return false;
  }
}
