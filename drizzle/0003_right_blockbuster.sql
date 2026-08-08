ALTER TABLE `giveaways` ADD `content_file_id` text;--> statement-breakpoint
ALTER TABLE `giveaways` ADD `content_entities` text DEFAULT '[]' NOT NULL;