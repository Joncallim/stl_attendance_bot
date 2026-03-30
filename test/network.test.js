import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import { configureNetworkStack, ipv4HttpAgent, ipv4HttpsAgent } from "../src/network.js";

test("configureNetworkStack installs IPv4-first global agents", () => {
  configureNetworkStack();

  assert.equal(http.globalAgent, ipv4HttpAgent);
  assert.equal(https.globalAgent, ipv4HttpsAgent);
});
