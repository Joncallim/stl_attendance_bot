import http from "node:http";
import https from "node:https";

/*
 * Shared keep-alive agents reduce connection setup overhead for Telegram and
 * Google requests. The exported HTTPS name is retained because the API clients
 * import it directly; it does not force IPv4 by itself.
 */
const httpAgent = new http.Agent({ keepAlive: true });
export const ipv4HttpsAgent = new https.Agent({ keepAlive: true });

let networkStackConfigured = false;

export function configureNetworkStack() {
  if (networkStackConfigured) {
    return;
  }

  http.globalAgent = httpAgent;
  https.globalAgent = ipv4HttpsAgent;
  networkStackConfigured = true;
  console.log("Configured network stack (keep-alive agents).");
}
