CREATE TABLE `draw_exclusions` (
	`draw_run_id` text NOT NULL,
	`participant_id` text NOT NULL,
	`reason` text NOT NULL,
	`reroll_operation_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`draw_run_id`) REFERENCES `draw_runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reroll_operation_id`) REFERENCES `reroll_operations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `draw_exclusions_run_participant_unique` ON `draw_exclusions` (`draw_run_id`,`participant_id`);--> statement-breakpoint
CREATE TABLE `draw_notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`giveaway_id` text NOT NULL,
	`draw_run_id` text NOT NULL,
	`reroll_operation_id` text,
	`recipient_telegram_id` integer NOT NULL,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`available_at` integer DEFAULT 0 NOT NULL,
	`last_error_kind` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`giveaway_id`) REFERENCES `giveaways`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`draw_run_id`) REFERENCES `draw_runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reroll_operation_id`) REFERENCES `reroll_operations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `draw_notifications_due_index` ON `draw_notifications` (`status`,`available_at`);--> statement-breakpoint
CREATE TABLE `draw_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`giveaway_id` text NOT NULL,
	`snapshot_version` integer,
	`snapshot_json` text,
	`cursor` integer DEFAULT 0 NOT NULL,
	`result_revision` integer DEFAULT 0 NOT NULL,
	`failure_stage` text,
	`failure_error_kind` text,
	`started_at` integer NOT NULL,
	`snapshot_created_at` integer,
	`completed_at` integer,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`giveaway_id`) REFERENCES `giveaways`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `draw_runs_giveaway_unique` ON `draw_runs` (`giveaway_id`);--> statement-breakpoint
CREATE INDEX `draw_runs_failure_index` ON `draw_runs` (`failure_stage`,`updated_at`);--> statement-breakpoint
CREATE TRIGGER `draw_runs_snapshot_immutable`
BEFORE UPDATE OF `snapshot_version`, `snapshot_json`, `snapshot_created_at`
ON `draw_runs`
WHEN OLD.`snapshot_json` IS NOT NULL
  AND (
    NEW.`snapshot_version` IS NOT OLD.`snapshot_version`
    OR NEW.`snapshot_json` IS NOT OLD.`snapshot_json`
    OR NEW.`snapshot_created_at` IS NOT OLD.`snapshot_created_at`
  )
BEGIN
  SELECT RAISE(ABORT, 'draw snapshot is immutable');
END;--> statement-breakpoint
CREATE TABLE `prize_place_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`draw_run_id` text NOT NULL,
	`place_number` integer NOT NULL,
	`version` integer NOT NULL,
	`state` text NOT NULL,
	`participant_id` text,
	`created_at` integer NOT NULL,
	`rejected_at` integer,
	FOREIGN KEY (`draw_run_id`) REFERENCES `draw_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `prize_place_versions_run_place_version_unique` ON `prize_place_versions` (`draw_run_id`,`place_number`,`version`);--> statement-breakpoint
CREATE UNIQUE INDEX `prize_place_versions_active_unique` ON `prize_place_versions` (`draw_run_id`,`place_number`) WHERE "prize_place_versions"."state" in ('selected', 'empty');--> statement-breakpoint
CREATE TABLE `reroll_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`draw_run_id` text NOT NULL,
	`place_number` integer NOT NULL,
	`operator_telegram_id` integer NOT NULL,
	`reason` text NOT NULL,
	`previous_participant_id` text NOT NULL,
	`new_participant_id` text,
	`skipped_candidates` text DEFAULT '[]' NOT NULL,
	`status` text NOT NULL,
	`cursor_before` integer NOT NULL,
	`cursor_after` integer NOT NULL,
	`result_revision` integer,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`draw_run_id`) REFERENCES `draw_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `reroll_operations_draw_index` ON `reroll_operations` (`draw_run_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `reroll_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`giveaway_id` text NOT NULL,
	`operator_telegram_id` integer NOT NULL,
	`place_number` integer NOT NULL,
	`state` text NOT NULL,
	`reason` text,
	`operation_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`giveaway_id`) REFERENCES `giveaways`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`operation_id`) REFERENCES `reroll_operations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reroll_sessions_operator_active_unique` ON `reroll_sessions` (`operator_telegram_id`) WHERE "reroll_sessions"."state" in ('awaiting_reason', 'awaiting_confirmation');--> statement-breakpoint
CREATE UNIQUE INDEX `sync_tasks_result_unique` ON `sync_tasks` (`giveaway_id`,`giveaway_channel_id`) WHERE "sync_tasks"."task_type" = 'result';
