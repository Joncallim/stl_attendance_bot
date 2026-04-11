import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import { instance as gaxiosInstance } from "gaxios";

function createIpv4Lookup() {
  return (hostname, options, callback) => {
    let resolvedCallback = callback;

    if (typeof options === "function") {
      resolvedCallback = options;
    }

    dns.lookup(hostname, { family: 4, all: false }, (error, address, family) => {
      if (error) {
        resolvedCallback(error);
        return;
      }

      resolvedCallback(null, address, family ?? 4);
    });
  };
}

const ipv4Lookup = createIpv4Lookup();

export const ipv4HttpAgent = new http.Agent({
  keepAlive: true,
  lookup: ipv4Lookup
});

export const ipv4HttpsAgent = new https.Agent({
  keepAlive: true,
  lookup: ipv4Lookup
});

let networkStackConfigured = false;

export function configureNetworkStack() {
  if (networkStackConfigured) {
    return;
  }

  // Force IPv4 for the legacy http/https modules (used by telegraf etc.).
  if (typeof dns.setDefaultResultOrder === "function") {
    dns.setDefaultResultOrder("ipv4first");
  }

  http.globalAgent = ipv4HttpAgent;
  https.globalAgent = ipv4HttpsAgent;

  // gaxios (used by googleapis + google-auth-library) uses node-fetch under
  // the hood, which uses Node's legacy https module.  gaxios creates its own
  // https.Agent per request unless opts.agent is set — bypassing
  // https.globalAgent.  Setting defaults.agent forces all gaxios requests
  // (Sheets API calls AND auth token fetches) through our IPv4-only agent.
  gaxiosInstance.defaults.agent = ipv4HttpsAgent;

  networkStackConfigured = true;
  console.log("Configured network stack to prefer IPv4 for outbound requests.");
}
