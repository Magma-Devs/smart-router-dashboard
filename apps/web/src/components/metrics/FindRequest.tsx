"use client";

/* FindRequest - the Metrics page's "Find a request" tab: one request, by its
 * ID, its transaction hash or the caller's own request ID, whatever happened
 * to it - answered, retried, refused or failed. The same look-up the Errors
 * and Transactions tabs carry (`GET /api/requests/:guid`), on a page of its
 * own, because somebody looking for a request that went fine doesn't open the
 * Errors tab. The top bar's search box lands here (`lib/request-search.ts`),
 * and the request is in the URL (`?request=`, `lib/request-in-url.ts`), so a
 * link opens it.
 *
 * What it shows is the opened row the two log tabs show - the request, every
 * try in order, where it landed, what the client got - and, for a
 * transaction, its send row (hash, Sent / Refused / Outcome unknown), which
 * the api reads from the same lines (`transaction` on the answer).
 *
 * What it reads: the search is not bound to the page's time range. A request
 * ID from a router on smart-router v1.6.1 or later carries the second it was
 * sent, so it is read there, in about a second. Any other value - a
 * transaction hash, a caller's id, an older router's ID - is searched over
 * the last 30 days, newest first, until it is found or the search reaches its
 * size or time limit (`searchLines` in the api); then "not found" says how
 * far back it looked. */

import { useEffect, useState } from "react";
import type { RequestLookup } from "@sr/shared";
import { useApi } from "@/hooks/use-api";
import { Spinner } from "@/components/gateway/BusyButton";
import { LocalTime } from "@/components/gateway/LocalTime";
import { IconSearch } from "@/components/gateway/icons";
import { linkRequest, requestFromUrl } from "@/lib/request-in-url";
import { filterSelectStyle, LOOKUP_REFUSED, MatchesNote, unreadableWords } from "./request-log";
import { Details as RequestDetails } from "./ErrorRequests";
import { Details as TxDetails } from "./TransactionLog";

export function FindRequest() {
  // The request in focus is the URL's: a link opens it, Back returns to the one before.
  const [id, setId] = useState<string | null>(requestFromUrl);
  const [draft, setDraft] = useState(() => requestFromUrl() ?? "");
  useEffect(() => {
    const onPop = () => { const r = requestFromUrl(); setId(r); setDraft(r ?? ""); };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const find = (v: string | null) => { setId(v); linkRequest(v); };
  const typed = draft.trim();
  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div className="gw-card">
        {/* Enter searches: the box says what it takes, and the tab's name says what it does. */}
        <form role="search" onSubmit={(e) => { e.preventDefault(); if (typed) find(typed); }} style={{ position: "relative", maxWidth: 640 }}>
          <span style={{ position: "absolute", left: 10, top: 0, bottom: 0, display: "flex", alignItems: "center", color: "var(--text-4)" }}><IconSearch size={14} /></span>
          <input autoFocus enterKeyHint="search" aria-label="Request ID, transaction hash or your own request ID" value={draft} onChange={(e) => setDraft(e.target.value)}
            placeholder="Request ID, transaction hash or your own request ID"
            className="gw-mono" style={{ ...filterSelectStyle, height: 36, width: "100%", maxWidth: "none", paddingLeft: 30, fontSize: 12.5 }} />
        </form>
      </div>
      {id && <Found key={id} id={id} onClose={() => find(null)} />}
    </div>
  );
}

/** The request looked up, as its opened row - a transaction's send row when it is one. The row leads with its own status, so nothing above it repeats it. */
function Found({ id, onClose }: { id: string; onClose: () => void }) {
  // Whatever the page's window: a search looks as far back as the logs are read
  // (30 days). A search that stopped early is carried on from where it stopped,
  // on purpose: each part is one more size-limited read of the logs.
  const [oldest] = useState(() => Date.now() - 30 * 86_400_000);
  const [before, setBefore] = useState<number | null>(null);
  const q = before == null ? "window=30d" : `from=${oldest}&to=${Math.floor(before)}`;
  const { data, error, isLoading } = useApi<RequestLookup>(`/api/requests/${encodeURIComponent(id)}?${q}`, 0);
  const row = data?.row ?? null;
  const tx = data?.transaction ?? null;
  return (
    <div className="gw-card" style={{ padding: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", borderBottom: "1px solid var(--line)" }}>
        {/* The request names itself below; only a value that isn't its ID (a hash, a caller's id) is repeated here. */}
        {row?.guid !== id && (
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-2)" }}>Looked up <span className="gw-mono">{id}</span></span>
        )}
        <span style={{ flex: 1 }} />
        <button onClick={onClose} aria-label="Close" style={{ border: "none", background: "none", color: "var(--text-3)", cursor: "pointer", fontSize: 14, padding: 0, fontFamily: "inherit" }}>✕</button>
      </div>
      <div style={{ padding: "12px 16px 16px", fontSize: 12 }}>
        {isLoading ? (
          <Searching />
        ) : error && !data ? (
          <div style={{ color: "var(--text-4)" }}>{LOOKUP_REFUSED}</div>
        ) : data && !data.available ? (
          <div style={{ color: "var(--text-4)" }}>{unreadableWords(data.reason)}</div>
        ) : !row ? (
          <div style={{ color: "var(--text-4)" }}>
            {data?.searchedFrom != null ? (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <span>Not in the router&apos;s logs back to <LocalTime t={data.searchedFrom} format="dateTime" />.</span>
                <button onClick={() => setBefore(data.searchedFrom!)} style={{ border: "none", background: "none", color: "var(--brand)", cursor: "pointer", padding: 0, fontSize: 12, fontWeight: 600, fontFamily: "inherit" }}>
                  Search older logs
                </button>
              </span>
            ) : (
              <>No request with this ID or hash in the router&apos;s logs.</>
            )}
          </div>
        ) : (
          <div style={{ display: "grid", gap: 8 }}>
            <MatchesNote matches={data?.matches} />
            {tx ? <TxDetails row={tx} /> : <RequestDetails row={row} />}
          </div>
        )}
      </div>
    </div>
  );
}

/** While the logs are searched: a request ID answers in about a second; a hash can take up to a minute, so after a few seconds it says it is still going. */
function Searching() {
  const [long, setLong] = useState(false);
  useEffect(() => { const t = setTimeout(() => setLong(true), 4000); return () => clearTimeout(t); }, []);
  return (
    <div role="status" style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--text-3)" }}>
      <Spinner />
      {long ? "Still searching, older logs now…" : "Searching the router's logs…"}
    </div>
  );
}
