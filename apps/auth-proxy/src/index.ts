import { handle, type ProxyEnv } from "./proxy.js";

export default {
  fetch: (request, env) => handle(request, env),
} satisfies ExportedHandler<ProxyEnv>;
