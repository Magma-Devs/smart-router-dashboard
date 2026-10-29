# Ask your data

A chat panel where a client asks about their own router in plain words and gets a
numbered answer built from their own data. For clients who don't connect their own
tools to our MCP server, this is the way in.

**Status: preview.** `apps/web/src/components/ask/` draws the whole flow with sample
answers and reads no store. It shows only where `ASK_DATA_PREVIEW=true`, and says on
screen that its answers are samples. Everything below is the backend it stands in for.

## What the client sees (built, in the preview)

- An **Ask your data** button in the top bar (`⌘J` opens and closes it).
- A side panel that can be **minimized** to a pill and brought back; it keeps working
  while minimized ("Answering…").
- **One question at a time.** While an answer is being made, the box is locked, the
  panel shows **Processing**, and a Stop button replaces Send.
- A **numbered answer**: a one-line summary first, then numbered parts, each with a
  title, a short body, optional points and one figure. A copy button.
- The **day and time** under every answer.
- **History**: chats grouped Today / Yesterday / Earlier this week, kept **7 days**,
  with "Show earlier chats" for the rest.
- At the month's budget the box says the limit is reached and refuses new questions.
  The budget itself is not shown.

## What to build

1. **Model: Claude on Amazon Bedrock**, called by the api, never the browser. The
   identity setup in the closed #200 (SigV4 from the default credential chain, or the
   provisioned bearer key) is a starting point.
2. **Data: our customer MCP server (`Magma-Devs/smart-router-mcp`), as it is.** It
   already gives each client a worker that reads only that client's Grafana, Mimir
   and Loki, checks the tenant itself, and takes no tenant, header or URL from tool
   arguments. Its tools: `whoami`, `list_sources`, `search_operations`,
   `execute_operation`, `query_metrics`, `query_logs`, and `chain_events` (provider
   status pages, provider incidents and protocol changes for the client's own chains
   only). The api calls it with the signed-in client's MCP credential; Bedrock never
   sees a credential. The separation stays where it is: in the MCP server's
   per-client worker, never in a prompt or in the web.
3. **Budget per client per month.** Start at **$10 / month**. Count each answer's
   cost from Bedrock's token usage, refuse a question once the month's spend reaches
   the limit, and return the spend and limit to the panel.
4. **History per person, 7 days**, on the server (Postgres, as the rest of the
   account data), so it follows the person across browsers. Older chats are deleted.
5. **Prompt logs, 90 days**: every question, who asked, the client, when, the tools
   called, tokens and cost, and the answer. Product needs to read them: say where
   (a table plus an admin export, or Loki) and how access is granted.
6. **One question at a time per person**, enforced by the api, not only the web.
7. **Status while it works**: one "Processing" state from question to answer is
   enough; no per-step events.
8. **Answer format**: a contract, not free text, so the panel draws it numbered:

   ```json
   {
     "summary": "One line that answers the question.",
     "sections": [
       { "title": "…", "body": "…", "points": ["…"], "stat": { "value": "99.97%", "label": "served", "tone": "warn" } }
     ]
   }
   ```

   Keep the prompt plain at first; tune it once we see what clients ask.

## Open questions for the backend

- Where the prompt logs live, and how product reads them.
- Whether the budget resets on the calendar month or 30 days from the first question.
- What the panel says when the client's MCP server or Bedrock doesn't answer.
