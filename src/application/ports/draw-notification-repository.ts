export type DrawNotification = {
  id: string;
  recipientTelegramId: number;
  text: string;
  attempts: number;
};

export interface DrawNotificationRepository {
  recoverInterruptedNotifications(now: number): Promise<void>;
  listDueNotifications(now: number): Promise<DrawNotification[]>;
  claimNotification(id: string, now: number): Promise<DrawNotification | null>;
  completeNotification(id: string, now: number): Promise<void>;
  failNotification(input: {
    id: string;
    terminal: boolean;
    errorKind: string;
    availableAt: number;
    now: number;
  }): Promise<void>;
}
