# Epic 4 Production Bot Identity and Telegram UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `@strelchuk_giveaways_bot` the approved production identity, guarded repeatable profile configuration, role-specific command menus, and non-test `/start` copy without changing giveaway behavior.

**Architecture:** Keep immutable profile targets and copy in small Telegram-owned modules. A one-shot operations service validates the exact production username before sequential idempotent Bot API writes; the long-polling runtime never applies profile changes. Adapter changes affect only `/start` without a deep-link payload, while existing join, referral, channel-invite and administrative authorization paths retain their order and semantics.

**Tech Stack:** TypeScript 5.9, Node.js `>=24.18.0 <25`, pnpm `>=11.15.1 <12`, grammY 1.45, Telegram Bot API, Vitest 4, macOS `sips` for the checked-in JPG derivative.

## Global Constraints

- Implement only [Epic 4](../../epics/04-production-bot-identity-and-ux.md); macOS lifecycle and LaunchAgent belong to Epic 5.
- Production username is exactly `strelchuk_giveaways_bot`; the visible handle is `@strelchuk_giveaways_bot`.
- Display name is exactly `Розыгрыши Татьяны Стрельчук`.
- Short description is exactly `Официальный бот розыгрышей Татьяны Стрельчук`.
- Full description is exactly `Официальный бот розыгрышей Татьяны Стрельчук. Помогает проверить условия участия, зарегистрироваться и узнать результат. Управление розыгрышами доступно только команде.`
- Default commands contain only `/start`; each allowlisted private chat receives `/start`, `/new`, `/giveaways`, `/cancel`.
- The selected coral ribbon-and-spark image is the visual source of truth; do not generate a replacement during implementation.
- Profile configuration must call `getMe` and validate the exact username before its first remote write.
- Never log `BOT_TOKEN`, `TEAM_TELEGRAM_IDS`, raw Bot API request bodies, or Telegram error descriptions that may echo request data.
- Do not run the real profile mutation until the user explicitly authorizes the production-token smoke.
- Preserve the existing Node/pnpm `PATH`; invoke the package manager as plain `pnpm`.

## File Map

- Create `assets/telegram/strelchuk-giveaways-avatar-source.png` — selected master artwork.
- Create `assets/telegram/strelchuk-giveaways-avatar.jpg` — static Telegram upload asset.
- Create `src/telegram/production-bot-profile.ts` — immutable metadata, command arrays, asset path and username target.
- Create `src/telegram/gift-bot-copy.ts` — exact role-specific `/start` copy.
- Create `src/operations/telegram-profile-service.ts` — guarded, sequential, idempotent profile application.
- Create `src/operations/configure-telegram-profile.ts` — one-shot composition root and safe process exit reporting.
- Create `tests/telegram/production-bot-profile.test.ts` — metadata, commands and asset contract.
- Create `tests/operations/telegram-profile-service.test.ts` — username guard, call order and partial failure.
- Create `tests/operations/configure-telegram-profile.test.ts` — local JPG preflight and safe error projection.
- Modify `src/telegram/gift-bot-adapter.ts` — role-aware payload-free `/start` only.
- Modify `tests/telegram/gift-bot-adapter.test.ts` — public/admin start expectations and unchanged authorization.
- Modify `package.json` — add the one-shot `profile:apply` script.
- Modify `README.md` — production profile setup and evidence boundary.
- Create `docs/verification/2026-08-09-epic-04.md` — separate automated, local and real Telegram evidence.

---

### Task 1: Lock the approved visual and metadata contract

**Files:**
- Create: `assets/telegram/strelchuk-giveaways-avatar-source.png`
- Create: `assets/telegram/strelchuk-giveaways-avatar.jpg`
- Create: `src/telegram/production-bot-profile.ts`
- Create: `tests/telegram/production-bot-profile.test.ts`

