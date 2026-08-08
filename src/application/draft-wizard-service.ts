import {
  parseGiveawayDeadline,
  validateGiveawayContent,
  validateGiveawayTitle,
  validateWinnerCount,
  type GiveawayContent,
} from '../domain/giveaway-validation.js';
import {
  MAXIMUM_PARTICIPANT_COUNT,
  renderGiveawayMessage,
} from '../domain/giveaway-rendering.js';
import type {
  ActiveWizard,
  GiveawayCreationRepository,
  StartWizardResult,
} from './ports/giveaway-creation-repository.js';

type DraftWizardDependencies = {
  createId: (kind: 'wizard' | 'giveaway') => string;
  now: () => number;
};

const defaultDependencies: DraftWizardDependencies = {
  createId: (kind) => `${kind}-${crypto.randomUUID()}`,
  now: Date.now,
};

export class DraftWizardService {
  readonly #repository: GiveawayCreationRepository;
  readonly #dependencies: DraftWizardDependencies;

  constructor(
    repository: GiveawayCreationRepository,
    dependencies: Partial<DraftWizardDependencies> = {},
  ) {
    this.#repository = repository;
    this.#dependencies = { ...defaultDependencies, ...dependencies };
  }

  async startOrResume(
    administratorTelegramId: number,
  ): Promise<StartWizardResult> {
    return this.#repository.startOrResumeWizard({
      id: this.#dependencies.createId('wizard'),
      administratorTelegramId,
      now: this.#dependencies.now(),
    });
  }

  async findActive(
    administratorTelegramId: number,
  ): Promise<ActiveWizard | null> {
    return this.#repository.findActiveWizard(administratorTelegramId);
  }

  async submitTitle(
    administratorTelegramId: number,
    value: string,
  ): Promise<ActiveWizard> {
    return this.#repository.advanceWizard({
      administratorTelegramId,
      expectedStep: 'title',
      nextStep: 'winner_count',
      draftPatch: { title: validateGiveawayTitle(value) },
      now: this.#dependencies.now(),
    });
  }

  async submitWinnerCount(
    administratorTelegramId: number,
    value: number,
  ): Promise<ActiveWizard> {
    return this.#repository.advanceWizard({
      administratorTelegramId,
      expectedStep: 'winner_count',
      nextStep: 'deadline',
      draftPatch: { winnerCount: validateWinnerCount(value) },
      now: this.#dependencies.now(),
    });
  }

  async submitDeadline(
    administratorTelegramId: number,
    value: string,
  ): Promise<ActiveWizard> {
    const now = this.#dependencies.now();
    return this.#repository.advanceWizard({
      administratorTelegramId,
      expectedStep: 'deadline',
      nextStep: 'referrals',
      draftPatch: { deadlineUtc: parseGiveawayDeadline(value, now) },
      now,
    });
  }

  async submitReferrals(
    administratorTelegramId: number,
    referralsEnabled: boolean,
  ): Promise<ActiveWizard> {
    return this.#repository.advanceWizard({
      administratorTelegramId,
      expectedStep: 'referrals',
      nextStep: 'content',
      draftPatch: { referralsEnabled },
      now: this.#dependencies.now(),
    });
  }

  async submitContent(
    administratorTelegramId: number,
    value: GiveawayContent,
  ): Promise<ActiveWizard> {
    const content = validateGiveawayContent(value);
    const wizard = await this.#repository.findActiveWizard(
      administratorTelegramId,
    );
    if (wizard?.step === 'content') {
      const { title, winnerCount, deadlineUtc } = wizard.draft;
      if (
        title === undefined ||
        winnerCount === undefined ||
        deadlineUtc === undefined
      ) {
        throw new Error('Giveaway draft is incomplete');
      }
      renderGiveawayMessage(
        {
          title,
          winnerCount,
          deadlineUtc,
          referralsEnabled: wizard.draft.referralsEnabled,
          content,
        },
        MAXIMUM_PARTICIPANT_COUNT,
      );
    }
    const now = this.#dependencies.now();
    const giveawayId = this.#dependencies.createId('giveaway');
    return this.#repository.advanceWizard({
      administratorTelegramId,
      expectedStep: 'content',
      nextStep: 'channels',
      draftPatch: { content },
      now,
      materializeGiveawayId: giveawayId,
    });
  }

  async continueToPreview(
    administratorTelegramId: number,
  ): Promise<ActiveWizard> {
    return this.#repository.advanceWizardToPreview({
      administratorTelegramId,
      now: this.#dependencies.now(),
    });
  }
}
