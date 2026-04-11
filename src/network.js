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

// Attempt to configure the undici global dispatcher so that Node's native
// fetch (used by gaxios v6 / googleapis v144) also resolves to IPv4 only.
//
// `node:undici` exposes the SAME internal dispatcher instance that powers
// `globalThis.fetch`.  It became importable in Node 21+.  On older Node
// versions the import will throw ERR_UNKNOWN_BUILTIN_MODULE; in that case
// we skip gracefully — the dns.setDefaultResultOrder("ipv4first") call in
// configureNetworkStack() is still in effect as a weaker fallback.
let _setGlobalDispatcher = null;
let _UndiciAgent = null;

try {
  const nodeUndici = await import("node:undici");
  _setGlobalDispatcher = nodeUndici.setGlobalDispatcher;
  _UndiciAgent = nodeUndici.Agent;
} catch {
  // node:undici not available on this Node version — skip.
}

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

  // Configure undici's global dispatcher so that native fetch (gaxios v6)
  // also only connects over IPv4.  Only possible when node:undici is
  // available (Node 21+).
  if (_setGlobalDispatcher && _UndiciAgent) {
    _setGlobalDispatcher(
      new _UndiciAgent({
        connect: {
          lookup: ipv4Lookup
        }
      })
    );
  }

  networkStackConfigured = true;
  console.log("Configured network stack to prefer IPv4 for outbound requests.");
}