**Interfaces:**
- Produces: `PRODUCTION_BOT_USERNAME`, `PRODUCTION_BOT_PROFILE`, `DEFAULT_BOT_COMMANDS`, `OPERATOR_BOT_COMMANDS`, `PRODUCTION_AVATAR_JPG_PATH`.
- Consumes: selected ImageGen result at `/Users/denischernykh/.codex/generated_images/019fe589-5cde-77d3-a8b6-84503f79747b/exec-51f052a3-46d7-47f8-a732-609857c8e3e6.png`.

- [ ] **Step 1: Write the failing profile contract test**

```ts
import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_BOT_COMMANDS,
  OPERATOR_BOT_COMMANDS,
  PRODUCTION_AVATAR_JPG_PATH,
  PRODUCTION_BOT_PROFILE,
  PRODUCTION_BOT_USERNAME,
} from '../../src/telegram/production-bot-profile.js';

describe('production bot profile', () => {
  it('keeps the approved identity and role-specific command menus exact', () => {
    expect(PRODUCTION_BOT_USERNAME).toBe('strelchuk_giveaways_bot');
    expect(PRODUCTION_BOT_PROFILE).toEqual({
      name: 'Розыгрыши Татьяны Стрельчук',
      shortDescription: 'Официальный бот розыгрышей Татьяны Стрельчук',
      description:
        'Официальный бот розыгрышей Татьяны Стрельчук. Помогает проверить условия участия, зарегистрироваться и узнать результат. Управление розыгрышами доступно только команде.',
    });
    expect(DEFAULT_BOT_COMMANDS).toEqual([
      { command: 'start', description: 'Открыть бот розыгрышей' },
    ]);
    expect(OPERATOR_BOT_COMMANDS).toEqual([
      { command: 'start', description: 'Открыть панель управления' },
      { command: 'new', description: 'Создать розыгрыш' },
      { command: 'giveaways', description: 'Мои розыгрыши' },
      { command: 'cancel', description: 'Отменить розыгрыш или настройку' },
    ]);
  });

  it('ships a real JPG upload asset instead of a runtime substitute', async () => {
    const bytes = await readFile(PRODUCTION_AVATAR_JPG_PATH);
    expect([...bytes.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    expect([...bytes.subarray(-2)]).toEqual([0xff, 0xd9]);
  });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm exec vitest run tests/telegram/production-bot-profile.test.ts`

Expected: FAIL because `src/telegram/production-bot-profile.ts` and the approved assets do not exist.

- [ ] **Step 3: Copy the selected master asset and create the JPG derivative**

Run:

```bash
mkdir -p assets/telegram
cp /Users/denischernykh/.codex/generated_images/019fe589-5cde-77d3-a8b6-84503f79747b/exec-51f052a3-46d7-47f8-a732-609857c8e3e6.png assets/telegram/strelchuk-giveaways-avatar-source.png
sips -s format jpeg -s formatOptions 95 assets/telegram/strelchuk-giveaways-avatar-source.png --out assets/telegram/strelchuk-giveaways-avatar.jpg
sips -g pixelWidth -g pixelHeight assets/telegram/strelchuk-giveaways-avatar-source.png assets/telegram/strelchuk-giveaways-avatar.jpg
```

Expected: both files report `1254` by `1254`; the source artwork remains unchanged.

- [ ] **Step 4: Add the exact immutable target module**

```ts
import { resolve } from 'node:path';

import type { BotCommand } from 'grammy/types';

export const PRODUCTION_BOT_USERNAME = 'strelchuk_giveaways_bot';

export const PRODUCTION_BOT_PROFILE = {
  name: 'Розыгрыши Татьяны Стрельчук',
  shortDescription: 'Официальный бот розыгрышей Татьяны Стрельчук',
  description:
    'Официальный бот розыгрышей Татьяны Стрельчук. Помогает проверить условия участия, зарегистрироваться и узнать результат. Управление розыгрышами доступно только команде.',
} as const;

export const DEFAULT_BOT_COMMANDS = [
  { command: 'start', description: 'Открыть бот розыгрышей' },
] as const satisfies readonly BotCommand[];

export const OPERATOR_BOT_COMMANDS = [
  { command: 'start', description: 'Открыть панель управления' },
  { command: 'new', description: 'Создать розыгрыш' },
  { command: 'giveaways', description: 'Мои розыгрыши' },
  { command: 'cancel', description: 'Отменить розыгрыш или настройку' },
] as const satisfies readonly BotCommand[];

export const PRODUCTION_AVATAR_JPG_PATH = resolve(
  process.cwd(),
  'assets/telegram/strelchuk-giveaways-avatar.jpg',
);
```

