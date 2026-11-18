# Conversational Ask UX — 18 November 2026

The customer's review requested a recognizable conversation while retaining the
system's structured answers, data isolation and run controls.

## Result

- A single chat-history rail in full view, with account and sign-out access.
  Returning to the dashboard restores its normal navigation.
- Right-aligned question bubbles, a centered reading column and flowing assistant
  text. Numbered headings remain; optional figures use compact inline treatments.
- An expanding bottom composer with a send control, follow-up prompts and the
  actual chain/page/time context. It resizes when switching between desktop and
  mobile and stops growing at 180px so long drafts remain scrollable.
- Copy feedback, answer timestamps and expandable source/time/coverage evidence
  remain available after each answer. Partial coverage still has a visible notice.
- Short answers keep their question visible. Long answers open at their start;
  reading older turns and loading previous pages preserve the reading position.
- The mobile dialog keeps the background inert, contains focus and prevents
  background dashboard overflow from widening the page.

## Evidence and scope

Story: sign in through the real UI, send a question through the API and PostgreSQL
worker, read an answer, carry a draft between views and submit a follow-up.

The separate `e2e/ask-presentation/chat.spec.ts` flow verifies desktop/mobile
layouts, both themes, question visibility, composer visibility and wrapping,
draft continuity, follow-ups, account controls, history access, narrow-screen
overflow and the absence of browser page errors. CI runs it as an independent
`ask-presentation` matrix job. The adversarial HTML and ownership fixtures remain
in the existing five-flow behavioral suite.

These captures use synthetic demo accounts and provider data. Auth, API, worker,
budget and PostgreSQL are real; MCP/Bedrock responses are deterministic fixtures.
They are not evidence of live customer health or fresh provider access. Only
Next's development overlay is suppressed; no product UI is replaced for capture.

The API answer schema, server-authored evidence, provider policy, budget,
retention, authorization, one-active-run enforcement and cancellation contracts
are preserved. Existing real HTTP/PostgreSQL checks remain separate from browser
fixtures and deployment acceptance.

Local validation passes with the pinned Node 26.13.1 / pnpm 12.21.0 toolchain:
4,246 workspace tests, workspace typecheck, 25 separate real HTTP/PostgreSQL
tests, all five behavioral Ask flows, the presentation flow and the disabled
Ask flow. API and web production builds pass. Lint has zero errors and 17
existing warnings; the changed chat components and presentation suite have no
lint warnings. Final-head hosted checks remain required before merge.

## Screenshots

The presentation suite (`ask-presentation.playwright.config.ts`) writes the full
chat in light and dark themes, a two-turn conversation, the empty state, the
desktop panel and the 390 × 844 mobile panel to its results directory
(`.playwright/ask-presentation`) on every run.
