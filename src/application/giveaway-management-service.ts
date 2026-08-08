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

  listCancellationTargets(administratorTelegramId: number) {
    return this.#repository.listCancellationTargets(administratorTelegramId);
  }

  cancelUnmaterializedWizard(administratorTelegramId: number) {
    return this.#repository.cancelUnmaterializedWizard({
      administratorTelegramId,
      now: this.#dependencies.now(),
    });
  }
}
