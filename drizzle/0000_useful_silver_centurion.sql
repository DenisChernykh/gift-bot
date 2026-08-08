CREATE TABLE `callback_actions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`giveaway_id` text,
	`actor_telegram_id` integer,
	`action` text NOT NULL,
	`payload` text NOT NULL,
	`expires_at` integer NOT NULL,
	`consumed_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`giveaway_id`) REFERENCES `giveaways`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `callback_actions_expiry_index` ON `callback_actions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `channel_invites` (
	`id` text PRIMARY KEY NOT NULL,
	`giveaway_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`invited_telegram_id` integer,
	`state` text NOT NULL,
	`expires_at` integer NOT NULL,
	`consumed_at` integer,
	`revoked_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`giveaway_id`) REFERENCES `giveaways`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `channel_invites_token_hash_unique` ON `channel_invites` (`token_hash`);--> statement-breakpoint
CREATE TABLE `giveaway_channels` (
	`id` text PRIMARY KEY NOT NULL,
	`giveaway_id` text NOT NULL,
	`telegram_chat_id` integer NOT NULL,
	`username` text NOT NULL,
	`title` text NOT NULL,
	`owner_telegram_id` integer NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`giveaway_id`) REFERENCES `giveaways`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `giveaway_channels_giveaway_chat_unique` ON `giveaway_channels` (`giveaway_id`,`telegram_chat_id`);--> statement-breakpoint
CREATE TABLE `giveaways` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`state` text NOT NULL,
	`winner_count` integer NOT NULL,
	`deadline_utc` integer NOT NULL,
	`referrals_enabled` integer NOT NULL,
	`content_kind` text NOT NULL,
	`content_text` text NOT NULL,
	`created_by_telegram_id` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `join_tokens` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`giveaway_id` text NOT NULL,
	`state` text NOT NULL,
	`expires_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`giveaway_id`) REFERENCES `giveaways`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `join_tokens_giveaway_index` ON `join_tokens` (`giveaway_id`);--> statement-breakpoint
CREATE TABLE `pending_channel_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`giveaway_id` text NOT NULL,
	`invite_id` text,
	`telegram_user_id` integer NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`giveaway_id`) REFERENCES `giveaways`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`invite_id`) REFERENCES `channel_invites`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `pending_channel_connections_user_status_index` ON `pending_channel_connections` (`telegram_user_id`,`status`);--> statement-breakpoint
CREATE TABLE `publication_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`publication_run_id` text NOT NULL,
	`giveaway_channel_id` text NOT NULL,
	`status` text NOT NULL,
	`message_id` integer,
	`message_kind` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`publication_run_id`) REFERENCES `publication_runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`giveaway_channel_id`) REFERENCES `giveaway_channels`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `publication_deliveries_run_channel_unique` ON `publication_deliveries` (`publication_run_id`,`giveaway_channel_id`);--> statement-breakpoint
CREATE TABLE `publication_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`giveaway_id` text NOT NULL,
	`status` text NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`giveaway_id`) REFERENCES `giveaways`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `publication_runs_giveaway_index` ON `publication_runs` (`giveaway_id`);--> statement-breakpoint
CREATE TABLE `sync_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`giveaway_id` text NOT NULL,
	`giveaway_channel_id` text,
	`task_type` text NOT NULL,
	`payload` text NOT NULL,
	`status` text NOT NULL,
	`attempts` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`giveaway_id`) REFERENCES `giveaways`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`giveaway_channel_id`) REFERENCES `giveaway_channels`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `sync_tasks_status_index` ON `sync_tasks` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `wizard_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`administrator_telegram_id` integer NOT NULL,
	`giveaway_id` text,
	`step` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`giveaway_id`) REFERENCES `giveaways`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `wizard_sessions_administrator_status_unique` ON `wizard_sessions` (`administrator_telegram_id`,`status`);