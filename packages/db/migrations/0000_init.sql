CREATE TABLE `auth_account` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`account_id` text NOT NULL,
	`password` text,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`issuer` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_account_provider` ON `auth_account` (`provider_id`,`account_id`);--> statement-breakpoint
CREATE TABLE `auth_passkey` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text,
	`public_key` text NOT NULL,
	`credential_id` text NOT NULL,
	`counter` integer DEFAULT 0 NOT NULL,
	`device_type` text,
	`backed_up` integer DEFAULT false NOT NULL,
	`transports` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_passkey_credential` ON `auth_passkey` (`credential_id`);--> statement-breakpoint
CREATE TABLE `auth_session` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token` text NOT NULL,
	`expires_at` integer NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_session_token` ON `auth_session` (`token`);--> statement-breakpoint
CREATE INDEX `auth_session_user` ON `auth_session` (`user_id`);--> statement-breakpoint
CREATE TABLE `auth_user` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`name` text,
	`email_verified` integer DEFAULT false NOT NULL,
	`image` text,
	`is_admin` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_user_email` ON `auth_user` (`email`);--> statement-breakpoint
CREATE TABLE `auth_verification` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `auth_verification_identifier` ON `auth_verification` (`identifier`);--> statement-breakpoint
CREATE TABLE `account` (
	`id` text PRIMARY KEY NOT NULL,
	`plan_id` text NOT NULL,
	`knowledge_at_change` integer DEFAULT 0 NOT NULL,
	`deleted` integer DEFAULT false NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`on_budget` integer NOT NULL,
	`closed` integer DEFAULT false NOT NULL,
	`note` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`transfer_payee_id` text,
	`last_reconciled_at` text,
	`opening_balance` integer NOT NULL,
	`debt_original_balance` integer,
	`debt_origination_date` text,
	`debt_interest_rates` text,
	`debt_minimum_payments` text,
	`debt_escrow_amounts` text,
	`balance` integer NOT NULL,
	`cleared_balance` integer NOT NULL,
	`uncleared_balance` integer NOT NULL,
	`uncovered_debt` integer NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `account_plan` ON `account` (`plan_id`,`sort_order`);--> statement-breakpoint
CREATE INDEX `account_knowledge` ON `account` (`plan_id`,`knowledge_at_change`);--> statement-breakpoint
CREATE TABLE `category` (
	`id` text PRIMARY KEY NOT NULL,
	`plan_id` text NOT NULL,
	`knowledge_at_change` integer DEFAULT 0 NOT NULL,
	`deleted` integer DEFAULT false NOT NULL,
	`category_group_id` text NOT NULL,
	`name` text NOT NULL,
	`note` text,
	`hidden` integer DEFAULT false NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`internal_kind` text,
	`credit_account_id` text,
	`original_category_group_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `category_group_idx` ON `category` (`plan_id`,`category_group_id`,`sort_order`);--> statement-breakpoint
