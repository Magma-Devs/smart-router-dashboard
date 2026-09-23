#!/usr/bin/env node
/**
 * Make a values.yml safe to share, keeping everything the dashboard reads.
 *
 *   node apps/api/scripts/redact-values.mjs path/to/values.yml > values.redacted.yml
 *
 * ## Why this is safe to hand over
 *
 * `ConfigurationService` reads exactly nine fields, and eight of them are not
 * secrets — the provider NAMES are already Prometheus `provider_address`
 * labels, and the roles, interfaces and addons are topology and capability
 * declarations. The one sensitive field is `endpoints[].url`, because upstream
 * provider URLs routinely carry an API key in the path or query.
 *
 * So this keeps the eight and replaces the ninth.
 *
 * ## Allowlist, not denylist
 *
 * It rebuilds the document from the fields it recognises rather than deleting
 * the ones it knows are bad. A denylist ships whatever it failed to think of —
 * a `token:` a chart added last month, a comment with a key in it. Nothing
 * reaches the output unless it is named below.
 *
 * URLs become `https://<node>-<n>.redacted.invalid`: a real scheme and a
 * stable distinct host per endpoint, because the parser DROPS an endpoint
 * whose url is empty, and because the api masks urls to scheme+host anyway
 * before they leave it. Nothing downstream can tell the difference.
 */
import { readFileSync } from "node:fs";
import { parse, stringify } from "yaml";

const path = process.argv[2];
if (!path) {
  console.error("usage: node apps/api/scripts/redact-values.mjs <values.yml> > values.redacted.yml");
  process.exit(2);
}

const raw = parse(readFileSync(path, "utf8"));
const seen = { routers: 0, nodes: 0, endpoints: 0, urls: 0, dropped: new Set() };

/** Note every key we are NOT carrying over, so the summary can list them. */
function noteDropped(obj, kept) {
  for (const k of Object.keys(obj ?? {})) if (!kept.includes(k)) seen.dropped.add(k);
}

function redactEndpoint(ep, nodeName, index) {
  noteDropped(ep, ["url", "interface", "addons", "internal_path", "internal-path", "internalPath"]);
  seen.endpoints += 1;
  if (ep.url) seen.urls += 1;
  const internalPath = ep.internal_path ?? ep["internal-path"] ?? ep.internalPath;
  return {
    // A real scheme and a distinct host: the parser drops an endpoint with no
    // url, and everything downstream masks to scheme+host regardless.
    url: `https://${String(nodeName).toLowerCase().replace(/[^a-z0-9-]/g, "")}-${index}.redacted.invalid`,
    ...(ep.interface ? { interface: String(ep.interface) } : {}),
    ...(Array.isArray(ep.addons) && ep.addons.length ? { addons: ep.addons.map(String) } : {}),
    ...(internalPath ? { internal_path: String(internalPath) } : {}),
  };
}

function redactNode(node) {
  noteDropped(node, ["name", "is_backup", "is-backup", "isBackup", "endpoints"]);
  seen.nodes += 1;
  const isBackup = node.is_backup ?? node["is-backup"] ?? node.isBackup;
  return {
    name: String(node.name ?? ""),
    // Kept verbatim: primary vs backup is the single most useful thing in this
    // file for explaining why a failover did not save a request.
    ...(isBackup === undefined ? {} : { is_backup: Boolean(isBackup) }),
    endpoints: (node.endpoints ?? []).map((ep, i) => redactEndpoint(ep, node.name ?? "node", i)),
  };
}

function redactRouter(router) {
  noteDropped(router, ["id", "network", "nodes", "pathBased", "path-based", "path_based", "custom_url_prefix"]);
  seen.routers += 1;
  const pathBased = router.pathBased ?? router["path-based"] ?? router.path_based;
  return {
    ...(router.id ? { id: String(router.id) } : {}),
    network: String(router.network ?? ""),
    ...(pathBased === undefined ? {} : { pathBased }),
    // custom_url_prefix is deliberately NOT carried: it feeds the public
    // gateway hostname, which is the customer's, and no analysis needs it.
    nodes: (router.nodes ?? []).map(redactNode),
  };
}

if (!Array.isArray(raw?.routers)) {
  console.error(
    "no `routers:` key — this looks like a raw SR_CONFIG, not helm values.\n" +
      "Only the helm format carries is_backup, which is the part worth sharing.",
  );
  process.exit(1);
}

process.stdout.write(
  "# Redacted by scripts/redact-values.mjs — every endpoint url replaced.\n" +
    "# Provider names, roles, interfaces and addons are kept: none are secrets,\n" +
    "# and they are what the dashboard reads.\n" +
    stringify({ routers: raw.routers.map(redactRouter) }),
);

console.error(
  `\nredacted  ${seen.routers} routers · ${seen.nodes} nodes · ${seen.endpoints} endpoints` +
    `\nurls      ${seen.urls} replaced` +
    `\ndropped   ${[...seen.dropped].sort().join(", ") || "(nothing unrecognised)"}` +
    `\n\nReview the output before sharing it. Everything above under "dropped" was\n` +
    `left out; if one of those matters to you, it is not in the file you send.\n`,
);
