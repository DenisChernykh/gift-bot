export type GiveawayState =
  | 'draft'
  | 'publishing'
  | 'active'
  | 'drawing'
  | 'completed'
  | 'cancelled'
  | 'failed';

export type GiveawayEvent =
  | 'start_publication'
  | 'deliveries_saved'
  | 'rollback_complete'
  | 'rollback_incomplete'
  | 'start_drawing'
  | 'drawing_completed'
  | 'operation_failed'
  | 'cancel';

const transitions: Partial<Record<GiveawayState, Partial<Record<GiveawayEvent, GiveawayState>>>> = {
  draft: {
    start_publication: 'publishing',
    cancel: 'cancelled',
  },
  publishing: {
    deliveries_saved: 'active',
    rollback_complete: 'draft',
    rollback_incomplete: 'failed',
    operation_failed: 'failed',
  },
  active: {
    start_drawing: 'drawing',
    operation_failed: 'failed',
    cancel: 'cancelled',
  },
  drawing: {
    drawing_completed: 'completed',
    operation_failed: 'failed',
  },
};

export function transitionGiveawayState(
  current: GiveawayState,
  event: GiveawayEvent,
): GiveawayState {
  const next = transitions[current]?.[event];
  if (!next) {
    throw new Error(`Cannot apply ${event} to giveaway in ${current} state`);
  }

  return next;
}
