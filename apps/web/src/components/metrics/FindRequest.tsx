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
 * What it reads: a request ID from a router on smart-router v1.6.1 or later
 * carries the second it was sent, so it is read there, in about a second,
 * whatever the window. Any other value - a transaction hash, a caller's id,
 * an older router's ID - is read over the page's window, and the reader can
 * widen it to 30 days (a heavy read on a busy deployment, so on purpose). */

import { useEffect, useState } from "react";
import { WINDOWS, type MetricWindow, type RequestLookup } from "@sr/shared";
import { useApi } from "@/hooks/use-api";
import { SkelLine } from "@/components/gateway/Skel";
import { IconSearch } from "@/components/gateway/icons";
import { linkRequest, requestFromUrl } from "@/lib/request-in-url";
import { filterSelectStyle, LOOKUP_REFUSED, MatchesNote, NotFound, unreadableWords } from "./request-log";
import { Details as RequestDetails, RESULT } from "./ErrorRequests";
import { Details as TxDetails, resultOf as txResultOf } from "./TransactionLog";

export function FindRequest({ win }: { win: MetricWindow }) {
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
      {id && <Found key={id + win} id={id} win={win} onClose={() => find(null)} />}
    </div>
  );
}

/** The request looked up: its result as a tag, then the opened row - a transaction's send row when it is one. */
function Found({ id, win, onClose }: { id: string; win: MetricWindow; onClose: () => void }) {
  const [wide, setWide] = useState(false);
  const { data, error, isLoading } = useApi<RequestLookup>(`/api/requests/${encodeURIComponent(id)}?window=${wide ? "30d" : win}`, 0);
  const row = data?.row ?? null;
  const tx = data?.transaction ?? null;
  const tag = tx ? txResultOf(tx) : row ? RESULT[row.result] : null;
  const hint = !tx && row ? RESULT[row.result].hint : undefined;
  return (
    <div className="gw-card" style={{ padding: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", borderBottom: "1px solid var(--line)" }}>
        {/* The request names itself below; only a value that isn't its ID (a hash, a caller's id) is repeated here. */}
        {row?.guid !== id && (
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-2)" }}>Looked up <span className="gw-mono">{id}</span></span>
        )}
        {tag && <span className="gw-tag" title={hint} style={{ fontSize: 10, color: tag.color, borderColor: "currentColor" }}>{tag.label}</span>}
        <span style={{ flex: 1 }} />
        <button onClick={onClose} aria-label="Close" style={{ border: "none", background: "none", color: "var(--text-3)", cursor: "pointer", fontSize: 14, padding: 0, fontFamily: "inherit" }}>✕</button>
      </div>
      <div style={{ padding: "12px 16px 16px", fontSize: 12 }}>
        {isLoading ? (
          <SkelLine w="50%" />
        ) : error && !data ? (
          <div style={{ color: "var(--text-4)" }}>{LOOKUP_REFUSED}</div>
        ) : data && !data.available ? (
          <div style={{ color: "var(--text-4)" }}>{unreadableWords(data.reason)}</div>
        ) : !row ? (
          <NotFound id={id} rangeWords={`of the last ${WINDOWS[win].label}`} wide={wide} onWiden={() => setWide(true)} />
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
