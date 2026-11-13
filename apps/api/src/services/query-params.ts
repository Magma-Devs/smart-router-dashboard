/**
 * What a request may name where its value ends up inside a store query
 * (PromQL, LogQL): one strict pattern per kind of value, checked by the
 * route's schema, so anything else is a 400 before any read. No route takes
 * query text; these are the values the api builds its queries around.
 *
 * Where a value reaches a query it is escaped as well, by the helpers in
 * `@sr/shared`'s `query-text.ts` - the pattern is the first of two locks,
 * not the only one.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import type { ConfigurationService } from "./configuration.js";
import { LOOKUP_ID } from "./router-log.js";

/** A chain's spec, the `spec` label (`ETH1`, `COSMOSHUB`): letters, digits, `_`, `-`. */
export const SPEC_PATTERN = "^[A-Za-z0-9_-]{1,64}$";

/** A config router id: the chart's ids (letters, digits, `-`) and the raw config's chain ids. */
export const ROUTER_ID_PATTERN = "^[A-Za-z0-9_.:-]{1,128}$";

/**
 * A value of the router scope label (`?router=`): a Service name, a router id
 * or a job name - letters, digits and `_ . : / @ + -`. `GET /api/metrics/routers`
 * lists only values of this form, so the filter never offers one it can't send.
 */
export const SCOPE_VALUE_PATTERN = "^[A-Za-z0-9_.:/@+-]{1,253}$";
export const SCOPE_VALUE = new RegExp(SCOPE_VALUE_PATTERN);

/**
 * An upstream (node) name the store labels a series with, when the values
 * file doesn't list it: a plain token (`eth-publicnode`, the relay cache's
 * `Cached`). A name the values file lists is taken as written
 * (`isUpstreamName`), whatever it holds.
 */
export const UPSTREAM_TOKEN = /^[A-Za-z0-9_.:@+-]{1,128}$/;

/** The longest upstream name a request may carry. */
export const UPSTREAM_MAX = 128;

/** Whether a request's upstream name is one a query may be built around: a plain token, or a node the values file lists. */
export function isUpstreamName(name: string, configSvc?: Pick<ConfigurationService, "getRouters">): boolean {
  if (name.length === 0 || name.length > UPSTREAM_MAX) return false;
  if (UPSTREAM_TOKEN.test(name)) return true;
  return (configSvc?.getRouters() ?? []).some((r) => r.nodes.some((n) => n.name === name));
}

/** The 400 message for an upstream name that is neither. */
export const UPSTREAM_REFUSED = "not an upstream: a node the values file lists, or letters, digits and _ . : @ + - only, up to 128";

/**
 * A route's `preValidation` hook that answers 400 for an upstream name in
 * `param` that `isUpstreamName` refuses. A hook rather than a check in the
 * handler, so the answer comes before every hook that may read a store. A
 * value that isn't one string is left to the schema.
 */
export function upstreamParamCheck(param: string, configSvc: () => Pick<ConfigurationService, "getRouters"> | undefined) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | undefined> => {
    const value = (request.query as Record<string, unknown> | undefined)?.[param];
    if (typeof value !== "string" || isUpstreamName(value, configSvc())) return undefined;
    return reply.status(400).send({ statusCode: 400, error: "Bad Request", message: `${param} is ${UPSTREAM_REFUSED}` });
  };
}

/** Querystring and params properties, for the routes' schemas. */
export const PARAMS = {
  spec: { type: "string" as const, pattern: SPEC_PATTERN, description: "Chain spec label, e.g. ETH1" },
  router: {
    type: "string" as const,
    pattern: SCOPE_VALUE_PATTERN,
    description:
      "Restrict to ONE router deployment — a value of the ROUTER_SCOPE_LABEL target label, as listed by GET /api/metrics/routers (optional; omit for cluster-wide)",
  },
  routerId: { type: "string" as const, pattern: ROUTER_ID_PATTERN, description: "A config router id, from GET /api/config/routers" },
  upstream: {
    type: "string" as const,
    minLength: 1,
    maxLength: UPSTREAM_MAX,
    description: "An upstream (node) name: one the values file lists, or a plain token (letters, digits and _ . : @ + -)",
  },
  lookupId: {
    type: "string" as const,
    pattern: LOOKUP_ID.source,
    description: "The request ID (the GUID the router puts in its errors), the transaction hash, or the caller's X-Request-Id",
  },
};
