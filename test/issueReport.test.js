import test from "node:test";
import assert from "node:assert/strict";
process.env.GOOGLE_PRIVATE_KEY ??= "test-key";
process.env.TELEGRAM_BOT_TOKEN ??= "test-token";
process.env.GOOGLE_SHEETS_SPREADSHEET_ID ??= "test-sheet";
process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL ??= "bot@example.com";

const { __testing } = await import("../src/bot.js");

const { submitGitHubIssue, describeGitHubIssueFailure, formatIssueSubmissionFailure } = __testing;

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body)
  };
}

test("submitGitHubIssue posts to the configured repo with a timeout signal", async () => {
  const calls = [];
  const result = await submitGitHubIssue("[User Report] hi", "body", {
    token: "t",
    repo: "Owner/private-repo",
    fetchFn: async (url, init) => {
      calls.push({ url, init });
      return jsonResponse(201, { number: 42, html_url: "https://github.com/Owner/private-repo/issues/42" });
    }
  });

  assert.deepEqual(result, {
    ok: true,
    issueNumber: 42,
    issueUrl: "https://github.com/Owner/private-repo/issues/42"
  });
  assert.equal(calls[0].url, "https://api.github.com/repos/Owner/private-repo/issues");
  assert.equal(calls[0].init.method, "POST");
  assert.ok(calls[0].init.signal instanceof AbortSignal);
  assert.equal(calls[0].init.headers.Authorization, "Bearer t");
  assert.deepEqual(JSON.parse(calls[0].init.body), { title: "[User Report] hi", body: "body" });
});

test("submitGitHubIssue reports a missing token without calling GitHub", async () => {
  let called = false;
  const previous = process.env.GITHUB_TOKEN;
  delete process.env.GITHUB_TOKEN;
  try {
    const result = await submitGitHubIssue("t", "b", { fetchFn: async () => { called = true; } });
    assert.deepEqual(result, { ok: false, reason: "no_token" });
    assert.equal(called, false);
  } finally {
    if (previous !== undefined) process.env.GITHUB_TOKEN = previous;
  }
});

test("submitGitHubIssue rejects a malformed GITHUB_ISSUE_REPO", async () => {
  const result = await submitGitHubIssue("t", "b", {
    token: "t",
    repo: "not a repo",
    fetchFn: async () => assert.fail("should not call GitHub")
  });
  assert.equal(result.reason, "invalid_repo_config");
});

test("submitGitHubIssue maps permission failures to an actionable reason", async () => {
  const result = await submitGitHubIssue("t", "b", {
    token: "t",
    fetchFn: async () => jsonResponse(403, { message: "Resource not accessible by personal access token" })
  });
  assert.deepEqual(result, {
    ok: false,
    reason: "token_lacks_issue_write_permission_or_rate_limited",
    status: 403
  });
});

test("submitGitHubIssue times out a stalled request instead of hanging", async () => {
  const started = Date.now();
  const result = await submitGitHubIssue("t", "b", {
    token: "t",
    timeoutMs: 50,
    fetchFn: (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason));
    })
  });
  assert.equal(result.reason, "timeout");
  assert.ok(Date.now() - started < 2000);
});

test("submitGitHubIssue treats a network error as retryable", async () => {
  const result = await submitGitHubIssue("t", "b", {
    token: "t",
    fetchFn: async () => { throw new TypeError("fetch failed"); }
  });
  assert.equal(result.reason, "network_error");
});

test("issue failure reasons map to user-facing messages", () => {
  assert.equal(describeGitHubIssueFailure(401), "token_invalid_or_expired");
  assert.equal(describeGitHubIssueFailure(404), "repo_not_found_or_token_lacks_access");
  assert.equal(describeGitHubIssueFailure(502), "github_unavailable");
  assert.match(formatIssueSubmissionFailure({ reason: "no_token" }), /not configured/);
  assert.match(formatIssueSubmissionFailure({ reason: "timeout" }), /could not be reached/);
  assert.match(formatIssueSubmissionFailure({ reason: "token_invalid_or_expired" }), /not authorised/);
});
