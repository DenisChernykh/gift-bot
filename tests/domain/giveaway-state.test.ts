import { describe, expect, it } from 'vitest';

import { hasPublicationAdministratorRights } from '../../src/domain/channel-rights.js';
import { transitionGiveawayState } from '../../src/domain/giveaway-state.js';

describe('giveaway state transitions', () => {
  it('moves a ready draft through publication into active', () => {
    const publishing = transitionGiveawayState('draft', 'start_publication');

    expect(publishing).toBe('publishing');
    expect(transitionGiveawayState(publishing, 'deliveries_saved')).toBe('active');
  });

  it('returns a fully rolled-back publication to draft and blocks invalid transitions', () => {
    expect(transitionGiveawayState('publishing', 'rollback_complete')).toBe(
      'draft',
    );
    expect(() => transitionGiveawayState('active', 'start_publication')).toThrow();
  });

  it('allows cancellation from draft and active before any later side effect', () => {
    expect(transitionGiveawayState('draft', 'cancel')).toBe('cancelled');
    expect(transitionGiveawayState('active', 'cancel')).toBe('cancelled');
  });
});

describe('channel administrator rights', () => {
  it('requires the Telegram administrator role and all publication permissions', () => {
    expect(
      hasPublicationAdministratorRights({
        status: 'administrator',
        canPostMessages: true,
        canEditMessages: true,
        canDeleteMessages: true,
      }),
    ).toBe(true);
    expect(
      hasPublicationAdministratorRights({
        status: 'administrator',
        canPostMessages: true,
        canEditMessages: false,
        canDeleteMessages: true,
      }),
    ).toBe(false);
    expect(
      hasPublicationAdministratorRights({
        status: 'member',
        canPostMessages: true,
        canEditMessages: true,
        canDeleteMessages: true,
      }),
    ).toBe(false);
  });
});
