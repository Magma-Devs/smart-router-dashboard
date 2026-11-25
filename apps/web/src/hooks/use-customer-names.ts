"use client";

import { useMemo } from "react";
import type { CustomerNamesResponse } from "@sr/shared";
import { useAuthMode } from "@/components/gateway/auth-mode";
import { useApi } from "@/hooks/use-api";

const NONE: ReadonlyMap<string, string> = new Map();

/**
 * The deployment's names for its callers' customer-ids, id → name. Empty
 * without accounts (there is no database to hold them) and until the first
 * read answers, so every caller shows the bare id then.
 */
export function useCustomerNames(): ReadonlyMap<string, string> {
  const authEnabled = useAuthMode();
  const { data } = useApi<CustomerNamesResponse>(
    authEnabled ? "/api/customers/names" : null,
    60_000,
  );
  return useMemo(() => (data ? new Map(Object.entries(data.names)) : NONE), [data]);
}
