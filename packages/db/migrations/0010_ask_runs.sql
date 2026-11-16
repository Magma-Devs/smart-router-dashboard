CREATE SEQUENCE ask_chat_activity_seq;
--> statement-breakpoint
CREATE TABLE ask_chats (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id text NOT NULL,
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title text NOT NULL CONSTRAINT ask_chats_title CHECK (length(title) BETWEEN 1 AND 120),
  activity_seq bigint NOT NULL DEFAULT nextval('ask_chat_activity_seq'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CONSTRAINT ask_chats_owned UNIQUE(id, customer_id, owner_id)
);
--> statement-breakpoint
CREATE INDEX ask_chats_history ON ask_chats(customer_id, owner_id, activity_seq DESC);
--> statement-breakpoint
CREATE INDEX ask_chats_expiry ON ask_chats(expires_at);
--> statement-breakpoint
CREATE TABLE ask_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id uuid NOT NULL,
  customer_id text NOT NULL,
  owner_id uuid NOT NULL,
  session_id uuid NOT NULL,
  idempotency_key uuid NOT NULL,
  request_hash text NOT NULL,
  question text NOT NULL CONSTRAINT ask_runs_question CHECK(length(question) BETWEEN 1 AND 4000),
  context jsonb,
  status text NOT NULL DEFAULT 'queued',
  lease_token uuid,
  lease_until timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  answer jsonb,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  expires_at timestamptz NOT NULL,
  CONSTRAINT ask_runs_chat_owner FOREIGN KEY(chat_id,customer_id,owner_id) REFERENCES ask_chats(id,customer_id,owner_id) ON DELETE CASCADE,
  CONSTRAINT ask_runs_owned UNIQUE(id,chat_id,customer_id,owner_id),
  CONSTRAINT ask_runs_idempotency UNIQUE(customer_id,owner_id,idempotency_key),
  CONSTRAINT ask_runs_state CHECK(status IN ('queued','running','cancelling','succeeded','failed','cancelled','interrupted')),
  CONSTRAINT ask_runs_terminal CHECK((status IN ('queued','running','cancelling')) = (completed_at IS NULL)),
  CONSTRAINT ask_runs_answer CHECK((status='succeeded') = (answer IS NOT NULL)),
  CONSTRAINT ask_runs_lease CHECK((status IN ('running','cancelling')) = (lease_token IS NOT NULL AND lease_until IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX ask_runs_one_active_person ON ask_runs(customer_id,owner_id) WHERE status IN ('queued','running','cancelling');
--> statement-breakpoint
CREATE INDEX ask_runs_queue ON ask_runs(customer_id,status,created_at);
--> statement-breakpoint
CREATE INDEX ask_runs_expired_lease ON ask_runs(customer_id,lease_until);
--> statement-breakpoint
CREATE TABLE ask_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq bigserial NOT NULL,
  run_id uuid NOT NULL,
  chat_id uuid NOT NULL,
  customer_id text NOT NULL,
  owner_id uuid NOT NULL,
  role text NOT NULL,
  question text,
  answer jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ask_messages_run_owner FOREIGN KEY(run_id,chat_id,customer_id,owner_id) REFERENCES ask_runs(id,chat_id,customer_id,owner_id) ON DELETE CASCADE,
  CONSTRAINT ask_messages_turn UNIQUE(run_id,role),
  CONSTRAINT ask_messages_content CHECK((role='user' AND question IS NOT NULL AND answer IS NULL) OR (role='assistant' AND answer IS NOT NULL AND question IS NULL))
);
--> statement-breakpoint
CREATE INDEX ask_messages_chat ON ask_messages(customer_id,owner_id,chat_id,seq);
--> statement-breakpoint
CREATE TABLE ask_preferences (
  customer_id text NOT NULL,
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  view text NOT NULL CONSTRAINT ask_preferences_view CHECK(view IN ('panel','full')),
  chat_id uuid,
  return_to text NOT NULL CONSTRAINT ask_preferences_return_to CHECK(return_to IN ('/overview','/dashboard','/metrics','/upstreams')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(customer_id,owner_id)
);