CREATE UNIQUE INDEX `category_credit_account` ON `category` (`credit_account_id`);--> statement-breakpoint
CREATE INDEX `category_knowledge` ON `category` (`plan_id`,`knowledge_at_change`);--> statement-breakpoint
CREATE TABLE `category_group` (
	`id` text PRIMARY KEY NOT NULL,
	`plan_id` text NOT NULL,
	`knowledge_at_change` integer DEFAULT 0 NOT NULL,
	`deleted` integer DEFAULT false NOT NULL,
	`name` text NOT NULL,
	`hidden` integer DEFAULT false NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`internal_kind` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `category_group_plan` ON `category_group` (`plan_id`,`sort_order`);--> statement-breakpoint
CREATE TABLE `category_target` (
	`id` text PRIMARY KEY NOT NULL,
	`plan_id` text NOT NULL,
	`knowledge_at_change` integer DEFAULT 0 NOT NULL,
	`deleted` integer DEFAULT false NOT NULL,
	`category_id` text NOT NULL,
	`effective_from_month` text NOT NULL,
	`goal_type` text NOT NULL,
	`goal_target` integer,
	`goal_target_month` text,
	`goal_day` integer,
	`goal_cadence` integer,
	`goal_cadence_frequency` integer,
	`goal_needs_whole_amount` integer,
	`repeats` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `category_target_revision` ON `category_target` (`plan_id`,`category_id`,`effective_from_month`);--> statement-breakpoint
CREATE INDEX `category_target_category` ON `category_target` (`plan_id`,`category_id`);--> statement-breakpoint
CREATE TABLE `payee` (
	`id` text PRIMARY KEY NOT NULL,
	`plan_id` text NOT NULL,
	`knowledge_at_change` integer DEFAULT 0 NOT NULL,
	`deleted` integer DEFAULT false NOT NULL,
	`name` text NOT NULL,
	`transfer_account_id` text,
	`internal_kind` text,
	`last_category_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payee_name_unique` ON `payee` (`plan_id`,`name`) WHERE "payee"."deleted" = 0 AND "payee"."transfer_account_id" IS NULL AND "payee"."internal_kind" IS NULL;--> statement-breakpoint
CREATE INDEX `payee_knowledge` ON `payee` (`plan_id`,`knowledge_at_change`);--> statement-breakpoint
CREATE TABLE `reconciliation` (
	`id` text PRIMARY KEY NOT NULL,
	`plan_id` text NOT NULL,
	`knowledge_at_change` integer DEFAULT 0 NOT NULL,
	`deleted` integer DEFAULT false NOT NULL,
	`account_id` text NOT NULL,
	`reconciled_at` text NOT NULL,
	`statement_date` text,
	`statement_balance` integer NOT NULL,
	`prior_cleared_balance` integer NOT NULL,
	`adjustment_transaction_id` text,
	`performed_by_user_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `reconciliation_account` ON `reconciliation` (`plan_id`,`account_id`,`reconciled_at`);--> statement-breakpoint
CREATE TABLE `scheduled_subtransaction` (
	`id` text PRIMARY KEY NOT NULL,
	`plan_id` text NOT NULL,
	`knowledge_at_change` integer DEFAULT 0 NOT NULL,
	`deleted` integer DEFAULT false NOT NULL,
	`scheduled_transaction_id` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`amount` integer NOT NULL,
	`memo` text,
	`payee_id` text,
	`category_id` text,
	`transfer_account_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `scheduled_transaction` (
	`id` text PRIMARY KEY NOT NULL,
	`plan_id` text NOT NULL,
	`knowledge_at_change` integer DEFAULT 0 NOT NULL,
	`deleted` integer DEFAULT false NOT NULL,
	`account_id` text NOT NULL,
	`date_first` text NOT NULL,
	`date_next` text NOT NULL,
	`frequency` text NOT NULL,
	`amount` integer NOT NULL,
	`memo` text,
	`flag_color` text,
	`payee_id` text,
	`category_id` text,
	`transfer_account_id` text,
	`end_date` text,
	`end_after_occurrences` integer,
	`auto_enter` integer DEFAULT true NOT NULL,
	`last_entered_date` text,
	`is_split` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `scheduled_next` ON `scheduled_transaction` (`plan_id`,`date_next`);--> statement-breakpoint
CREATE INDEX `scheduled_knowledge` ON `scheduled_transaction` (`plan_id`,`knowledge_at_change`);--> statement-breakpoint
CREATE TABLE `scheduled_transaction_exception` (
	`id` text PRIMARY KEY NOT NULL,
	`plan_id` text NOT NULL,
	`knowledge_at_change` integer DEFAULT 0 NOT NULL,
	`deleted` integer DEFAULT false NOT NULL,
	`scheduled_transaction_id` text NOT NULL,
	`occurrence_date` text NOT NULL,
	`action` text NOT NULL,
	`override` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sched_exception_unique` ON `scheduled_transaction_exception` (`scheduled_transaction_id`,`occurrence_date`);--> statement-breakpoint
CREATE TABLE `subtransaction` (
	`id` text PRIMARY KEY NOT NULL,
	`plan_id` text NOT NULL,
	`knowledge_at_change` integer DEFAULT 0 NOT NULL,
	`deleted` integer DEFAULT false NOT NULL,
	`transaction_id` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`amount` integer NOT NULL,
	`memo` text,
	`payee_id` text,
	`category_id` text,
	`transfer_account_id` text,
	`transfer_transaction_id` text,
	`transfer_pair_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `subtransaction_parent` ON `subtransaction` (`transaction_id`,`sort_order`);--> statement-breakpoint
CREATE TABLE `transaction` (
	`id` text PRIMARY KEY NOT NULL,
	`plan_id` text NOT NULL,
	`knowledge_at_change` integer DEFAULT 0 NOT NULL,
	`deleted` integer DEFAULT false NOT NULL,
	`account_id` text NOT NULL,
	`date` text NOT NULL,
	`amount` integer NOT NULL,
	`memo` text,
	`cleared` text DEFAULT 'uncleared' NOT NULL,
	`approved` integer DEFAULT true NOT NULL,
	`flag_color` text,
	`flag_name` text,
	`payee_id` text,
	`category_id` text,
	`transfer_account_id` text,
	`transfer_transaction_id` text,
	`transfer_pair_id` text,
	`matched_transaction_id` text,
	`import_id` text,
	`import_payee_name` text,
	`import_payee_name_original` text,
	`import_batch_id` text,
	`debt_transaction_type` text,
	`is_split` integer DEFAULT false NOT NULL,
	`reconciliation_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `transaction_register` ON `transaction` (`plan_id`,`account_id`,`date`,`id`);--> statement-breakpoint
CREATE INDEX `transaction_date` ON `transaction` (`plan_id`,`date`);--> statement-breakpoint
CREATE INDEX `transaction_category` ON `transaction` (`plan_id`,`category_id`,`date`);--> statement-breakpoint
CREATE INDEX `transaction_knowledge` ON `transaction` (`plan_id`,`knowledge_at_change`);--> statement-breakpoint
CREATE INDEX `transaction_pair` ON `transaction` (`transfer_pair_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `transaction_import_unique` ON `transaction` (`plan_id`,`account_id`,`import_id`) WHERE "transaction"."import_id" IS NOT NULL AND "transaction"."deleted" = 0;--> statement-breakpoint
CREATE TABLE `money_movement` (
	`id` text PRIMARY KEY NOT NULL,
	`plan_id` text NOT NULL,
	`knowledge_at_change` integer DEFAULT 0 NOT NULL,
	`deleted` integer DEFAULT false NOT NULL,
	`money_movement_group_id` text,
	`month` text NOT NULL,
	`moved_at` text NOT NULL,
	`note` text,
	`from_category_id` text,
	`to_category_id` text,
	`amount` integer NOT NULL,
	`performed_by_user_id` text
);
--> statement-breakpoint
CREATE INDEX `money_movement_month` ON `money_movement` (`plan_id`,`month`,`moved_at`);--> statement-breakpoint
CREATE INDEX `money_movement_knowledge` ON `money_movement` (`plan_id`,`knowledge_at_change`);--> statement-breakpoint
CREATE TABLE `money_movement_group` (
	`id` text PRIMARY KEY NOT NULL,
	`plan_id` text NOT NULL,
	`knowledge_at_change` integer DEFAULT 0 NOT NULL,
	`deleted` integer DEFAULT false NOT NULL,
	`month` text NOT NULL,
	`group_created_at` text NOT NULL,
	`note` text,
	`performed_by_user_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `month` (
	`plan_id` text NOT NULL,
	`month` text NOT NULL,
	`note` text,
	`income` integer NOT NULL,
	`budgeted` integer NOT NULL,
	`activity` integer NOT NULL,
	`to_be_budgeted` integer NOT NULL,
	`age_of_money` integer,
	`cache_epoch` integer DEFAULT 0 NOT NULL,
	`knowledge_at_change` integer DEFAULT 0 NOT NULL,
	`deleted` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `month_pk` ON `month` (`plan_id`,`month`);--> statement-breakpoint
CREATE TABLE `month_category` (
	`plan_id` text NOT NULL,
	`month` text NOT NULL,
	`category_id` text NOT NULL,
	`budgeted` integer NOT NULL,
	`activity` integer NOT NULL,
	`balance` integer NOT NULL,
	`carried_forward` integer NOT NULL,
	`overspend_kind` text NOT NULL,
	`goal_target_snapshot` integer,
	`goal_under_funded` integer,
	`goal_percentage_complete` integer,
	`goal_months_to_budget` integer,
	`goal_overall_funded` integer,
	`goal_overall_left` integer,
	`goal_snoozed_at` text,
	`cache_epoch` integer DEFAULT 0 NOT NULL,
	`derived_for_date` text,
	`knowledge_at_change` integer DEFAULT 0 NOT NULL,
	`deleted` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `month_category_pk` ON `month_category` (`plan_id`,`month`,`category_id`);--> statement-breakpoint
CREATE INDEX `month_category_knowledge` ON `month_category` (`plan_id`,`knowledge_at_change`);--> statement-breakpoint
CREATE TABLE `api_token` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`prefix` text NOT NULL,
	`last_used_at` text,
	`expires_at` text,
	`revoked_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_token_hash` ON `api_token` (`token_hash`);--> statement-breakpoint
CREATE INDEX `api_token_user` ON `api_token` (`user_id`);--> statement-breakpoint
CREATE TABLE `audit_event` (
	`id` text PRIMARY KEY NOT NULL,
	`plan_id` text,
	`user_id` text,
	`at` text NOT NULL,
	`action` text NOT NULL,
	`entity_type` text,
	`entity_id` text,
	`summary` text,
	`payload` text,
	`ip` text
);
--> statement-breakpoint
CREATE INDEX `audit_event_plan` ON `audit_event` (`plan_id`,`at`);--> statement-breakpoint
CREATE INDEX `audit_event_user` ON `audit_event` (`user_id`);--> statement-breakpoint
CREATE TABLE `backup_record` (
	`id` text PRIMARY KEY NOT NULL,
	`path` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`taken_at` text NOT NULL,
	`trigger` text NOT NULL,
	`for_date` text
);
--> statement-breakpoint
CREATE TABLE `external_id_map` (
	`plan_id` text NOT NULL,
	`entity_type` text NOT NULL,
	`external_system` text NOT NULL,
	`external_id` text NOT NULL,
	`internal_id` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `external_id_pk` ON `external_id_map` (`plan_id`,`entity_type`,`external_system`,`external_id`);--> statement-breakpoint
CREATE INDEX `external_id_internal` ON `external_id_map` (`internal_id`);--> statement-breakpoint
CREATE TABLE `import_batch` (
	`id` text PRIMARY KEY NOT NULL,
	`plan_id` text NOT NULL,
	`knowledge_at_change` integer DEFAULT 0 NOT NULL,
	`deleted` integer DEFAULT false NOT NULL,
	`account_id` text,
	`source` text NOT NULL,
	`filename` text,
	`file_hash` text,
	`mapping_id` text,
	`row_count` integer DEFAULT 0 NOT NULL,
	`matched_count` integer DEFAULT 0 NOT NULL,
	`created_count` integer DEFAULT 0 NOT NULL,
	`status` text NOT NULL,
	`created_by_user_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `import_batch_plan` ON `import_batch` (`plan_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `import_mapping` (
	`id` text PRIMARY KEY NOT NULL,
	`plan_id` text NOT NULL,
	`knowledge_at_change` integer DEFAULT 0 NOT NULL,
	`deleted` integer DEFAULT false NOT NULL,
	`account_id` text,
	`name` text NOT NULL,
	`format` text NOT NULL,
	`column_map` text NOT NULL,
	`date_format` text,
	`amount_style` text NOT NULL,
	`decimal_separator` text,
	`skip_rows` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `invite` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`token_hash` text NOT NULL,
	`invited_by_user_id` text NOT NULL,
	`role` text,
	`expires_at` text NOT NULL,
	`accepted_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invite_token` ON `invite` (`token_hash`);--> statement-breakpoint
CREATE INDEX `invite_email` ON `invite` (`email`);--> statement-breakpoint
CREATE TABLE `plan_migration` (
	`id` text PRIMARY KEY NOT NULL,
	`plan_id` text NOT NULL,
	`knowledge_at_change` integer DEFAULT 0 NOT NULL,
	`deleted` integer DEFAULT false NOT NULL,
	`adapter_id` text NOT NULL,
	`adapter_version` text NOT NULL,
	`source_label` text,
	`status` text NOT NULL,
	`cir_version` text NOT NULL,
	`counts` text,
	`loss_report` text,
	`dry_run` integer DEFAULT false NOT NULL,
	`started_at` text,
	`finished_at` text,
	`created_by_user_id` text
);
--> statement-breakpoint
CREATE TABLE `carry_checkpoint` (
	`plan_id` text NOT NULL,
	`month` text NOT NULL,
	`state` text NOT NULL,
	`epoch` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `carry_checkpoint_pk` ON `carry_checkpoint` (`plan_id`,`month`);--> statement-breakpoint
CREATE TABLE `plan` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`currency_format` text NOT NULL,
	`date_format` text DEFAULT 'MM/DD/YYYY' NOT NULL,
	`first_day_of_week` integer DEFAULT 0 NOT NULL,
	`timezone` text DEFAULT 'UTC' NOT NULL,
	`first_month` text,
	`last_month` text,
	`server_knowledge` integer DEFAULT 0 NOT NULL,
	`deleted` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `plan_membership` (
	`plan_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `plan_membership_pk` ON `plan_membership` (`plan_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `plan_membership_user` ON `plan_membership` (`user_id`);--> statement-breakpoint
CREATE TABLE `plan_recalc` (
	`plan_id` text PRIMARY KEY NOT NULL,
	`dirty_from_month` text,
	`epoch` integer DEFAULT 0 NOT NULL,
	`last_run_at` text,
	`running_by` text
);
