DROP INDEX `wizard_sessions_administrator_status_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `wizard_sessions_administrator_active_unique` ON `wizard_sessions` (`administrator_telegram_id`) WHERE "wizard_sessions"."status" = 'active';--> statement-breakpoint
ALTER TABLE `pending_channel_connections` ADD `candidate_telegram_chat_id` integer;--> statement-breakpoint
ALTER TABLE `pending_channel_connections` ADD `candidate_username` text;--> statement-breakpoint
ALTER TABLE `pending_channel_connections` ADD `candidate_title` text;--> statement-breakpoint
ALTER TABLE `pending_channel_connections` ADD `rights_verified_at` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `pending_channel_connections_user_active_unique` ON `pending_channel_connections` (`telegram_user_id`) WHERE "pending_channel_connections"."status" = 'active';