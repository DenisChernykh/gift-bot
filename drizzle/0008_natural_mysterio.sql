ALTER TABLE `reroll_operations` ADD `sync_status` text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE `reroll_operations` ADD `notification_status` text DEFAULT 'pending' NOT NULL;