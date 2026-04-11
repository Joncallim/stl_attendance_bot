import http from "node:http";
import https from "node:https";

export const keepAliveHttpAgent = new http.Agent({ keepAlive: true });
export const keepAliveHttpsAgent = new https.Agent({ keepAlive: true });

// Back-compat aliases used by callers that import ipv4Http(s)Agent.
export const ipv4HttpAgent = keepAliveHttpAgent;
export const ipv4HttpsAgent = keepAliveHttpsAgent;

let networkStackConfigured = false;

export function configureNetworkStack() {
  if (networkStackConfigured) {
    return;
  }

  http.globalAgent = keepAliveHttpAgent;
  https.globalAgent = keepAliveHttpsAgent;
  networkStackConfigured = true;
  console.log("Configured network stack (keep-alive agents).");
}
