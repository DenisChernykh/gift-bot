import type { GiveawayContent } from '../../domain/giveaway-validation.js';

export const wizardSteps = [
  'title',
  'winner_count',
  'deadline',
  'referrals',
  'content',
  'channels',
  'preview',
] as const;

export type WizardStep = (typeof wizardSteps)[number];

export type GiveawayDraft = {
  title?: string;
  winnerCount?: number;
  deadlineUtc?: number;
  referralsEnabled: boolean;
  content?: GiveawayContent;
};

export type ActiveWizard = {
  id: string;
  administratorTelegramId: number;
  giveawayId?: string;
  step: WizardStep;
  status: 'active';
  draft: GiveawayDraft;
  createdAt: number;
  updatedAt: number;
};

export type StartWizardResult = {
  kind: 'created' | 'resumed';
  wizard: ActiveWizard;
};

export interface GiveawayCreationRepository {
  startOrResumeWizard(input: {
    id: string;
    administratorTelegramId: number;
    now: number;
  }): Promise<StartWizardResult>;

  advanceWizard(input: {
    administratorTelegramId: number;
    expectedStep: WizardStep;
    nextStep: WizardStep;
    draftPatch: Partial<GiveawayDraft>;
    now: number;
    materializeGiveawayId?: string;
  }): Promise<ActiveWizard>;

  advanceWizardToPreview(input: {
    administratorTelegramId: number;
    now: number;
  }): Promise<ActiveWizard>;
}
