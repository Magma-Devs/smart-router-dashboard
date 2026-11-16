CREATE TABLE ask_budget_months (
  customer_id text NOT NULL, month text NOT NULL,
  limit_micro_usd bigint NOT NULL, reserved_micro_usd bigint NOT NULL DEFAULT 0,
  spent_micro_usd bigint NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(customer_id, month),
  CONSTRAINT ask_budget_month CHECK(month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  CONSTRAINT ask_budget_nonnegative CHECK(limit_micro_usd >= 0 AND reserved_micro_usd >= 0 AND spent_micro_usd >= 0)
);
--> statement-breakpoint
CREATE TABLE ask_model_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), run_id uuid NOT NULL,
  customer_id text NOT NULL, month text NOT NULL, feature text NOT NULL, state text NOT NULL,
  input_token_bound integer NOT NULL, output_token_bound integer NOT NULL,
  reserved_micro_usd bigint NOT NULL, charged_micro_usd bigint,
  pricing jsonb NOT NULL, usage jsonb, provider_request_id text, provider_status integer,
  created_at timestamptz NOT NULL DEFAULT now(), dispatched_at timestamptz, completed_at timestamptz,
  FOREIGN KEY(customer_id,month) REFERENCES ask_budget_months(customer_id,month),
  CONSTRAINT ask_step_state CHECK(state IN ('reserved','dispatched','uncertain','settled','released')),
  CONSTRAINT ask_step_feature CHECK(feature IN ('ask','investigate')),
  CONSTRAINT ask_step_nonnegative CHECK(input_token_bound >= 0 AND output_token_bound > 0 AND reserved_micro_usd > 0 AND (charged_micro_usd IS NULL OR charged_micro_usd >= 0)),
  CONSTRAINT ask_step_charged CHECK((state IN ('settled','released')) = (charged_micro_usd IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX ask_model_steps_run ON ask_model_steps(customer_id,run_id);
--> statement-breakpoint
CREATE INDEX ask_model_steps_unresolved ON ask_model_steps(customer_id,state,created_at);
--> statement-breakpoint
CREATE UNIQUE INDEX ask_runs_customer ON ask_runs(id,customer_id);
--> statement-breakpoint
CREATE TABLE ask_tool_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), run_id uuid NOT NULL,
  customer_id text NOT NULL, source_id text NOT NULL, operation_id text NOT NULL,
  parameters jsonb NOT NULL, evidence jsonb NOT NULL, outcome text NOT NULL,
  latency_ms integer NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(run_id,customer_id) REFERENCES ask_runs(id,customer_id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX ask_tool_events_run ON ask_tool_events(customer_id,run_id);
--> statement-breakpoint
CREATE TABLE ask_maintenance (
  customer_id text PRIMARY KEY, last_attempt_at timestamptz, last_success_at timestamptz,
  deleted_runs integer NOT NULL DEFAULT 0, error_code text
);
--> statement-breakpoint
CREATE TABLE ask_staff_access (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_id text NOT NULL,
 subject text NOT NULL, action text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX ask_staff_access_retention ON ask_staff_access(customer_id,created_at);
