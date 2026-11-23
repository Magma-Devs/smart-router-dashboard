ALTER TABLE ask_runs ADD COLUMN answer_markdown text;
--> statement-breakpoint
ALTER TABLE ask_runs ADD CONSTRAINT ask_runs_answer_markdown CHECK (answer_markdown IS NULL OR length(answer_markdown) <= 8000);
--> statement-breakpoint
ALTER TABLE ask_messages ADD COLUMN answer_markdown text;
--> statement-breakpoint
ALTER TABLE ask_messages ADD CONSTRAINT ask_messages_answer_markdown CHECK (answer_markdown IS NULL OR length(answer_markdown) <= 8000);
--> statement-breakpoint
ALTER TABLE ask_runs DROP CONSTRAINT ask_runs_draft;
--> statement-breakpoint
ALTER TABLE ask_runs ADD CONSTRAINT ask_runs_draft CHECK (draft IS NULL OR length(draft) <= 8000);
