# Relay Trace as a POC — what to build before showing the team

[`REVIEW.md`](REVIEW.md) is written for a production path. This one is written
for a **demo**: the page has to look like part of the product and drive itself
in front of an audience. Different priorities, and a much shorter list.

The one-line brief: **a POC is judged on the first thirty seconds and the first
question afterwards.** The first thirty seconds are the loading state and the
layout. The first question is "how would I have found that relay?" — and today
the honest answer is "you'd have run a shell script", which is the answer that
sinks a POC.

## Cut these from the POC runway

Nothing below is wrong — it is just not what a first demo is judged on.

| From REVIEW.md | Why it can wait |
|---|---|
| **2 · Loki auth** | The demo runs on `make demo` against the bundled Loki. Real, and irrelevant on stage. It becomes a P0 the day someone says yes. |
| **9 · Evidence citations** | The right answer to "can we trust it?", but a design conversation, not a demo feature. Better raised *by* the team than pre-empted. |
| **10 · Aggregating `notDetermined`** | A great second demo. It needs traces to have accumulated, which a POC has not. |

Everything else on this page is small, and most of it is visual.

---

## 1 · Give the demo an entry point — it is the whole narrative

**Highest value.** This is `REVIEW.md` finding 1, and for a POC it is not a
usability gap but the story you are telling.

The current demo script is: run `make demo-relays`, read a 20-digit number off a
terminal, paste it into a box. Every person watching correctly concludes the
feature is a developer toy — not because the answer is bad, but because they
just watched you feed it an ID no operator will ever hold.

Land `/trace` on **recent relays that failed**, from the query in `REVIEW.md`.
Then the demo is: open the page, see five real failures from the last hour,
click one, read what happened. Nobody has to ask where the GUID came from,
because nobody ever sees one.

Keep it deliberately small for the POC — last hour, top ~10, no filters:

| Column | Source |
|---|---|
| time | Loki entry timestamp |
| chain · method | parsed off the entry line |
| what failed | the first `level="error"` message |
| — | row links to `/trace/<guid>` |

Even hard-limited to one hour with no filtering, this is the change that turns a
toy into a tool on screen.

## 2 · Fix the loading moment — it is the weakest second of the demo

With the AI on, `GET /api/trace/:guid` does the Loki read (~80 ms measured) and
then **blocks on the model** before returning anything. On stage that is several
seconds of a three-bar grey skeleton while you talk over dead air, and it is the
moment attention leaves the room.

The lines are ready almost immediately. Split the page into two requests:

1. **Lines first** — the page paints the evidence in under 100 ms. Something
   real is on screen before you finish your sentence.
2. **Explanation second** — lands into a card that is already framed and
   labelled, with a live "Reading 30 log lines…" state rather than a skeleton.

This is maybe an hour of work and it changes the perceived speed of the whole
feature. It also makes the page honest about what it is doing: evidence first,
interpretation second — the same order the design already argues for.

**Stretch, if there is time:** stream the summary. Watching the answer appear
word by word is the single most persuasive thing an AI feature can do in a
demo, and it converts the wait from a cost into the show. Worth it only after
the split above is working.

## 3 · Give the page a header, so it looks like part of the product

Every other page in this dashboard opens with a header. This one opens with a
naked input box floating over empty space, and that reads as unfinished before
anyone has read a word.

The header wants three things, all of which the design system already has:

- **The GUID as the page title**, in `gw-mono`, with a **copy link** button next
  to it. The page's stated purpose is being pasted to someone; on stage, "and I
  send this link to whoever is on call" is a beat worth being able to perform.
- **The outcome as a chip** — `gw-tag--ok` / `gw-tag--err`. What everyone wants
  to know first, readable from the back of the room.
- **A facts strip** — chain · interface · method · upstream · duration — using
  `.gw-stat` / `.gw-grid`, exactly like every other surface.

