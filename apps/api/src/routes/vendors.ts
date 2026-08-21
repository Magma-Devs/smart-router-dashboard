/**
 * `GET /api/vendors/status` — what the upstream vendors say about themselves.
 *
 * A read-through of the Status Page Index (see `services/vendor-status.ts`):
 * the api holds the one cached connection to it so the browsers don't, and an
 * unreachable SPI answers `{ vendors: null }` with a 200 — this route never
 * turns someone else's outage into a dashboard error.
 */

import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import { VendorStatusService } from "../services/vendor-status.js";

export async function vendorRoutes(app: FastifyInstance) {
  // Per app instance, so the cache lives as long as the process (and a test
  // that builds its own app starts cold).
  const vendorStatus = new VendorStatusService({
    baseUrl: config.vendorStatus.url,
    timeoutMs: config.vendorStatus.timeoutMs,
    ttlMs: config.cacheTtl.lists * 1000,
    onError: (reason) => app.log.warn({ reason }, "vendor status read failed"),
  });

  app.get(
    "/api/vendors/status",
    {
      schema: {
        tags: ["Vendors"],
        summary: "Upstream vendor status from the Status Page Index",
        description:
          "Each vendor's own status page verdict, cached for 60s. `vendors` is " +
          "null when the index could not be read — no chip, no banner, nothing invented.",
      },
    },
    async () => await vendorStatus.read(),
  );
}
