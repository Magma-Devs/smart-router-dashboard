/**
 * `GET /api/vendors/status` — what the upstream vendors say about themselves,
 * for the chains THIS deployment routes through them.
 *
 * A read-through of the Status Page Index (see `services/vendor-status.ts`):
 * the api holds the one cached connection to it so the browsers don't, reads
 * the mounted values file to know whose page matters and for which chains, and
 * answers `{ vendors: null }` with a 200 when the index is unreachable — this
 * route never turns someone else's outage into a dashboard error.
 */

import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import { VendorStatusService } from "../services/vendor-status.js";
import { collectVendorChainUse } from "../services/vendor-components.js";

export async function vendorRoutes(app: FastifyInstance) {
  // Per app instance, so the caches live as long as the process (and a test
  // that builds its own app starts cold).
  const vendorStatus = new VendorStatusService({
    baseUrl: config.vendorStatus.url,
    timeoutMs: config.vendorStatus.timeoutMs,
    ttlMs: config.vendorStatus.ttlMs,
    failureTtlMs: config.vendorStatus.failureTtlMs,
    onError: (reason) => app.log.warn({ reason }, "vendor status read failed"),
  });
  if (vendorStatus.disabled) {
    app.log.info("vendor status is off (STATUS_PAGE_INDEX_URL is empty) — no status index will be called");
  }

  app.get(
    "/api/vendors/status",
    {
      schema: {
        tags: ["Vendors"],
        summary: "Upstream vendor status for the chains this deployment routes",
        description:
          "Per vendor: a verdict for each chain the mounted values file routes through " +
          "them, taken from the status-page components that cover that chain and the " +
          "surfaces we dial — never from the vendor's global headline. Cached 60s; a " +
          "failed refresh keeps serving the last good read with `stale: true`. " +
          "`vendors` is null when the index has never answered or is switched off " +
          "(`disabled`), and a chain with no matching component says why in `reason` " +
          "— no chip, no banner, nothing invented.",
      },
    },
    // The topology is re-read per request (the config service holds it in
    // memory); the SPI reads behind it are the cached part.
    async () => await vendorStatus.read(collectVendorChainUse(app.routerConfig.getRouters())),
  );
}
