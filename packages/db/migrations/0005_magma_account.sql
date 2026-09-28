-- MAG-2729 — the Magma Devs account marker. Decided 26 Aug 2026.
--
-- On a `managed` deployment the account created at first-run setup is Magma's
-- and stays after handover. The rule it answers to changed with it: "we keep no
-- standing admin account inside a customer's deployment" became "no hidden
-- Magma account, and none the customer can't see in their member list". So the
-- account is allowed to exist, and is required to be visible as ours.
--
-- This column records that provenance. It is written once, by first-run setup
-- under DEPLOYMENT_MODE=managed, and read only for display — no permission
-- check consults it, and nothing filters the member list, the CSV export or the
-- audit log on it.
--
-- Backfilled false, which is right for every deployment that exists today:
-- on-prem never has a Magma account, and a managed install predating this
-- column has no marked one to find.

ALTER TABLE "users" ADD COLUMN "is_magma_account" boolean DEFAULT false NOT NULL;