- [ ] **Step 5: Run the focused test and inspect the circle crop**

Run:

```bash
pnpm exec vitest run tests/telegram/production-bot-profile.test.ts
sips -Z 80 assets/telegram/strelchuk-giveaways-avatar.jpg --out /private/tmp/strelchuk-giveaways-avatar-80.jpg
```

Expected: PASS; the 80 px preview keeps the coral ribbon and spark recognizable inside an imagined circular crop.

- [ ] **Step 6: Commit the visual and metadata contract**

```bash
git add assets/telegram/strelchuk-giveaways-avatar-source.png assets/telegram/strelchuk-giveaways-avatar.jpg src/telegram/production-bot-profile.ts tests/telegram/production-bot-profile.test.ts
git commit -m "feat: define production bot identity"
```

---

### Task 2: Implement guarded sequential profile application

**Files:**
- Create: `src/operations/telegram-profile-service.ts`
- Create: `tests/operations/telegram-profile-service.test.ts`

**Interfaces:**
- Consumes: all constants from `src/telegram/production-bot-profile.ts` and a grammY `InputFile` supplied by the composition root.
- Produces: `ProductionProfileApi`, `ProfileStep`, `ProfileStepError`, and `applyProductionBotProfile(input): Promise<void>`.

- [ ] **Step 1: Write the wrong-bot and success-order tests**

```ts
import { describe, expect, it, vi } from 'vitest';
import { InputFile } from 'grammy';

import {
  applyProductionBotProfile,
  type ProductionProfileApi,
} from '../../src/operations/telegram-profile-service.js';

function fakeApi(username: string, failAt?: string) {
  const calls: string[] = [];
  const call = async (name: string) => {
    calls.push(name);
    if (name === failAt) throw new Error('raw remote detail');
    return true as const;
  };
  const api: ProductionProfileApi = {
    getMe: async () => {
      calls.push('getMe');
      return { username };
    },
    setMyName: async () => call('setMyName'),
    setMyDescription: async () => call('setMyDescription'),
    setMyShortDescription: async () => call('setMyShortDescription'),
    setMyCommands: async (_commands, options) =>
      call(`setMyCommands:${options.scope.type}`),
    setMyProfilePhoto: async () => call('setMyProfilePhoto'),
  };
  return { api, calls };
}

describe('applyProductionBotProfile', () => {
  it('performs no write when getMe returns the smoke username', async () => {
    const { api, calls } = fakeApi('gift_epic1_smoke_20260808_bot');
    await expect(
      applyProductionBotProfile({
        api,
        operatorTelegramIds: [465050746],
        avatar: new InputFile(new Uint8Array([1])),
      }),
    ).rejects.toThrow('Refusing to configure @gift_epic1_smoke_20260808_bot');
    expect(calls).toEqual(['getMe']);
  });

  it('applies default and per-operator state in deterministic order', async () => {
    const { api, calls } = fakeApi('strelchuk_giveaways_bot');
    const onStep = vi.fn();
    await applyProductionBotProfile({
      api,
      operatorTelegramIds: [700, 701],
      avatar: new InputFile(new Uint8Array([1])),
      onStep,
    });
    expect(calls).toEqual([
      'getMe',
      'setMyName',
      'setMyDescription',
      'setMyShortDescription',
      'setMyCommands:default',
      'setMyCommands:chat',
      'setMyCommands:chat',
      'setMyProfilePhoto',
    ]);
    expect(onStep).toHaveBeenLastCalledWith('profile_photo');
  });
});
```

- [ ] **Step 2: Run the service test and verify RED**

Run: `pnpm exec vitest run tests/operations/telegram-profile-service.test.ts`

Expected: FAIL because the operations service does not exist.

