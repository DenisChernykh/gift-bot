# Immediate results and post-publication reroll

**Status:** approved

**Date:** 2026-08-09

## Problem

Manual review can reveal that a selected winner is a bot or a suspicious account. If this review is placed before publication, every participant waits for the administrator and the automatic deadline loses its product meaning.

## Decision

The initial draw is final enough to publish immediately. After the eligibility checks defined for the draw succeed, the bot saves the immutable snapshot and selected places, moves the giveaway to `completed`, and updates every contest post without waiting for a human decision.

Manual bot or suspicious-account review happens after publication. A team member may reject one occupied place with an internal reason and continue through the already saved random order. The snapshot is never rebuilt, the draw is not restarted, and all other places stay unchanged.

After a successful replacement, the bot edits the original contest posts in place. Public posts contain only the current winners and empty places. They do not mark the result as preliminary and do not expose the previous winner, rejection reason, or reroll count. The internal append-only audit log preserves the operator, reason, old and new winner, timestamps, and synchronization outcome.

## State and failure boundaries

- There is no `pending_review` state and no administrator approval between `drawing` and `completed`.
- Human suspicion does not retroactively invalidate the immutable snapshot; it starts a normal single-place reroll.
- Automatic bot detection and CAPTCHA remain outside MVP.
- A replacement is committed atomically before Telegram post synchronization. Failed edits remain durable synchronization work and do not restore the rejected winner.
- Unknown eligibility for the next candidate leaves the current published winner and cursor unchanged until a safe retry.

## Acceptance consequences

- The original result is visible immediately after the automatic draw completes.
- An administrator can replace a published suspected bot without changing other winners.
- Every contest post converges to the same current result.
- The public result never exposes internal moderation history; the team audit log does.
