import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import { Agent as UndiciAgent, setGlobalDispatcher } from "undici";

function createIpv4Lookup() {
  return (hostname, options, callback) => {
    let resolvedOptions = options;
    let resolvedCallback = callback;

    if (typeof resolvedOptions === "function") {
      resolvedCallback = resolvedOptions;
      resolvedOptions = {};
    } else if (typeof resolvedOptions === "number") {
      resolvedOptions = { family: resolvedOptions };
    }

    dns.lookup(hostname, { family: 4, all: false }, (error, address, family) => {
      if (error) {
        resolvedCallback(error);
        return;
      }

      if (resolvedOptions?.all) {
        resolvedCallback(null, [{ address, family: family ?? 4 }]);
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

  // Force IPv4 for the legacy http/https modules.
  if (typeof dns.setDefaultResultOrder === "function") {
    dns.setDefaultResultOrder("ipv4first");
  }

  http.globalAgent = ipv4HttpAgent;
  https.globalAgent = ipv4HttpsAgent;

  // Node 18+ uses undici for native fetch, which googleapis v144/gaxios v6
  // relies on.  undici bypasses https.globalAgent entirely, so we must
  // configure it separately via setGlobalDispatcher.  Without this, undici
  // may attempt IPv6 connections that silently hang on IPv6-unroutable hosts.
  setGlobalDispatcher(
    new UndiciAgent({
      connect: {
        lookup: ipv4Lookup
      }
    })
  );

  networkStackConfigured = true;
  console.log("Configured network stack to prefer IPv4 for outbound requests.");
}
