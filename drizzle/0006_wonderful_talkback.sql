CREATE TABLE `channel_health_alerts` (
	`id` text PRIMARY KEY NOT NULL,
	`giveaway_id` text NOT NULL,
	`giveaway_channel_id` text NOT NULL,
	`kind` text NOT NULL,
	`state` text NOT NULL,
	`first_detected_at` integer NOT NULL,
	`last_detected_at` integer NOT NULL,
	`notified_at` integer,
	`resolved_at` integer,
	FOREIGN KEY (`giveaway_id`) REFERENCES `giveaways`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`giveaway_channel_id`) REFERENCES `giveaway_channels`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `channel_health_alerts_active_unique` ON `channel_health_alerts` (`giveaway_id`,`giveaway_channel_id`,`kind`) WHERE "channel_health_alerts"."state" = 'active';--> statement-breakpoint
CREATE INDEX `channel_health_alerts_pending_notification_index` ON `channel_health_alerts` (`state`,`notified_at`);--> statement-breakpoint
CREATE TABLE `participants` (
	`id` text PRIMARY KEY NOT NULL,
	`giveaway_id` text NOT NULL,
	`telegram_user_id` integer NOT NULL,
	`username` text,
	`display_name` text NOT NULL,
	`inviter_participant_id` text,
	`joined_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`giveaway_id`) REFERENCES `giveaways`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`inviter_participant_id`,`giveaway_id`) REFERENCES `participants`(`id`,`giveaway_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `participants_giveaway_user_unique` ON `participants` (`giveaway_id`,`telegram_user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `participants_id_giveaway_unique` ON `participants` (`id`,`giveaway_id`);--> statement-breakpoint
CREATE INDEX `participants_giveaway_inviter_index` ON `participants` (`giveaway_id`,`inviter_participant_id`);--> statement-breakpoint
CREATE TABLE `referral_tokens` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`giveaway_id` text NOT NULL,
	`inviter_participant_id` text NOT NULL,
	`state` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`giveaway_id`) REFERENCES `giveaways`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`inviter_participant_id`,`giveaway_id`) REFERENCES `participants`(`id`,`giveaway_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `referral_tokens_giveaway_inviter_index` ON `referral_tokens` (`giveaway_id`,`inviter_participant_id`);--> statement-breakpoint
DROP INDEX `sync_tasks_status_index`;--> statement-breakpoint
ALTER TABLE `sync_tasks` ADD `available_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `sync_tasks` ADD `last_error_kind` text;--> statement-breakpoint
CREATE UNIQUE INDEX `sync_tasks_participant_count_unique` ON `sync_tasks` (`giveaway_id`,`giveaway_channel_id`) WHERE "sync_tasks"."task_type" = 'participant_count';--> statement-breakpoint
CREATE INDEX `sync_tasks_status_index` ON `sync_tasks` (`status`,`available_at`);