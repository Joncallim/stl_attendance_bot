import dns from "node:dns";
import http from "node:http";
import https from "node:https";

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

  if (typeof dns.setDefaultResultOrder === "function") {
    dns.setDefaultResultOrder("ipv4first");
  }

  http.globalAgent = ipv4HttpAgent;
  https.globalAgent = ipv4HttpsAgent;
  networkStackConfigured = true;
  console.log("Configured network stack to prefer IPv4 for outbound requests.");
}
