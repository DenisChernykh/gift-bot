# Epic 2 Participants and Referrals Implementation Plan

**Goal:** Replace the temporary `join_` boundary with complete participant registration, optional direct referrals, a public participant counter, and durable channel-health warnings.

**Baseline:** Local branch `feat/epic-02-participants-and-referrals` starts at `d526dab2497fed5f9aa3243491ff4469bec0c6ce`. Node stays `24.18.1`, pnpm stays `11.15.1`, and no dependency is added. Push, PR creation and real Telegram actions are excluded.

**Architecture:** Thin grammY routes call application services. SQLite owns participant identity, referral relations, callback actor binding, alert deduplication and sync-task coalescing. Telegram reads fail closed. One serialized synchronizer owns both participant-count and cancellation edits; notification delivery uses a separate durable alert queue coordinated by runtime maintenance.

## Task 1: Data and pure rules

- Add `participants`, unique by `giveaway_id + telegram_user_id`, with nullable username and immutable identity, `joined_at`, and inviter.
- Enforce same-giveaway inviter relations with a composite foreign key.
- Add hash-only `referral_tokens` and deduplicated `channel_health_alerts`.
- Extend `sync_tasks` with `available_at` and `last_error_kind`; allow only one coalesced `participant_count` task per giveaway post.
- Add membership normalization and `1 + floor(validDirectReferrals / 3)`.
- Make the canonical post renderer include `Зарегистрировано участников: 0`; validate capacity using `Number.MAX_SAFE_INTEGER`.
- Recheck Node/pnpm and generate migration `0006` through `pnpm db:generate`.

## Task 2: Participant registration and referrals

- Resolve `join_` and `ref_` only from token hashes; never persist or log raw tokens.
- For a new participant, sequentially verify that the bot is still administrator and the user is `creator`, `administrator`, `member`, or `restricted/is_member=true` in every channel.
- Fail closed for errors, unknown status, `left`, `kicked`, or lost bot rights. Do not auto-retry interactive calls; surface `retry_after` for `429`.
- Before insert, transactionally recheck active state, deadline, referral mode, same-giveaway inviter, strict earlier `joinedAt`, and self-referral.
- Insert the participant and coalesce counter tasks atomically. Existing participants only refresh profile fields and retain first registration/inviter.
- Keep retry callbacks actor-bound. Store only internal `giveawayId` and inviter candidate; allow consumed callback replay as an idempotent status-view.
- Issue a new opaque personal link on every successful status-view when referrals are enabled; keep older links active until giveaway closure.

## Task 3: Telegram UI, synchronization and alerts

- Show every missing public channel as a separate URL plus a fresh retry button.
- Show registered status, total participants, direct-referral progress, current ticket formula and a personal link when enabled.
- Update all dirty posts through one serialized durable synchronizer, preserving text/caption entities and the existing participation button.
- Throttle completed counter edits for 60 seconds, retain per-post retry after partial failures, and honor Telegram `429`.
- Let cancellation supersede counter work, revoke join/referral links, remove the participation button, and remain the final edit.
- Recover interrupted tasks before polling, prohibit overlapping maintenance passes, and await the active pass before SQLite close.
- Deduplicate bot-rights alerts, retry creator notifications until accepted, close the alert after a successful later check, and expose active warnings in creator-only `/giveaways`.

## Task 4: Verification and documentation

- Cover membership states, errors, token/deadline/cancellation races, concurrency, immutable inviter, self/cross referral, missing username, callback replay, ticket formula, coalescing, throttle, partial edit, restart, cancellation priority, entities, limits and alerts.
- Verify clean migration, idempotent reapply, populated `0005` upgrade, `integrity_check` and `foreign_key_check`.
- Run focused suites, `pnpm check`, `git diff --check`, and exact path/status inventory.
- Keep automated, local migration/build and Telegram smoke evidence separate. Telegram smoke is `NOT RUN` because no `.env` or test database is available and it is outside this delivery criterion.

## Independent review protocol

- Review the exact range `d526dab2497fed5f9aa3243491ff4469bec0c6ce..HEAD` read-only against Epic 2 requirements and exclusions.
- Findings use P0–P3 and verdict `PASS`, `FIX WAVE REQUIRED`, or `BLOCKED ON EVIDENCE`.
- Apply one consolidated fix wave and rerun review. If new findings remain, apply a second wave and run a third and final review.
- Stop early on `PASS`. Never start a fourth cycle; after review three, fix only deterministic local findings, rerun the final gate, and disclose that no post-fix independent review exists. A new product or architecture decision is a blocker.

## Explicit boundaries

Epic 3 retains final eligibility, snapshot, tickets, draw, results and reroll. Epic 2 does not add CAPTCHA, private channels, exports, mailings, web/API, second-level referrals, new dependencies, push, PR or real Telegram mutations.
