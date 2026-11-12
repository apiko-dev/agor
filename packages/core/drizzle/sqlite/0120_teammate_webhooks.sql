CREATE TABLE `teammate_webhooks` (
	`webhook_id` text(36) PRIMARY KEY NOT NULL,
	`branch_id` text(36) NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`prompt` text NOT NULL,
	`agentic_tool_config` text NOT NULL,
	`agentic_tool_preset_id` text(36),
	`mcp_server_ids` text,
	`enabled` integer DEFAULT true NOT NULL,
	`allow_concurrent_runs` integer DEFAULT false NOT NULL,
	`token_hash` text,
	`token_hint` text,
	`token_issued_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`created_by` text(36) NOT NULL,
	FOREIGN KEY (`branch_id`) REFERENCES `branches`(`branch_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agentic_tool_preset_id`) REFERENCES `agentic_tool_presets`(`preset_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`user_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `teammate_webhooks_branch_idx` ON `teammate_webhooks` (`branch_id`);
--> statement-breakpoint
CREATE INDEX `teammate_webhooks_agentic_tool_preset_idx` ON `teammate_webhooks` (`agentic_tool_preset_id`);
--> statement-breakpoint
CREATE INDEX `teammate_webhooks_created_by_idx` ON `teammate_webhooks` (`created_by`);
--> statement-breakpoint
CREATE TABLE `teammate_webhook_deliveries` (
	`delivery_id` text(36) PRIMARY KEY NOT NULL,
	`webhook_id` text(36) NOT NULL,
	`branch_id` text(36) NOT NULL,
	`status` text NOT NULL,
	`idempotency_key` text,
	`payload_encrypted` text,
	`payload_bytes` integer NOT NULL,
	`payload_expires_at` integer NOT NULL,
	`processing_token` text,
	`processing_expires_at` integer,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer NOT NULL,
	`defer_reason` text,
	`failure_code` text,
	`session_id` text(36),
	`task_id` text(36),
	`received_at` integer NOT NULL,
	`started_at` integer,
	`failed_at` integer,
	FOREIGN KEY (`webhook_id`) REFERENCES `teammate_webhooks`(`webhook_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`branch_id`) REFERENCES `branches`(`branch_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`session_id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`task_id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `teammate_webhook_deliveries_idempotency_unique` ON `teammate_webhook_deliveries` (`webhook_id`,`idempotency_key`) WHERE "teammate_webhook_deliveries"."idempotency_key" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX `teammate_webhook_deliveries_due_idx` ON `teammate_webhook_deliveries` (`next_attempt_at`,`delivery_id`) WHERE "teammate_webhook_deliveries"."status" IN ('queued', 'processing');
--> statement-breakpoint
CREATE INDEX `teammate_webhook_deliveries_lane_idx` ON `teammate_webhook_deliveries` (`webhook_id`,`received_at`,`delivery_id`) WHERE "teammate_webhook_deliveries"."status" IN ('queued', 'processing');
--> statement-breakpoint
CREATE INDEX `teammate_webhook_deliveries_history_idx` ON `teammate_webhook_deliveries` (`webhook_id`,`received_at`);
--> statement-breakpoint
CREATE INDEX `teammate_webhook_deliveries_session_idx` ON `teammate_webhook_deliveries` (`session_id`);
--> statement-breakpoint
CREATE INDEX `teammate_webhook_deliveries_retention_idx` ON `teammate_webhook_deliveries` (`received_at`,`delivery_id`) WHERE "teammate_webhook_deliveries"."status" IN ('started', 'failed');