- [ ] **Step 3: Implement the minimal typed service and named failure**

```ts
import type { InputFile } from 'grammy';
import type { BotCommand, BotCommandScope, InputProfilePhoto } from 'grammy/types';

import {
  DEFAULT_BOT_COMMANDS,
  OPERATOR_BOT_COMMANDS,
  PRODUCTION_BOT_PROFILE,
  PRODUCTION_BOT_USERNAME,
} from '../telegram/production-bot-profile.js';

export type ProductionProfileApi = {
  getMe(): Promise<{ username: string }>;
  setMyName(name: string): Promise<true>;
  setMyDescription(description: string): Promise<true>;
  setMyShortDescription(shortDescription: string): Promise<true>;
  setMyCommands(
    commands: readonly BotCommand[],
    options: { scope: BotCommandScope },
  ): Promise<true>;
  setMyProfilePhoto(photo: InputProfilePhoto): Promise<true>;
};

export type ProfileStep =
  | 'name'
  | 'description'
  | 'short_description'
  | 'default_commands'
  | 'operator_commands'
  | 'profile_photo';

export class ProfileStepError extends Error {
  constructor(readonly step: ProfileStep, cause: unknown) {
    super(`Production bot profile failed at ${step}`, { cause });
    this.name = 'ProfileStepError';
  }
}

export async function applyProductionBotProfile(input: {
  api: ProductionProfileApi;
  operatorTelegramIds: readonly number[];
  avatar: InputFile;
  onStep?: (step: ProfileStep) => void;
}): Promise<void> {
  const me = await input.api.getMe();
  if (me.username !== PRODUCTION_BOT_USERNAME) {
    throw new Error(`Refusing to configure @${me.username}`);
  }
  const run = async (step: ProfileStep, operation: () => Promise<true>) => {
    try {
      await operation();
      input.onStep?.(step);
    } catch (error) {
      throw new ProfileStepError(step, error);
    }
  };
  await run('name', () => input.api.setMyName(PRODUCTION_BOT_PROFILE.name));
  await run('description', () =>
    input.api.setMyDescription(PRODUCTION_BOT_PROFILE.description),
  );
  await run('short_description', () =>
    input.api.setMyShortDescription(PRODUCTION_BOT_PROFILE.shortDescription),
  );
  await run('default_commands', () =>
    input.api.setMyCommands(DEFAULT_BOT_COMMANDS, { scope: { type: 'default' } }),
  );
  for (const telegramId of input.operatorTelegramIds) {
    await run('operator_commands', () =>
      input.api.setMyCommands(OPERATOR_BOT_COMMANDS, {
        scope: { type: 'chat', chat_id: telegramId },
      }),
    );
  }
  await run('profile_photo', () =>
    input.api.setMyProfilePhoto({ type: 'static', photo: input.avatar }),
  );
}
```

- [ ] **Step 4: Add the partial-failure assertion**

```ts
it('names the failed remote step and stops later writes', async () => {
  const { api, calls } = fakeApi('strelchuk_giveaways_bot', 'setMyDescription');
  await expect(
    applyProductionBotProfile({
      api,
      operatorTelegramIds: [700],
      avatar: new InputFile(new Uint8Array([1])),
    }),
  ).rejects.toMatchObject({ step: 'description' });
  expect(calls).toEqual(['getMe', 'setMyName', 'setMyDescription']);
});
```

- [ ] **Step 5: Run the focused test and TypeScript build**

Run:

```bash
pnpm exec vitest run tests/operations/telegram-profile-service.test.ts
pnpm build
```

Expected: both commands PASS; the grammY method signatures accept the service adapter shape.

- [ ] **Step 6: Commit the guarded application service**

```bash
git add src/operations/telegram-profile-service.ts tests/operations/telegram-profile-service.test.ts
git commit -m "feat: guard production profile updates"
```

---

### Task 3: Add the local preflight and one-shot CLI

