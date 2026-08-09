# Epic 5 — macOS LaunchAgent operations design

**Status:** approved

**Date:** 2026-08-09

## Problem

The bot currently runs only while somebody keeps a terminal process alive. Epic 3 can recover a missed deadline after restart, but it does not arrange that restart. A production token in the existing checkout would also be easy to confuse with smoke configuration and a hand-written plist would be difficult to audit or reproduce.

## Decision

Epic 5 adds a repo-owned, per-user macOS LaunchAgent interface around the existing compiled long-polling process. It does not add a second runtime, scheduler, queue or deployment target.

The job label is `ru.strelchuk.giveaways-bot`. It runs in the current user's `gui/<uid>` domain and launches the checked-out `dist/index.js` with an absolute compatible Node path. `RunAtLoad` starts it when the job is loaded, `KeepAlive` restarts unsuccessful exits, and a throttle interval bounds crash loops.

Production state is outside the checkout:

- config: `~/Library/Application Support/StrelchukGiveawaysBot/production.env`;
- SQLite: `~/Library/Application Support/StrelchukGiveawaysBot/data/gift-bot.sqlite`;
- stdout/stderr: `~/Library/Logs/StrelchukGiveawaysBot/`;
- plist: `~/Library/LaunchAgents/ru.strelchuk.giveaways-bot.plist`.

The plist contains the path to the config, not its secret values. It uses `ProgramArguments`, `WorkingDirectory`, `StandardOutPath`, `StandardErrorPath` and string-only environment values. `DOTENV_CONFIG_PATH` points to the absolute production env path supported by the existing `dotenv/config` import. No token or allowlist appears in plist, process arguments or logs.

## Operations boundary

A single interface exposes `install`, `start`, `stop`, `restart`, `status`, `logs` and `uninstall`.

`install` validates all prerequisites before writing or bootstrapping. It refuses to replace an existing plist or loaded service implicitly. `stop` performs `bootout` so KeepAlive cannot undo a maintenance stop. `start` bootstraps the existing plist. `restart` is the explicit bootout/bootstrap pair. `status` uses `launchctl print` success only as diagnostic evidence and does not parse its unstable text as a durable API. `uninstall` removes only the service registration and plist.

The CLI never deletes production env, SQLite or logs. It has no purge mode.

## Preflight and side-effect ordering

Before plist creation, preflight verifies macOS, modern launchctl commands, repository Node/pnpm contracts, a successful build, the production env and restrictive permissions, required variables, an absolute database path outside the checkout, the expected production username through read-only `getMe`, and an unloaded target label.

All checks finish before the first LaunchAgent mutation. Directory creation is allowed only after configuration validation. The plist is rendered to a temporary sibling, validated with `plutil -lint`, and atomically renamed before `launchctl bootstrap`.

If bootstrap fails, the validated plist remains for diagnosis and the command exits nonzero. It does not claim the bot is running. A subsequent explicit `start` is the recovery path after the cause is fixed.

## Lifecycle and failure model

The existing SIGTERM handling remains authoritative for graceful shutdown: stop polling, stop update admission, drain in-flight work and close SQLite last. Updating code therefore requires an explicit stop, update/install if required, full gate/build, start and status/log check.

LaunchAgent guarantees apply only while the user has a GUI login and the Mac is awake. Sleep, shutdown and network loss are normal outages. On the next successful start, the Epic 3 recovery path processes overdue draws and pending synchronization. Epic 5 must not duplicate or weaken that logic.

Permanent configuration or token failures can still create repeated unsuccessful starts. Preflight prevents known install-time causes, while launchd throttling and stderr provide bounded diagnosis. The design does not add alerting or automatic credential repair.

Only one production polling process is supported. Manual `pnpm dev` or `pnpm start` with the same token must be stopped before bootstrap. The operations interface does not attempt to discover or kill arbitrary user processes.

## Verification

Pure tests cover plist rendering, XML escaping, path resolution, secret exclusion, preflight ordering and command-runner error paths. Integration tests use an isolated temporary HOME and a fake launchctl runner; they do not mutate the user's real LaunchAgents. `plutil -lint` validates a generated temporary plist on macOS.

Real evidence is separate: install in the actual GUI domain, observe `bot_started`, inspect status and logs, perform graceful restart, force one crash to observe throttled recovery, stop, start, and uninstall while proving config/database/log preservation. A final recovery smoke lets a short deadline pass while the job is stopped and confirms Epic 3 processing after start.

## Scope boundary

Epic 5 is not a LaunchDaemon, server deployment, Docker setup, backup system, log-rotation service, remote monitor, auto-updater or secret manager. It does not configure the Telegram profile. Keeping it as a local operations adapter makes it removable without changing product behavior.
