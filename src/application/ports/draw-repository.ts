import type {
  DrawPlace,
  DrawSnapshot,
  EligibleDrawParticipant,
} from '../../domain/giveaway-draw.js';

export type DrawChannel = {
  id: string;
  telegramChatId: number;
  username: string;
  title: string;
};

export type DrawTarget = {
  id: string;
  title: string;
  state: 'drawing';
  winnerCount: number;
  deadlineUtc: number;
  referralsEnabled: boolean;
  createdByTelegramId: number;
  channels: DrawChannel[];
  participants: EligibleDrawParticipant[];
  snapshot: DrawSnapshot | null;
};

export type CurrentDrawPlace = DrawPlace & {
  version: number;
  participant: DrawSnapshot['participants'][number] | null;
};

export type CompletedDraw = {
  giveawayId: string;
  title: string;
  snapshot: DrawSnapshot;
  cursor: number;
  resultRevision: number;
  places: CurrentDrawPlace[];
  excludedParticipantIds: string[];
};

export interface DrawRepository {
  claimNextDue(now: number): Promise<DrawTarget | null>;
  listDrawing(): Promise<DrawTarget[]>;
  getDrawing(giveawayId: string): Promise<DrawTarget | null>;
  saveSnapshot(input: {
    giveawayId: string;
    snapshot: DrawSnapshot;
    now: number;
  }): Promise<DrawSnapshot>;
  completeDraw(input: {
    giveawayId: string;
    places: DrawPlace[];
    cursor: number;
    teamTelegramIds: readonly number[];
    now: number;
  }): Promise<CompletedDraw>;
  failDraw(input: {
    giveawayId: string;
    stage: string;
    errorKind: string;
    teamTelegramIds: readonly number[];
    now: number;
  }): Promise<void>;
  retryFailedDraw(giveawayId: string, now: number): Promise<boolean>;
  getCompletedDraw(giveawayId: string): Promise<CompletedDraw | null>;
}
