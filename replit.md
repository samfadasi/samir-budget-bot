# Replit.md

## Overview

This project is an AI-powered automation system built with Mastra, a TypeScript framework for building AI agents and workflows. The system creates durable, event-driven automations triggered by webhooks (Telegram, Slack) or cron schedules. The primary use case appears to be an accounting bot that processes messages, photos, voice notes, and documents via Telegram.

The architecture uses Inngest for durable workflow execution, ensuring automations can survive failures and resume from where they left off. Mastra provides the agent/workflow framework, while various storage backends (PostgreSQL, LibSQL) handle persistence.

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

### Core Framework: Mastra
- **Agents**: AI entities with instructions, tools, and memory that use LLMs to solve tasks
- **Workflows**: Graph-based orchestration for multi-step processes with branching, parallel execution, and suspend/resume capabilities
- **Tools**: Functions agents can call to interact with external APIs or run custom logic
- **Memory**: Conversation history, semantic recall, and working memory for context management

### Durability Layer: Inngest
- All workflows run through Inngest for fault tolerance and resumability
- Custom integration in `src/mastra/inngest/` handles the bridge between Mastra and Inngest
- Step-by-step memoization means failed workflows resume from last successful step
- The `inngestServe` function registers Mastra workflows as Inngest functions

### Trigger System
- **Webhook triggers**: Handle external events from services like Telegram, Slack, Linear
- **Cron triggers**: Time-based scheduling for recurring automations
- Triggers are registered in `src/mastra/index.ts` before Mastra initialization
- Webhook handlers validate payloads and start workflows via `workflow.createRunAsync()`

### Storage
- Uses `@mastra/pg` (PostgreSQL) and `@mastra/libsql` for persistence
- Shared storage configured in `src/mastra/storage.ts`
- Stores workflow state, conversation threads, and memory data

### Key Patterns
1. **Workflow steps use `generateLegacy()`**: Required for Replit Playground UI compatibility
2. **Agents must be registered**: Add agents to the Mastra instance in `src/mastra/index.ts`
3. **Trigger files export registration functions**: Spread into `apiRoutes` array for webhooks
4. **Input/output schemas use Zod**: Type-safe validation throughout

### Entry Point Structure
```
src/mastra/index.ts     - Main Mastra instance, agent/workflow registration
src/mastra/inngest/     - Inngest client and serve configuration
src/mastra/agents/      - Agent definitions
src/mastra/workflows/   - Workflow definitions
src/mastra/tools/       - Tool definitions
src/triggers/           - Webhook and cron trigger handlers
```

## External Dependencies

### AI/LLM Providers
- **OpenAI** (`@ai-sdk/openai`, `openai`): Primary LLM provider
- **OpenRouter** (`@openrouter/ai-sdk-provider`): Alternative model routing
- **Vercel AI SDK** (`ai`): Model interface layer

### Workflow Orchestration
- **Inngest** (`inngest`, `@mastra/inngest`, `@inngest/realtime`): Durable workflow execution and real-time updates

### Storage & Database
- **PostgreSQL** (`pg`, `@mastra/pg`): Primary database for production
- **LibSQL** (`@mastra/libsql`): Alternative lightweight storage
- **Drizzle** (`drizzle-zod`): Schema validation for database models

### External Service Integrations
- **Telegram** (`src/triggers/telegramTriggers.ts`): Bot webhook handling for messages, photos, voice, documents
- **Slack** (`@slack/web-api`, `src/triggers/slackTriggers.ts`): Slack bot integration
- **Exa** (`exa-js`): Search/research API

### Utilities
- **Zod** (`zod`, `zod-validation-error`): Schema validation
- **Pino** (`pino`, `@mastra/loggers`): Structured logging
- **dotenv**: Environment variable management
- **p-limit**, **p-retry**: Concurrency and retry utilities

## Recent Changes

### 2026-01-14: Major Feature Upgrade - Budget Alerts, Smart Notifications, PDF Reports, Dashboard

#### New Features Added (Feature-Flagged):
1. **Budget Alert System** (always enabled)
   - Automatic alerts at 80% and 100% budget thresholds
   - Alerts sent only once per threshold per budget period
   - New tool: `check-budget-and-alert` in `src/mastra/tools/alertTools.ts`
   - Alerts logged to `alerts_log` database table

2. **Smart Alerts** (ENABLE_SMART_ALERTS=true)
   - AI-powered anomaly detection with explanations
   - Uses OpenAI to generate actionable alert messages
   - New tool: `send-smart-alert` in `src/mastra/tools/alertTools.ts`
   - Deduplication via transaction_id in alerts_log

3. **PDF Reports** (ENABLE_PDF_REPORTS=true)
   - Professional PDF expense reports via pdfkit
   - New tool: `generate-pdf-report` in `src/mastra/tools/exportTools.ts`
   - Reports logged to `reports_log` database table
   - PDF sent as Telegram document attachment

4. **Web Dashboard** (ENABLE_DASHBOARD=false by default)
   - REST API endpoints for dashboard data at `/dashboard/*`
   - Token-based authentication via DASHBOARD_ACCESS_TOKEN
   - Endpoints: /overview, /transactions, /budgets, /alerts, /reports
   - Implemented in `src/dashboard/index.ts`

#### New Database Tables:
- `alerts_log`: Tracks budget and anomaly alerts with deduplication
- `reports_log`: Tracks generated reports (text, CSV, PDF)

#### New Commands:
- `/export pdf`: Generate and send PDF report
- `/alerts`: Show recent alerts history
- `/report daily|weekly|monthly`: Generate reports by period

### 2026-01-14: Fixed saveTransaction PostgreSQL Type Inference Bug
- **Issue**: PostgreSQL prepared statement caching caused "inconsistent types deduced for parameter $2" errors when vendor_id and duplicate_of_id parameters alternated between null and integer values
- **Root Cause**: Neon PostgreSQL backend uses prepared statement pooling which infers types from first usage; subsequent calls with different types (null vs number) caused type conflicts
- **Fix**: Added explicit SQL type casts (::integer, ::text, ::date, ::numeric, ::boolean) to all INSERT parameters in `src/mastra/tools/databaseTools.ts`
- **Pattern**: When working with nullable integer columns in PostgreSQL pooled connections, always use explicit type casts to prevent type inference issues

## Feature Flags

| Flag | Default | Description |
|------|---------|-------------|
| ENABLE_SMART_ALERTS | true | AI-powered anomaly detection with Telegram notifications |
| ENABLE_PDF_REPORTS | true | PDF report generation and export |
| ENABLE_DASHBOARD | false | Web dashboard API (requires DASHBOARD_ACCESS_TOKEN) |

## Known Issues & Deployment Notes

### Production Deployment
- The bot is configured with webhook URL: `https://aibudget-bot.replit.app/webhooks/telegram/action`
- After code changes, redeploy to see changes reflected in the Telegram bot
- Use `mastra build` to create production bundle in `.mastra/output/`