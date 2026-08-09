import type { TelegramPostEdit } from './telegram-gateway.js';

export type PostSynchronizationTask = {
  id: string;
  taskType: 'cancel_message' | 'result' | 'participant_count';
  payload: string;
  attempts: number;
};

export interface PostSynchronizationRepository {
  recoverInterrupted(now: number): Promise<void>;
  listDueTasks(now: number): Promise<PostSynchronizationTask[]>;
  claimTask(id: string, now: number): Promise<PostSynchronizationTask | null>;
  getTaskEdit(task: PostSynchronizationTask): Promise<TelegramPostEdit | null>;
  completeTask(input: {
    id: string;
    expectedPayload: string;
    availableAt: number;
    now: number;
  }): Promise<void>;
  failTask(input: {
    id: string;
    errorKind: string;
    terminal: boolean;
    availableAt: number;
    now: number;
  }): Promise<void>;
  supersedeTask(id: string, now: number): Promise<void>;
}
