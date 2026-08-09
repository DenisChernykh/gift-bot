# Epic 4 — Production bot identity and Telegram UX design

**Status:** approved

**Date:** 2026-08-09

## Problem

The implemented bot completes the MVP workflow, but its Telegram profile still uses smoke-test metadata and a default letter avatar. The `/start` response also exposes the internal `Gift Bot` name. A participant cannot distinguish the bot from a temporary test account, and an operator has no reproducible way to apply the intended profile without risking the smoke bot.

## Decision

Epic 4 owns production identity and presentation only. It introduces a guarded, one-shot profile configuration operation and a bounded Telegram-copy pass. It does not change giveaway states, authorization, registration, publication, drawing or reroll behavior.

The production identity is:

- username: `@strelchuk_giveaways_bot`;
- display name: `Розыгрыши Татьяны Стрельчук`;
- short description: `Официальный бот розыгрышей Татьяны Стрельчук`;
- full description: `Официальный бот розыгрышей Татьяны Стрельчук. Помогает проверить условия участия, зарегистрироваться и узнать результат. Управление розыгрышами доступно только команде.`;
- avatar: the selected warm coral ribbon-and-spark concept.

The full description explains participation, condition checks and results, and states that management is limited to the team. The exact string must stay within the Telegram limit and must not advertise out-of-scope capabilities.

## Profile configuration boundary

Profile configuration is not part of normal application startup. A dedicated operation receives the production configuration, validates the source and upload assets, calls `getMe`, and compares the returned username with the compile-time target before any write.

Only an exact `strelchuk_giveaways_bot` match unlocks the following idempotent steps:

1. set display name;
2. set description;
3. set short description;
4. set default commands;
5. set an operator-specific command scope for each allowlisted Telegram ID;
6. upload the static JPG profile photo.

Telegram does not make these calls transactional. The operation therefore validates every local prerequisite first, stops on the first remote failure, reports the failed step without request bodies or secrets, and relies on a safe rerun to converge partial remote state.

The selected PNG is the visual source of truth. A checked-in JPG derivative satisfies the current static profile-photo contract. Generation or conversion is an implementation-time asset step, not an implicit runtime transformation.

## Command scopes and copy

The default scope contains only `/start`, so ordinary participants do not see administrative affordances. Each allowlisted operator gets a specific private-chat scope containing `/start`, `/new`, `/giveaways` and `/cancel`.

The copy pass replaces test branding and touched technical phrases with concise Russian product language. `/start` without a payload becomes role-aware: an ordinary user is told to enter through the contest post's `Участвовать` button, while an operator receives the branded command summary. Existing deep-link responses run before that branch. Wizard transitions and callback security remain unchanged unless a wording change is necessary to remove test branding or an internal implementation term.

Copy remains honest about failure states. It does not hide an actionable error, promise guaranteed delivery, call a result preliminary, or add a moderation gate before publication.

## Failure model

- Wrong username, inaccessible asset, invalid JPG or missing configuration fails before remote writes.
- A Telegram write failure leaves a possibly partial profile and a named failed step; rerun is the recovery action.
- A failure never prints token, raw request, allowlist or deep-link payloads.
- The smoke bot remains an explicit negative test target and must never pass the production username guard.
- Runtime startup remains independent from profile availability after the initial setup.

## Verification

Automated verification covers pure target payloads, username guarding, call ordering, partial-failure behavior, command scopes and touched adapter copy. Asset verification covers square dimensions, JPG format and a small circle-crop review. The full repository gate remains required.

Real Telegram evidence is separate: use the new production token, confirm `getMe`, inspect profile metadata and avatar, compare participant and operator command menus, and exercise `/start`. No test result may claim that remote Telegram state changed without this smoke.

## Scope boundary

Epic 4 does not create the bot through BotFather, operate the Mac process, install launchd, redesign the wizard, add a Mini App or modify giveaway business rules. Those boundaries keep production identity independently reviewable and prevent profile automation from becoming a deployment system.
