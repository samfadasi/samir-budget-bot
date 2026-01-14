import { Mastra } from "@mastra/core";
import { MastraError } from "@mastra/core/error";
import { PinoLogger } from "@mastra/loggers";
import { LogLevel, MastraLogger } from "@mastra/core/logger";
import pino from "pino";
import { NonRetriableError } from "inngest";
import { z } from "zod";

import { sharedPostgresStorage } from "./storage";
import { inngest, inngestServe } from "./inngest";

import { accountingAgent } from "./agents/accountingAgent";
import { accountingWorkflow } from "./workflows/accountingWorkflow";
import { registerTelegramTrigger } from "../triggers/telegramTriggers";
import { createDashboardRoutes } from "../dashboard";

class ProductionPinoLogger extends MastraLogger {
  protected logger: pino.Logger;

  constructor(
    options: {
      name?: string;
      level?: LogLevel;
    } = {},
  ) {
    super(options);

    this.logger = pino({
      name: options.name || "app",
      level: options.level || LogLevel.INFO,
      base: {},
      formatters: {
        level: (label: string, _number: number) => ({
          level: label,
        }),
      },
      timestamp: () => `,"time":"${new Date(Date.now()).toISOString()}"`,
    });
  }

  debug(message: string, args: Record<string, any> = {}): void {
    this.logger.debug(args, message);
  }

  info(message: string, args: Record<string, any> = {}): void {
    this.logger.info(args, message);
  }

  warn(message: string, args: Record<string, any> = {}): void {
    this.logger.warn(args, message);
  }

  error(message: string, args: Record<string, any> = {}): void {
    this.logger.error(args, message);
  }
}

export const mastra = new Mastra({
  storage: sharedPostgresStorage,
  workflows: { accountingWorkflow },
  agents: { accountingAgent },
  bundler: {
    externals: [
      "@slack/web-api",
      "inngest",
      "inngest/hono",
      "hono",
      "hono/streaming",
      "pg",
      "pdfkit",
    ],
    sourcemap: true,
  },
  server: {
    host: "0.0.0.0",
    port: Number(process.env.PORT ?? 5000),
    middleware: [
      async (c, next) => {
        const mastra = c.get("mastra");
        const logger = mastra?.getLogger();
        logger?.debug("[Request]", { method: c.req.method, url: c.req.url });
        try {
          await next();
        } catch (error) {
          logger?.error("[Response]", {
            method: c.req.method,
            url: c.req.url,
            error,
          });
          if (error instanceof MastraError) {
            if (error.id === "AGENT_MEMORY_MISSING_RESOURCE_ID") {
              throw new NonRetriableError(error.message, { cause: error });
            }
          } else if (error instanceof z.ZodError) {
            throw new NonRetriableError(error.message, { cause: error });
          }

          throw error;
        }
      },
    ],
    apiRoutes: [
      {
        path: "/api/inngest",
        method: "ALL",
        createHandler: async ({ mastra }) => inngestServe({ mastra, inngest }),
      },
      {
        path: "/dashboard/*",
        method: "ALL",
        createHandler: async () => {
          const dashboardApp = createDashboardRoutes();
          return async (c: any) => {
            const path = c.req.path.replace("/dashboard", "") || "/";
            const newRequest = new Request(
              new URL(path, c.req.url),
              c.req.raw
            );
            return dashboardApp.fetch(newRequest, c.env);
          };
        },
      },
      ...registerTelegramTrigger({
        triggerType: "telegram/message",
        handler: async (mastra, triggerInfo) => {
          const logger = mastra.getLogger();
          logger?.info("🚀 [Telegram Trigger] Starting workflow", {
            telegramUserId: triggerInfo.params.telegramUserId,
            messageType: triggerInfo.params.messageType,
          });

          const run = await accountingWorkflow.createRunAsync();
          
          await inngest.send({
            name: `workflow.${accountingWorkflow.id}`,
            data: {
              runId: run?.runId,
              inputData: {
                telegramUserId: triggerInfo.params.telegramUserId,
                userName: triggerInfo.params.userName,
                firstName: triggerInfo.params.firstName,
                lastName: triggerInfo.params.lastName,
                chatId: triggerInfo.params.chatId,
                messageId: triggerInfo.params.messageId,
                messageType: triggerInfo.params.messageType,
                message: triggerInfo.params.message,
                fileId: triggerInfo.params.fileId,
                fileName: triggerInfo.params.fileName,
                mimeType: triggerInfo.params.mimeType,
                caption: triggerInfo.params.caption,
              },
            },
          });

          logger?.info("✅ [Telegram Trigger] Workflow started", {
            runId: run?.runId,
          });
        },
      }),
    ],
  },
  logger:
    process.env.NODE_ENV === "production"
      ? new ProductionPinoLogger({
          name: "Mastra",
          level: "info",
        })
      : new PinoLogger({
          name: "Mastra",
          level: "info",
        }),
});

if (Object.keys(mastra.getWorkflows()).length > 1) {
  throw new Error(
    "More than 1 workflows found. Currently, more than 1 workflows are not supported in the UI, since doing so will cause app state to be inconsistent.",
  );
}

if (Object.keys(mastra.getAgents()).length > 1) {
  throw new Error(
    "More than 1 agents found. Currently, more than 1 agents are not supported in the UI, since doing so will cause app state to be inconsistent.",
  );
}
