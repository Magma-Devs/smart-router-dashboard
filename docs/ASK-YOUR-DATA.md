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
- **One question at a time.** While an answer is being made, the box is locked and a
  Stop button replaces Send.
- The **steps** while it works: understanding the question, each read of the client's
  data (which store, what for), writing the answer.
- A **numbered answer**: a one-line summary first, then numbered parts, each with a
  title, a short body, optional points and one figure, then what it **read**, then
  copy, thumbs up/down, how long it took and what it cost.
- **History**: chats grouped Today / Yesterday / Earlier this week, kept **7 days**,
  with "Show earlier chats" for the rest.
- The month's **budget** at the bottom: spent of the limit. At the limit the box
  says so and refuses new questions.

## What to build

1. **Model: Claude on Amazon Bedrock**, called by the api, never the browser. The
   identity setup in the closed #200 (SigV4 from the default credential chain, or the
   provisioned bearer key) is a starting point.
2. **Data: the client's own MCP server, scoped to that client.** The tools the model
   may call read only that client's data: the same per-tenant credentials the api
   already uses for Prometheus and Loki, which pin the tenant on the store's side.
   The separation is enforced by the credential, server-side, never by a filter in a
   prompt or in the web.
3. **Budget per client per month.** Start at **$10 / month**. Count each answer's
   cost from Bedrock's token usage, refuse a question once the month's spend reaches
   the limit, and return the spend and limit to the panel.
4. **History per person, 7 days**, on the server (Postgres, as the rest of the
   account data), so it follows the person across browsers. Older chats are deleted.
5. **Prompt logs, 90 days**: every question, who asked, the client, when, the tools
   called, tokens and cost, and the answer. Product needs to read them: say where
   (a table plus an admin export, or Loki) and how access is granted.
6. **One question at a time per person**, enforced by the api, not only the web.
7. **Progress events** while an answer is made (understanding → each read → writing),
   streamed to the panel, so the steps it shows are the real ones.
8. **Answer format**: a contract, not free text, so the panel draws it numbered:

   ```json
   {
     "summary": "One line that answers the question.",
     "sections": [
       { "title": "…", "body": "…", "points": ["…"], "stat": { "value": "99.97%", "label": "served", "tone": "warn" } }
     ],
     "sources": ["Failed requests, 24 h", "Router logs, 47 requests"]
   }
   ```

   Keep the prompt plain at first; tune it once we see what clients ask.

## Open questions for the backend

- Where the prompt logs live, and how product reads them.
- Whether the budget resets on the calendar month or 30 days from the first question.
- What the panel says when the client's MCP server or Bedrock doesn't answer.
