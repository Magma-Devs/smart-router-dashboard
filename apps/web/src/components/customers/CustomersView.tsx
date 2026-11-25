"use client";

/**
 * Customers — the names this deployment gives its callers' customer-ids.
 *
 * The routers count every request under the `customer-id` header its caller
 * sends, often an opaque id. An admin names an id here; the request lists and
 * Ask show the name wherever the id appears. Every member reads the list.
 */

import { useMemo, useState } from "react";
import { useSWRConfig } from "swr";
import {
  CUSTOMER_NAME_MAX_LENGTH,
  parseCustomerName,
  type CustomerRow,
  type CustomersResponse,
} from "@sr/shared";
import { apiSend } from "@/lib/api-client";
import { useApi } from "@/hooks/use-api";
import { useMe } from "@/hooks/use-me";
import { CopyButton } from "@/components/gateway/CopyButton";
import { LocalTime } from "@/components/gateway/LocalTime";
import { fmtComma } from "@/lib/format";

const CUSTOMERS_KEY = "/api/customers";

export function CustomersView() {
  const { isAdmin } = useMe();
  // Read on open and after a save: each read sums a day of the routers' counters.
  const customers = useApi<CustomersResponse>(CUSTOMERS_KEY, 0);
  const { mutate } = useSWRConfig();
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const rows = useMemo(() => {
    const all = customers.data?.customers ?? [];
    const q = search.trim().toLowerCase();
    return q
      ? all.filter(
          (c) => c.id.toLowerCase().includes(q) || (c.name ?? "").toLowerCase().includes(q),
        )
      : all;
  }, [customers.data, search]);
  const named = customers.data?.customers.filter((c) => c.name).length ?? 0;

  function edit(row: CustomerRow) {
    setEditing(row.id);
    setDraft(row.name ?? "");
    setError(null);
  }

  async function save(id: string, name: string | null) {
    if (name !== null) {
      const parsed = parseCustomerName(name);
      if (!parsed.ok) return setError(parsed.problem);
      name = parsed.name;
    }
    setBusy(true);
    setError(null);
    try {
      await apiSend("POST", "/api/customers/name", { customer: id, name });
      setEditing(null);
      // The request lists read the names on their own key.
      await Promise.all([customers.mutate(), mutate("/api/customers/names")]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The name could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="gw-page">
      <div
        className="gw-row"
        style={{ justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}
      >
        <h1 style={{ margin: 0 }}>Customers</h1>
      </div>
      <p style={{ margin: "0 0 20px", fontSize: 13, color: "var(--text-3)", maxWidth: 720 }}>
        The routers count each request under the <span className="gw-mono">customer-id</span> header
        its caller sends.
        {isAdmin
          ? " Give an id a name, and the request lists and Ask show the name instead of the id."
          : " An admin can name an id; the request lists and Ask then show the name instead of the id."}
      </p>

      <div className="gw-row" style={{ gap: 12, alignItems: "center", marginBottom: 12 }}>
        <input
          className="gw-input"
          style={{ maxWidth: 320 }}
          placeholder="Find a name or an id"
          aria-label="Find a customer"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <span style={{ fontSize: 12, color: "var(--text-3)" }}>
          {customers.data
            ? `${fmtComma(customers.data.customers.length)} customer-ids · ${fmtComma(named)} named`
            : ""}
        </span>
      </div>

      {customers.data?.requestsUnavailable && (
        <div role="status" style={{ fontSize: 12, color: "var(--warn)", marginBottom: 12 }}>
          The metrics store did not answer, so only named ids are listed, without their requests.
        </div>
      )}
      {error && (
        <div role="alert" style={{ fontSize: 12, color: "var(--err)", marginBottom: 12 }}>
          {error}
        </div>
      )}

      <div className="gw-card" style={{ padding: 0, overflowX: "auto" }}>
        {customers.error && (
          <div
            role="alert"
            style={{
              padding: "12px 14px",
              fontSize: 12,
              color: "var(--err)",
              borderBottom: "1px solid var(--line)",
            }}
          >
            Could not load the customers:{" "}
            {customers.error instanceof Error ? customers.error.message : "request failed"}
          </div>
        )}
        <table className="gw-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Customer-id</th>
              <th style={{ textAlign: "right" }}>Requests, last 24 hours</th>
              <th style={{ textAlign: "right" }}>Named</th>
              {isAdmin && <th aria-label="Actions" />}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td style={{ minWidth: 220 }}>
                  {editing === row.id ? (
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        void save(row.id, draft);
                      }}
                      style={{ display: "flex", gap: 6 }}
                    >
                      <input
                        className="gw-input"
                        style={{ padding: "5px 9px", fontSize: 12.5 }}
                        autoFocus
                        maxLength={CUSTOMER_NAME_MAX_LENGTH * 2}
                        aria-label={`Name for ${row.id}`}
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Escape") setEditing(null);
                        }}
                      />
                      <button className="gw-btn gw-btn--primary" type="submit" disabled={busy}>
                        Save
                      </button>
                      <button
                        className="gw-btn"
                        type="button"
                        disabled={busy}
                        onClick={() => setEditing(null)}
                      >
                        Cancel
                      </button>
                    </form>
                  ) : row.name ? (
                    <span style={{ fontSize: 13, fontWeight: 600 }}>{row.name}</span>
                  ) : (
                    <span style={{ fontSize: 12, color: "var(--text-4)" }}>No name</span>
                  )}
                </td>
                <td style={{ maxWidth: 360 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                    <span
                      className="gw-mono"
                      title={row.id}
                      style={{
                        fontSize: 11.5,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        minWidth: 0,
                      }}
                    >
                      {row.id}
                    </span>
                    <CopyButton text={row.id} />
                  </div>
                </td>
                <td className="gw-mono gw-tnum" style={{ textAlign: "right" }}>
                  {row.requests === null ? "—" : fmtComma(row.requests)}
                </td>
                <td
                  style={{
                    textAlign: "right",
                    whiteSpace: "nowrap",
                    fontSize: 12,
                    color: "var(--text-3)",
                  }}
                >
                  {row.changedAt ? <LocalTime t={Date.parse(row.changedAt)} format="day" /> : "—"}
                </td>
                {isAdmin && (
                  <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                    {editing !== row.id && (
                      <span style={{ display: "inline-flex", gap: 6 }}>
                        <button className="gw-btn" disabled={busy} onClick={() => edit(row)}>
                          {row.name ? "Rename" : "Name"}
                        </button>
                        {row.name && (
                          <button
                            className="gw-btn gw-btn--ghost"
                            disabled={busy}
                            onClick={() => void save(row.id, null)}
                          >
                            Clear
                          </button>
                        )}
                      </span>
                    )}
                  </td>
                )}
              </tr>
            ))}
            {customers.data && rows.length === 0 && (
              <tr>
                <td
                  colSpan={isAdmin ? 5 : 4}
                  style={{ fontSize: 12.5, color: "var(--text-3)", padding: "18px 14px" }}
                >
                  {search
                    ? "No customer-id or name matches."
                    : "No request named a customer-id in the last 24 hours, and no id has a name."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
