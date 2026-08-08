import { hashToken } from '../domain/tokens.js';
import type { GiveawayManagementRepository } from './ports/giveaway-management-repository.js';

type ManagementDependencies = { now: () => number };

export class GiveawayManagementService {
  readonly #repository: GiveawayManagementRepository;
  readonly #dependencies: ManagementDependencies;

  constructor(
    repository: GiveawayManagementRepository,
    dependencies: Partial<ManagementDependencies> = {},
  ) {
    this.#repository = repository;
    this.#dependencies = { now: Date.now, ...dependencies };
  }

  listGiveaways(administratorTelegramId: number) {
    return this.#repository.listGiveaways(administratorTelegramId);
  }

  getGiveawaySummary(giveawayId: string) {
    return this.#repository.getGiveawaySummary(giveawayId);
  }

  async resolveJoinLink(token: string) {
    const target = await this.#repository.findJoinLinkTarget(hashToken(token));
    if (
      !target ||
      target.tokenState !== 'active' ||
      target.giveawayState !== 'active'
    ) {
      return { kind: 'unavailable' as const };
    }
    return { kind: 'epic_2_boundary' as const, giveaway: target };
  }

  findCancellationTarget(administratorTelegramId: number) {
    return this.#repository.findCancellationTarget(administratorTelegramId);
  }

  cancelUnmaterializedWizard(administratorTelegramId: number) {
    return this.#repository.cancelUnmaterializedWizard({
      administratorTelegramId,
      now: this.#dependencies.now(),
    });
  }
}
