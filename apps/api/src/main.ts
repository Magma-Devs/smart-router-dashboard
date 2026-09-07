import { buildApp } from "./app.js";
import { config } from "./config.js";

async function main() {
  let app;
  try {
    app = await buildApp();
  } catch (err) {
    // A refused configuration (a half METRICS_SCOPE pair, say) — the reason,
    // not a stack trace, is what the pod log needs to show.
    console.error(`smart-router-dashboard api: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  try {
    await app.listen({ port: config.server.port, host: config.server.host });
    app.log.info(`smart-router-dashboard api on :${config.server.port}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

void main();