**Files:**
- Create: `src/operations/configure-telegram-profile.ts`
- Create: `tests/operations/configure-telegram-profile.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `applyProductionBotProfile`, `PRODUCTION_AVATAR_JPG_PATH`, `parseTeamTelegramIds`, `BOT_TOKEN`, `TEAM_TELEGRAM_IDS`, and optional `DOTENV_CONFIG_PATH` handled by `dotenv/config`.
- Produces: `assertStaticJpeg(bytes): void`, `toSafeProfileFailure(error): { event: string; errorName: string; step?: ProfileStep }`, and package script `pnpm profile:apply`.

- [ ] **Step 1: Write failing local-preflight and redaction tests**

```ts
import { describe, expect, it } from 'vitest';

import {
  assertStaticJpeg,
  toSafeProfileFailure,
} from '../../src/operations/configure-telegram-profile.js';
import { ProfileStepError } from '../../src/operations/telegram-profile-service.js';

describe('configure telegram profile', () => {
  it('accepts only complete JPG framing', () => {
    expect(() =>
      assertStaticJpeg(Uint8Array.from([0xff, 0xd8, 0xff, 0x00, 0xff, 0xd9])),
    ).not.toThrow();
    expect(() => assertStaticJpeg(Uint8Array.from([0x89, 0x50, 0x4e, 0x47])))
      .toThrow('Production avatar must be a JPG');
  });

  it('projects a remote failure without the raw Telegram detail', () => {
    const error = new ProfileStepError(
      'profile_photo',
      new Error('BOT_TOKEN=secret raw Telegram description'),
    );
    expect(toSafeProfileFailure(error)).toEqual({
      event: 'bot_profile_apply_failed',
      errorName: 'ProfileStepError',
      step: 'profile_photo',
    });
    expect(JSON.stringify(toSafeProfileFailure(error))).not.toContain('secret');
  });
});
```

- [ ] **Step 2: Run the CLI test and verify RED**

Run: `pnpm exec vitest run tests/operations/configure-telegram-profile.test.ts`

Expected: FAIL because the composition root does not exist.

- [ ] **Step 3: Implement testable helpers and a guarded main function**

```ts
import { readFile } from 'node:fs/promises';

import 'dotenv/config';
import { Api, InputFile } from 'grammy';

import { parseTeamTelegramIds } from '../config/team-telegram-ids.js';
import { PRODUCTION_AVATAR_JPG_PATH } from '../telegram/production-bot-profile.js';
import {
  applyProductionBotProfile,
  ProfileStepError,
  type ProfileStep,
} from './telegram-profile-service.js';

export function assertStaticJpeg(bytes: Uint8Array): void {
  const valid =
    bytes.length >= 5 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff &&
    bytes.at(-2) === 0xff &&
    bytes.at(-1) === 0xd9;
  if (!valid) throw new Error('Production avatar must be a JPG');
}

export function toSafeProfileFailure(error: unknown): {
  event: string;
  errorName: string;
  step?: ProfileStep;
} {
  return {
    event: 'bot_profile_apply_failed',
    errorName: error instanceof Error ? error.name : 'UnknownError',
    ...(error instanceof ProfileStepError ? { step: error.step } : {}),
  };
}

