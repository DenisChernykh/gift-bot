# Epic 1 Giveaway Creation Implementation Plan

**Goal:** Deliver the first production-ready Gift Bot vertical slice: an allowlisted team member can persist a draft, connect own and external public channels, publish it safely, and cancel it.

**Architecture:** ESM TypeScript runs a single grammY long-polling process. Thin Telegram handlers call application services that persist state through Drizzle on `node:sqlite`; conversations are modelled explicitly in database tables, and Telegram operations pass through an injected gateway.

**Tech stack:** Node 24, pnpm 11, TypeScript, grammY, Drizzle ORM and Kit, `node:sqlite`, date-fns timezone tools, Vitest, ESLint.

## Global constraints

- `BOT_TOKEN`, `TEAM_TELEGRAM_IDS`, `DATABASE_PATH`, and `LOG_LEVEL` stay local and are documented only in `.env.example`.
- The product timezone is `Asia/Yekaterinburg`; stored timestamps are UTC epoch milliseconds.
- Telegram user/chat identifiers remain safe integer values and all public deep-link payloads are opaque base64url strings of at most 64 characters.
- Invitation tokens use 32 random bytes and only their SHA-256 hash is stored.
- A Telegram action is retried only if the prior delivery is known not to have happened; unknown send outcomes fail closed.
- Epic 1 creates join-token links but never creates a participant record.

### Task 1: Bootstrap, configuration, database, and pure domain rules

Create the Node/pnpm project, `.node-version`, strict TypeScript, lint/test/build scripts, `.env.example`, and Drizzle migration wiring. Add the SQLite schema for giveaways, wizard sessions, channels, invites, pending connections, opaque callback actions, join tokens, publication runs/deliveries, and sync tasks. Enable foreign keys, WAL, busy timeout, and defensive mode.

Write tests first for allowlist parsing, giveaway title/winner/date/content validation, timezone round trips, final rendered message limits, token creation/hashing, state transitions, and administrator-right checks. Implement only the domain/config/database code required to pass them.

### Task 2: Draft wizard and channel-authorization services

Write tests first for one active wizard per team member, restart-safe draft progress, `/new` resume semantics, callback actor binding, own-channel pending context, external invite expiry/consumption/revocation, and channel uniqueness. Implement application services and repository methods for those behaviours.

The wizard order is title, winner count, deadline, referrals, content, channels, then preview. A public channel requires a username and bot rights `post_messages`, `edit_messages`, and `delete_messages`. Switching a pending external invitation needs an explicit confirmation and must not revoke the previous invitation.

### Task 3: grammY adapter, publication, cancellation, and recovery

Write tests first using a fake `TelegramGateway` for authorization on every admin command/callback, `/start`, `/new`, `/giveaways`, `/cancel`, `my_chat_member`, publication to two channels, rollback in reverse order, 429 handling, unknown send outcomes, duplicate callbacks, startup recovery, and durable cancellation synchronization.

Implement grammY routing and UI text/keyboards. Persist a publication delivery intent before sending, its message ID afterwards, and activate only after every delivery is saved. On a definite send failure delete known messages in reverse order; on an unknown outcome mark failed and do not resend. Set `cancelled` before editing published posts; persist failed edits as sync tasks.

### Task 4: Documentation, verification, and manual Telegram evidence

Update the PRD and Epic 1 with the internal title, rendered-length rule, and explicit Epic 2 join boundary. Add an operator runbook and a verification record template separating automated, local runtime, and Telegram evidence.

Run `pnpm check`, a real configured startup, and the full two-account Telegram smoke. Create the bot token and grant bot administrator rights only after an action-time user confirmation. Exercise own/external channels, unauthorized `/new`, restart in wizard, text/photo publishing, duplicate publish, preflight-right failure, and cancellation.
