ALTER TABLE ask_runs ADD COLUMN draft text;
--> statement-breakpoint
ALTER TABLE ask_runs ADD CONSTRAINT ask_runs_draft CHECK (draft IS NULL OR length(draft) <= 2000);