The facts strip is `REVIEW.md` finding 8, and it is what makes the page read as
*a product* rather than *a chat response in a card*. Ask the model for a
`facts` object of nullable fields; `null` renders `—`, which is the same
contract as the rest of the dashboard and is honest about a router running at
`info` that logs no timing.

Demote the search box to the right of the header, or below the fold. On a
detail page it is navigation, not the subject.

## 4 · Make the timeline the thing people screenshot

Currently a two-column list: a mono time, then a sentence. It is correct and it
is forgettable.

It is also the most inherently visual thing on the page and the natural hero of
a slide. A vertical rail with a dot per step, the dot coloured when that step is
where it went wrong, the offset in `gw-tnum` mono down the left, and the last
step marked as the outcome. Pure CSS, no library, an afternoon at most.

This is the screenshot that goes in the deck. Right now there isn't one.

## 5 · Constrain the answer shape, or the layout is a lottery

The prompt asks for "one paragraph" and sets no bound on the timeline or the
findings. That is fine for an API and bad for a stage: a nine-sentence summary
pushes everything below the fold, and a twelve-step timeline of runtime
scheduling noise buries the three steps that carry the story.

Add caps to `SYSTEM_PROMPT` in
[`trace-explain.ts`](../../apps/api/src/services/trace-explain.ts):

- summary — **at most three sentences**, outcome first
- timeline — **at most six steps**, and only steps that changed the outcome
- findings — **at most three**, most severe first

This is not just layout defence. Length caps make the answers better: the prompt
already tells the model not to narrate scheduling noise, and a hard cap is what
makes it choose.

## 6 · Two things that could go wrong live

- **The rate limit still applies with the AI on** — 10/min, per IP. Clicking
  through six traces during Q&A and reloading a couple of times is a realistic
  demo, and it ends in `Rate limit exceeded`. Caching by GUID (`REVIEW.md`
  finding 6) fixes this and is worth doing *for the demo alone*.
- **Revisiting a trace re-answers it.** Nothing is cached, so the trace you
  narrated during setup can come back worded differently when you open it again
  on stage. Same fix.

Also: run through the demo once end to end on the machine you will present from,
with the AI on, an hour before. The model call is the one part of this feature
that can be slow or fail for reasons outside the stack.

## 7 · Rename the nav item

`REVIEW.md` finding 11, kept here only because it is a one-line change and the
team **will** ask. "Trace" promises OpenTelemetry spans; someone in the room
will spend your first two minutes waiting for a waterfall. **Explain a relay**
is what the landing card already calls it, and it sets the right expectation
before the page loads.

---

## The demo path

For what it is worth, the sequence that lands best with what exists today:

1. **Start in the Try-me drawer**, not on `/trace`. Fire a relay that fails.
   This shows where a GUID comes from without saying the word.
2. **Click "explain this relay"** on the result. One click from a broken request
   to an explanation is the pitch, and it already works.
3. **Read the answer**, then open the log lines underneath it — "and here is
   every line it read, so you can check it." The evidence panel is the argument
   for trusting the feature; do not skip it.
4. **End on "What the logs don't say."** It is the most interesting thing on the
   page and the least expected: the tool reporting the limits of its own input,
   and naming what the router should be logging. That is the slide people
   remember, and it is the one nobody else's dashboard has.

If finding 1 lands in time, replace step 1 with the recent-failures list. Then
the demo opens on real failures from the last hour and never touches a terminal.

## Suggested order

Small enough to be realistic before a first showing:

1. Nav rename (7) — minutes.
2. Answer-shape caps (5) — minutes, and improves every answer.
3. Header, copy-link and facts strip (3) — the page stops looking unfinished.
4. Timeline rail (4) — the deck screenshot.
5. Cache by GUID (6) — demo insurance.
6. Split lines / explanation (2) — the perceived-speed win.
7. Recent-failures landing page (1) — the narrative, if the runway allows.

1–4 are visual and cheap. If time runs out, 1–4 plus 5 still gives a POC that
looks finished; 7 is what makes it look inevitable.
