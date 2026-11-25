CREATE TABLE customer_names (
  customer text PRIMARY KEY CHECK (octet_length(customer) BETWEEN 1 AND 128),
  name varchar(64) NOT NULL CHECK (length(btrim(name)) > 0),
  changed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  changed_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX customer_names_name_unique ON customer_names (lower(name));
