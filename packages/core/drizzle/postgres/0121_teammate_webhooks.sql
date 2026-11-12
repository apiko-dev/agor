SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
CREATE TABLE "teammate_webhooks" (
	"tenant_id" text DEFAULT 'default' NOT NULL,
	"webhook_id" varchar(36) PRIMARY KEY NOT NULL,
	"branch_id" varchar(36) NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"prompt" text NOT NULL,
	"agentic_tool_config" jsonb NOT NULL,
	"agentic_tool_preset_id" varchar(36),
	"mcp_server_ids" jsonb,
	"enabled" boolean DEFAULT true NOT NULL,
	"allow_concurrent_runs" boolean DEFAULT false NOT NULL,
	"token_hash" text,
	"token_hint" text,
	"token_issued_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"created_by" varchar(36) NOT NULL
);
--> statement-breakpoint
-- Webhook definitions move with tenant archives, so their FKs are deferrable for import.
ALTER TABLE "teammate_webhooks" ADD CONSTRAINT "teammate_webhooks_branch_id_branches_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("branch_id") ON DELETE cascade ON UPDATE no action DEFERRABLE INITIALLY IMMEDIATE;
--> statement-breakpoint
ALTER TABLE "teammate_webhooks" ADD CONSTRAINT "teammate_webhooks_agentic_tool_preset_id_agentic_tool_presets_preset_id_fk" FOREIGN KEY ("agentic_tool_preset_id") REFERENCES "public"."agentic_tool_presets"("preset_id") ON DELETE restrict ON UPDATE no action DEFERRABLE INITIALLY IMMEDIATE;
--> statement-breakpoint
ALTER TABLE "teammate_webhooks" ADD CONSTRAINT "teammate_webhooks_created_by_users_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("user_id") ON DELETE no action ON UPDATE no action DEFERRABLE INITIALLY IMMEDIATE;
--> statement-breakpoint
CREATE INDEX "teammate_webhooks_tenant_id_idx" ON "teammate_webhooks" USING btree ("tenant_id");
--> statement-breakpoint
CREATE INDEX "teammate_webhooks_branch_idx" ON "teammate_webhooks" USING btree ("branch_id");
--> statement-breakpoint
CREATE INDEX "teammate_webhooks_agentic_tool_preset_idx" ON "teammate_webhooks" USING btree ("agentic_tool_preset_id");
--> statement-breakpoint
CREATE INDEX "teammate_webhooks_created_by_idx" ON "teammate_webhooks" USING btree ("created_by");
--> statement-breakpoint
-- Deliveries hold deployment-encrypted payloads and are excluded from tenant
-- archives, so their FKs stay non-deferrable.
CREATE TABLE "teammate_webhook_deliveries" (
	"tenant_id" text DEFAULT 'default' NOT NULL,
	"delivery_id" varchar(36) PRIMARY KEY NOT NULL,
	"webhook_id" varchar(36) NOT NULL,
	"branch_id" varchar(36) NOT NULL,
	"status" text NOT NULL,
	"idempotency_key" text,
	"payload_encrypted" text,
	"payload_bytes" integer NOT NULL,
	"payload_expires_at" timestamp with time zone NOT NULL,
	"processing_token" text,
	"processing_expires_at" timestamp with time zone,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone NOT NULL,
	"defer_reason" text,
	"failure_code" text,
	"session_id" varchar(36),
	"task_id" varchar(36),
	"received_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	CONSTRAINT "teammate_webhook_deliveries_webhook_id_teammate_webhooks_webhook_id_fk" FOREIGN KEY ("webhook_id") REFERENCES "public"."teammate_webhooks"("webhook_id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "teammate_webhook_deliveries_branch_id_branches_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("branch_id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "teammate_webhook_deliveries_session_id_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("session_id") ON DELETE set null ON UPDATE no action,
	CONSTRAINT "teammate_webhook_deliveries_task_id_tasks_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("task_id") ON DELETE set null ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX "teammate_webhook_deliveries_tenant_id_idx" ON "teammate_webhook_deliveries" USING btree ("tenant_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "teammate_webhook_deliveries_idempotency_unique" ON "teammate_webhook_deliveries" USING btree ("tenant_id","webhook_id","idempotency_key") WHERE "teammate_webhook_deliveries"."idempotency_key" IS NOT NULL;
--> statement-breakpoint
-- Fleet discovery must not scan terminal history or require a tenant-leading index.
CREATE INDEX "teammate_webhook_deliveries_due_idx" ON "teammate_webhook_deliveries" USING btree ("next_attempt_at","delivery_id") WHERE "teammate_webhook_deliveries"."status" IN ('queued', 'processing');
--> statement-breakpoint
CREATE INDEX "teammate_webhook_deliveries_lane_idx" ON "teammate_webhook_deliveries" USING btree ("tenant_id","webhook_id","received_at","delivery_id") WHERE "teammate_webhook_deliveries"."status" IN ('queued', 'processing');
--> statement-breakpoint
CREATE INDEX "teammate_webhook_deliveries_history_idx" ON "teammate_webhook_deliveries" USING btree ("tenant_id","webhook_id","received_at");
--> statement-breakpoint
CREATE INDEX "teammate_webhook_deliveries_session_idx" ON "teammate_webhook_deliveries" USING btree ("session_id");
--> statement-breakpoint
CREATE INDEX "teammate_webhook_deliveries_retention_idx" ON "teammate_webhook_deliveries" USING btree ("received_at","delivery_id") WHERE "teammate_webhook_deliveries"."status" IN ('started', 'failed');
--> statement-breakpoint
ALTER TABLE "teammate_webhooks" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "teammate_webhooks" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation_teammate_webhooks" ON "teammate_webhooks"
USING (COALESCE(current_setting('agor.system_scope', true), '') = '' AND "tenant_id" = NULLIF(current_setting('agor.tenant_id', true), ''))
WITH CHECK (COALESCE(current_setting('agor.system_scope', true), '') = '' AND "tenant_id" = NULLIF(current_setting('agor.tenant_id', true), ''));
--> statement-breakpoint
ALTER TABLE "teammate_webhook_deliveries" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "teammate_webhook_deliveries" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation_teammate_webhook_deliveries" ON "teammate_webhook_deliveries"
USING (COALESCE(current_setting('agor.system_scope', true), '') = '' AND "tenant_id" = NULLIF(current_setting('agor.tenant_id', true), ''))
WITH CHECK (COALESCE(current_setting('agor.system_scope', true), '') = '' AND "tenant_id" = NULLIF(current_setting('agor.tenant_id', true), ''));
--> statement-breakpoint
-- Ingress maps a URL webhook id to its tenant: enabled rows only, read only.
CREATE POLICY "teammate_webhook_ingress_discovery" ON "teammate_webhooks"
  FOR SELECT
  USING (
    "enabled" = true
    AND current_setting('agor.system_scope', true) = 'teammate_webhook_ingress_discovery'
  );
--> statement-breakpoint
-- The worker discovers due non-terminal deliveries only, read only.
CREATE POLICY "teammate_webhook_delivery_discovery" ON "teammate_webhook_deliveries"
  FOR SELECT
  USING (
    "status" IN ('queued', 'processing')
    AND current_setting('agor.system_scope', true) = 'teammate_webhook_delivery_discovery'
  );
