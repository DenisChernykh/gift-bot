# Epic 3 Draw and Reroll Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically complete due giveaways, publish an immutable draw result immediately, and let the team replace one published winner without changing the other places.

**Architecture:** A serialized maintenance coordinator atomically claims due giveaways, performs bounded fail-closed Telegram eligibility checks, and persists one immutable JSON snapshot plus the complete shuffled ticket order. SQLite transactions own winner versions, reroll exclusions, idempotency and outbox state; the existing post synchronizer publishes only the latest result revision.

**Tech Stack:** Node 24.18.x, TypeScript ESM, grammY 1.45, Drizzle ORM, `node:sqlite`, Vitest 4.

## Global Constraints

- Start from `ccabf12330ec82f0ad3d72228fd63c1811dcf79f` on `feat/epic-03-draw-and-reroll`.
- Keep Epic 1 and Epic 2 behavior compatible and add no dependency.
- Publish the initial result before any human winner review; never add `pending_review`.
- Keep the snapshot and ticket order immutable; reroll advances the saved order and changes one place only.
- Keep old winners, reasons, referral counts, ticket order and reroll history private.
- Do not merge, push or create a PR.

---

### Task 1: Immutable draw domain and storage

**Files:**
- Create: `src/domain/giveaway-draw.ts`
- Create: `src/application/ports/draw-repository.ts`
- Create: `src/database/draw-repository.ts`
- Modify: `src/database/schema.ts`
- Test: `tests/domain/giveaway-draw.test.ts`
- Test: `tests/database/draw-repository.test.ts`

**Interfaces:**
- Produces `createDrawSnapshot`, `selectInitialWinners`, `advanceReroll`, and `DrawRepository` atomic claim/snapshot/reroll operations.
- Persists one immutable versioned snapshot, full ticket order, result revision, place versions, exclusions, reroll audit/session state and durable notifications.

- [ ] Write and run failing domain tests for ticket calculation, injected Fisher-Yates, unique winners, empty places and reroll cursor.
- [ ] Implement the minimal pure domain model and rerun focused tests.
- [ ] Write and run failing SQLite tests for atomic claim, immutable snapshot, restart, failed retry, result revisions and transactional reroll.
- [ ] Add schema/repository implementation, generate the Drizzle migration, and rerun focused database tests.

### Task 2: Automatic completion and recovery

**Files:**
- Create: `src/application/giveaway-draw-service.ts`
- Modify: `src/application/gift-bot-maintenance-service.ts`
- Modify: `src/runtime/gift-bot-runtime.ts`
- Modify: `src/index.ts`
- Test: `tests/application/giveaway-draw-service.test.ts`
- Test: `tests/runtime/bot-runtime.test.ts`

**Interfaces:**
- Consumes `DrawRepository`, `TelegramGateway`, injected clock/random/sleep and concurrency `DRAW_MEMBERSHIP_CONCURRENCY` defaulting to `10`.
- Produces startup recovery, one-minute due-draw ticks, manual failed-draw retry and shutdown drain.

- [ ] Write and run failing service tests for final eligibility, concurrency, `429`, network/5xx attempts, channel-rights failure and snapshot reuse.
- [ ] Implement fail-closed bounded checking and completion orchestration; rerun focused tests.
- [ ] Write and run failing runtime tests for startup recovery, serialized ticks and shutdown wait.
- [ ] Wire the draw service into maintenance/runtime/composition and rerun focused tests.

### Task 3: Result rendering, synchronization and notifications

**Files:**
- Create: `src/domain/giveaway-result-rendering.ts`
- Modify: `src/application/ports/post-synchronization-repository.ts`
- Modify: `src/application/giveaway-post-synchronization-service.ts`
- Modify: `src/database/post-synchronization-repository.ts`
- Modify: `src/application/ports/telegram-gateway.ts`
- Modify: `src/infrastructure/grammy-telegram-gateway.ts`
- Test: `tests/domain/giveaway-result-rendering.test.ts`
- Test: `tests/application/post-synchronization-service.test.ts`
- Test: `tests/infrastructure/grammy-telegram-gateway.test.ts`

**Interfaces:**
- Adds latest-wins `result` synchronization ahead of participant counts and durable winner/team notification delivery.
- Extends `TelegramDeliveryError` with `rate_limited | server | network | client` while retaining `retryAfterMs`.

- [ ] Write and run failing rendering tests for username, `tg://user?id`, empty/no-participant results and private-data exclusion.
- [ ] Implement rendering and rerun focused tests.
- [ ] Write and run failing synchronization/gateway tests for result priority, latest revision, text/photo edit, blocked DM and retry classification.
- [ ] Implement synchronization/outbox delivery and rerun focused tests.

### Task 4: Administrator retry, reroll and audit UI

**Files:**
- Create: `src/application/giveaway-reroll-service.ts`
- Modify: `src/application/giveaway-management-service.ts`
- Modify: `src/telegram/gift-bot-adapter.ts`
- Test: `tests/application/giveaway-reroll-service.test.ts`
- Test: `tests/telegram/gift-bot-adapter.test.ts`

**Interfaces:**
- Adds actor-bound draw retry, occupied-place selection, persisted 3–500 character reason entry, confirmation, idempotent reroll result and private audit listing.

- [ ] Write and run failing service tests for reason validation, subscription skips, unknown eligibility rollback, single-place replacement, exhaustion and callback replay.
- [ ] Implement reroll application flow and rerun focused tests.
- [ ] Write and run failing adapter tests for `/giveaways`, retry, reason/confirmation flow, occupied-place rules and team-only audit.
- [ ] Wire callbacks/text handling and rerun adapter tests.

### Task 5: Verification, independent review and evidence

**Files:**
- Create: `docs/verification/2026-08-09-epic-03.md`

- [ ] Verify Node/pnpm, focused suites, clean/populated/repeated migrations, SQLite integrity, `pnpm check`, `git diff --check` and tracked-scope inventory.
- [ ] Run the real Telegram smoke with a stopped deadline, startup completion, two channels, two sequential rerolls and restart recovery; keep secrets unprinted and evidence categories separate.
- [ ] Dispatch a fresh independent reviewer against `ccabf12..HEAD`; classify P0–P3 and apply one consolidated fix wave when required.
- [ ] After any first fix wave, dispatch a second fresh reviewer; after second-wave fixes dispatch a third and final reviewer. Stop early on `PASS` and never run a fourth cycle.
- [ ] Rerun the complete final gate after all reviewed fixes and record exact evidence and any unreviewed post-cycle-3 fix honestly.
