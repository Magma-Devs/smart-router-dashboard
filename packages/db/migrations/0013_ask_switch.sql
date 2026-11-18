CREATE TABLE ask_switch (
  customer_id text PRIMARY KEY,
  off boolean NOT NULL,
  changed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  changed_at timestamptz NOT NULL DEFAULT now()
);