async function main(): Promise<void> {
  const token = requiredEnvironment('BOT_TOKEN');
  const operatorTelegramIds = parseTeamTelegramIds(
    requiredEnvironment('TEAM_TELEGRAM_IDS'),
  );
  const avatarBytes = await readFile(PRODUCTION_AVATAR_JPG_PATH);
  assertStaticJpeg(avatarBytes);
  const api = new Api(token);
  await applyProductionBotProfile({
    api,
    operatorTelegramIds,
    avatar: new InputFile(PRODUCTION_AVATAR_JPG_PATH),
    onStep: (step) => console.log(JSON.stringify({ event: 'bot_profile_step_applied', step })),
  });
  console.log(JSON.stringify({ event: 'bot_profile_applied' }));
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

if (process.env.NODE_ENV !== 'test') {
  void main().catch((error) => {
    console.error(JSON.stringify(toSafeProfileFailure(error)));
    process.exitCode = 1;
  });
}
```

- [ ] **Step 4: Add the package script without changing dependencies**

Add to `package.json` scripts:

```json
"profile:apply": "tsx src/operations/configure-telegram-profile.ts"
```

- [ ] **Step 5: Run focused tests and compile**

Run:

```bash
pnpm exec vitest run tests/operations/configure-telegram-profile.test.ts tests/operations/telegram-profile-service.test.ts
pnpm build
```

Expected: PASS; no network request is made by either test.

- [ ] **Step 6: Verify wrong-bot fail-closed behavior with the smoke configuration only if the token is already locally available**

Run: `DOTENV_CONFIG_PATH=.env pnpm profile:apply`

Expected: nonzero exit after `getMe`, event `bot_profile_apply_failed`, and no profile-step success event. Confirm the smoke bot profile is unchanged through a read-only `getMe` call. Do not run this step if `.env` does not still belong to the known smoke bot.

- [ ] **Step 7: Commit the one-shot CLI**

```bash
git add package.json src/operations/configure-telegram-profile.ts tests/operations/configure-telegram-profile.test.ts
git commit -m "feat: add production profile command"
```

---

### Task 4: Replace the test-like payload-free `/start` experience

**Files:**
- Create: `src/telegram/gift-bot-copy.ts`
- Modify: `src/telegram/gift-bot-adapter.ts`
- Modify: `tests/telegram/gift-bot-adapter.test.ts`

**Interfaces:**
- Produces: `PUBLIC_START_MESSAGE` and `ADMIN_START_MESSAGE` exact strings.
- Preserves: payload precedence `ci_` then `join_` then `ref_`; `requireAdministrator` for `/new`, `/giveaways`, `/cancel` and administrative callbacks.

- [ ] **Step 1: Change the authorization test to express the new public `/start` contract**

```ts
expect(fakeApi.sentMessages().map((call) => call.payload.text)).toEqual([
  'Это официальный бот розыгрышей Татьяны Стрельчук. Чтобы участвовать, откройте кнопку «Участвовать» в конкурсном посте.',
  'Эта команда недоступна.',
  'Эта команда недоступна.',
  'Эта команда недоступна.',
]);
```

Add an operator test:

```ts
it('shows the branded command summary to an allowlisted operator', async () => {
  const { bot, fakeApi } = await openTestBot([700]);
  await bot.handleUpdate(privateMessageUpdate(100, 700, '/start'));
  expect(fakeApi.sentMessages()[0]!.payload.text).toBe(
    'Добро пожаловать в «Розыгрыши Татьяны Стрельчук».\n\n/new — создать розыгрыш\n/giveaways — открыть мои розыгрыши\n/cancel — отменить розыгрыш или текущую настройку',
  );
});
```

- [ ] **Step 2: Run the adapter test and verify RED**

Run: `pnpm exec vitest run tests/telegram/gift-bot-adapter.test.ts`

Expected: FAIL because unauthorized `/start` still returns `Эта команда недоступна.` and the operator still receives `Gift Bot готов`.

- [ ] **Step 3: Add the copy module**

```ts
export const PUBLIC_START_MESSAGE =
  'Это официальный бот розыгрышей Татьяны Стрельчук. Чтобы участвовать, откройте кнопку «Участвовать» в конкурсном посте.';

export const ADMIN_START_MESSAGE =
  'Добро пожаловать в «Розыгрыши Татьяны Стрельчук».\n\n/new — создать розыгрыш\n/giveaways — открыть мои розыгрыши\n/cancel — отменить розыгрыш или текущую настройку';
```

- [ ] **Step 4: Branch payload-free `/start` by role after deep-link handling**

Replace only the final authorization branch inside `bot.command('start', ...)`:

```ts
if (!dependencies.teamTelegramIds.has(context.from!.id)) {
  await context.reply(PUBLIC_START_MESSAGE);
  return;
}
await context.reply(ADMIN_START_MESSAGE);
```

Import both strings from `gift-bot-copy.ts`. Do not move the `ci_`, `join_` or `ref_` branches.

- [ ] **Step 5: Run the full adapter suite**

Run: `pnpm exec vitest run tests/telegram/gift-bot-adapter.test.ts`

Expected: PASS, including external-owner, participant and referral deep-link cases.

- [ ] **Step 6: Commit the role-aware `/start` copy**

```bash
git add src/telegram/gift-bot-copy.ts src/telegram/gift-bot-adapter.ts tests/telegram/gift-bot-adapter.test.ts
git commit -m "feat: polish telegram start experience"
```

---

### Task 5: Document and verify Epic 4 without mutating production by default

**Files:**
- Modify: `README.md`
- Create: `docs/verification/2026-08-09-epic-04.md`

**Interfaces:**
- Documents: BotFather prerequisite, `DOTENV_CONFIG_PATH`, exact profile command, asset source, wrong-bot guard and separate evidence levels.
- Produces: an evidence record that never equates local PASS with a changed Telegram profile.

- [ ] **Step 1: Add the production-profile runbook to README**

Document this exact sequence:

```bash
node --version
pnpm --version
pnpm check
DOTENV_CONFIG_PATH="$HOME/Library/Application Support/StrelchukGiveawaysBot/production.env" pnpm profile:apply
```

State that BotFather must first create `@strelchuk_giveaways_bot`, the profile command refuses every other username, and the command is never part of normal startup.

- [ ] **Step 2: Create the Epic 4 verification record with explicit evidence sections**

Use these headings and initial states:

```markdown
# Epic 4 verification — production bot identity and Telegram UX

## Automated checks

| Check | Result | Evidence |
|---|---|---|
| Focused profile/adapter tests | NOT RUN | Execution intentionally waits for Step 3 |
| `pnpm check` | NOT RUN | Execution intentionally waits for Step 3 |

## Local guarded profile command

| Check | Result | Evidence |
|---|---|---|
| Wrong-username smoke token | NOT RUN | Must stop before the first write |

## Real production Telegram smoke

Status: NOT RUN. Requires explicit user authorization and the newly created production token.
```

- [ ] **Step 3: Run the automated gate**

Run:

```bash
pnpm exec vitest run tests/telegram/production-bot-profile.test.ts tests/operations/telegram-profile-service.test.ts tests/operations/configure-telegram-profile.test.ts tests/telegram/gift-bot-adapter.test.ts
pnpm check
git diff --check
```

Expected: all commands PASS. Record exact command results and current commit SHA under automated checks.

- [ ] **Step 4: Perform the real profile smoke only after explicit authorization**

Preconditions: BotFather created the exact username, the production env exists outside the repository with mode `0600`, and the user explicitly approved remote profile writes.

Run:

```bash
DOTENV_CONFIG_PATH="$HOME/Library/Application Support/StrelchukGiveawaysBot/production.env" pnpm profile:apply
```

Then verify through read-only Bot API and Telegram clients:

- `getMe.username` is `strelchuk_giveaways_bot`;
- name, descriptions and avatar match the contract;
- an ordinary account sees only `/start` and the participant explanation;
- an allowlisted account sees four commands and the branded operator response.

If authorization or the production token is absent, leave this section `NOT RUN`; do not report Epic 4 remotely complete.

- [ ] **Step 5: Commit documentation and recorded evidence**

```bash
git add README.md docs/verification/2026-08-09-epic-04.md
git commit -m "docs: add epic 4 production profile runbook"
```

---

## Final Epic 4 Gate

- [ ] Run `git status --short --branch` and confirm only intentional evidence edits remain.
- [ ] Run `pnpm check` from the repository root.
- [ ] Run `git diff --check` and `git diff --cached --check` when staged changes exist.
- [ ] Confirm `src/index.ts` does not import or invoke the profile application service.
- [ ] Confirm no committed file contains a real token with `rg -n 'BOT_TOKEN=.+|[0-9]{8,}:[A-Za-z0-9_-]{20,}' --glob '!pnpm-lock.yaml' .` and inspect every match rather than assuming the regex is authoritative.
- [ ] Report automated, local wrong-bot, and real Telegram evidence separately.
- [ ] Do not begin Epic 5 in the same review wave unless Epic 4 is independently green and committed.
