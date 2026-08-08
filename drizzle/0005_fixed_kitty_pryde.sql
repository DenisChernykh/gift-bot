ALTER TABLE `giveaways` ADD `failure_run_id` text;--> statement-breakpoint
UPDATE `giveaways`
   SET `failure_run_id` = (
     SELECT `publication_runs`.`id`
       FROM `publication_runs`
      WHERE `publication_runs`.`giveaway_id` = `giveaways`.`id`
        AND `publication_runs`.`status` = 'failed'
        AND `publication_runs`.`failure_stage` IS NOT NULL
      ORDER BY `publication_runs`.`finished_at` DESC,
               `publication_runs`.`id` DESC
      LIMIT 1
   )
 WHERE `giveaways`.`state` = 'failed';
