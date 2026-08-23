CREATE TABLE `undo_entry` (
	`id` text PRIMARY KEY NOT NULL,
	`plan_id` text NOT NULL,
	`user_id` text NOT NULL,
	`seq` integer NOT NULL,
	`group_id` text NOT NULL,
	`at` text NOT NULL,
	`label` text NOT NULL,
	`inverse` text NOT NULL,
	`forward` text NOT NULL,
	`undone` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE INDEX `undo_entry_stack` ON `undo_entry` (`plan_id`,`user_id`,`seq`);--> statement-breakpoint
CREATE INDEX `undo_entry_group` ON `undo_entry` (`group_id`);