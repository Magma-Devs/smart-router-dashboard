import { buildApp } from "./app.js";
import { config } from "./config.js";
import { createShutdown, onStopSignals } from "./shutdown.js";

async function main() {
  // Installed before the app is built: the api runs as PID 1 in its image,
  // and the kernel drops a signal PID 1 has no handler for, so without these
  // SIGTERM does nothing and the pod waits out its grace period.
  const shutdown = createShutdown({
    timeoutMs: config.server.shutdownTimeoutMs,
    exit: (code) => process.exit(code),
  });
  onStopSignals(shutdown);

  let app;
  try {
    app = await buildApp();
  } catch (err) {
    // A refused configuration (a half METRICS_SCOPE pair, say) — the reason,
    // not a stack trace, is what the pod log needs to show.
    console.error(`smart-router-dashboard api: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  if (!shutdown.attach(app)) return;
  try {
    await app.listen({ port: config.server.port, host: config.server.host });
    app.log.info(`smart-router-dashboard api on :${config.server.port}`);
  } catch (err) {
    // A signal during listen closes the app under it; the stop sequence exits.
    if (shutdown.stopping) return;
    app.log.error(err);
    process.exit(1);
  }
}

void main();
