ALTER TABLE ask_preferences DROP CONSTRAINT ask_preferences_return_to;
--> statement-breakpoint
ALTER TABLE ask_preferences ADD CONSTRAINT ask_preferences_return_to CHECK(return_to IN ('/overview','/dashboard','/metrics','/upstreams','/team','/audit','/account'));
