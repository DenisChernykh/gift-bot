export type TelegramChannelMembership = {
  status: string;
  canPostMessages: boolean;
  canEditMessages: boolean;
  canDeleteMessages: boolean;
};

export function hasPublicationAdministratorRights(
  membership: TelegramChannelMembership,
): boolean {
  return (
    membership.status === 'administrator' &&
    membership.canPostMessages &&
    membership.canEditMessages &&
    membership.canDeleteMessages
  );
}
