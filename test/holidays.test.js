import test from "node:test";
import assert from "node:assert/strict";
import {
  getSingaporePublicHolidaySet,
  loadSingaporePublicHolidayCache,
  __resetPublicHolidayCacheForTesting
} from "../src/holidays.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const COLLECTION_METADATA_URL = "https://api-production.data.gov.sg/v2/public/api/collections/691/metadata";
const DATASET_URL_PATTERN = "https://data.gov.sg/api/action/datastore_search";

function makeMockFetch({ metadataDatasets = ["ds-2026"], dataByDataset = {}, failDatasets = new Set() } = {}) {
  return async (url) => {
    if (url === COLLECTION_METADATA_URL) {
      return {
        ok: true,
        json: async () => ({
          data: { collectionMetadata: { childDatasets: metadataDatasets } }
        })
      };
    }

    if (url.startsWith(DATASET_URL_PATTERN)) {
      const resourceId = new URL(url).searchParams.get("resource_id");
      if (failDatasets.has(resourceId)) {
        return { ok: false, status: 503, statusText: "Service Unavailable" };
      }
      const records = dataByDataset[resourceId] ?? [];
      return {
        ok: true,
        json: async () => ({ result: { records } })
      };
    }

    throw new Error(`Unexpected URL: ${url}`);
  };
}

const HOLIDAYS_2026 = [
  { date: "2026-01-01" },
  { date: "2026-02-17" },
  { date: "2026-04-03" }
];

// ── Clean fetch populates cache ───────────────────────────────────────────────

test("getSingaporePublicHolidaySet returns correct dates for a year that is in the API", async () => {
  __resetPublicHolidayCacheForTesting();
  const originalFetch = global.fetch;
  global.fetch = makeMockFetch({
    metadataDatasets: ["ds-2026"],
    dataByDataset: { "ds-2026": HOLIDAYS_2026 }
  });

  try {
    const set = await getSingaporePublicHolidaySet(2026);
    assert.equal(set.has("2026-01-01"), true);
    assert.equal(set.has("2026-02-17"), true);
    assert.equal(set.has("2026-04-03"), true);
    assert.equal(set.has("2026-12-25"), false, "unlisted date should not appear");
  } finally {
    global.fetch = originalFetch;
  }
});

test("getSingaporePublicHolidaySet uses in-memory cache on subsequent calls (no second fetch)", async () => {
  __resetPublicHolidayCacheForTesting();
  let fetchCount = 0;
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    fetchCount++;
    return makeMockFetch({ metadataDatasets: ["ds-2026"], dataByDataset: { "ds-2026": HOLIDAYS_2026 } })(url);
  };

  try {
    await getSingaporePublicHolidaySet(2026);
    const callsAfterFirst = fetchCount;
    await getSingaporePublicHolidaySet(2026);
    assert.equal(fetchCount, callsAfterFirst, "second call should not trigger another fetch");
  } finally {
    global.fetch = originalFetch;
  }
});

// ── Miss cooldown: clean miss records cooldown ────────────────────────────────

test("getSingaporePublicHolidaySet records a miss cooldown when year is absent from a clean fetch", async () => {
  __resetPublicHolidayCacheForTesting();
  let fetchCount = 0;
  const originalFetch = global.fetch;
  // API returns no data for 2099
  global.fetch = async (url) => {
    fetchCount++;
    return makeMockFetch({ metadataDatasets: ["ds-2026"], dataByDataset: {} })(url);
  };

  try {
    const first = await getSingaporePublicHolidaySet(2099);
    assert.equal(first.size, 0, "absent year should return empty set");
    const callsAfterFirst = fetchCount;

    // Second call should skip the fetch (cooldown active)
    const second = await getSingaporePublicHolidaySet(2099);
    assert.equal(second.size, 0);
    assert.equal(fetchCount, callsAfterFirst, "second call for missing year should use cooldown — no new fetch");
  } finally {
    global.fetch = originalFetch;
  }
});

// ── Dataset error: does NOT set cooldown ──────────────────────────────────────

test("a per-dataset fetch failure does not cache a miss cooldown for that year", async () => {
  __resetPublicHolidayCacheForTesting();
  let fetchCount = 0;
  const originalFetch = global.fetch;

  // Metadata succeeds but the dataset fails
  global.fetch = async (url) => {
    fetchCount++;
    return makeMockFetch({
      metadataDatasets: ["ds-fail"],
      failDatasets: new Set(["ds-fail"])
    })(url);
  };

  try {
    const first = await getSingaporePublicHolidaySet(2026);
    assert.equal(first.size, 0, "failed dataset should return empty set for the year");
    const callsAfterFirst = fetchCount;

    // Should attempt another fetch since no cooldown was recorded
    const second = await getSingaporePublicHolidaySet(2026);
    assert.ok(fetchCount > callsAfterFirst, "a new fetch attempt should be made when last load had errors");
    assert.equal(second.size, 0);
  } finally {
    global.fetch = originalFetch;
  }
});

// ── Metadata fetch failure: throws and returns empty set ─────────────────────

test("getSingaporePublicHolidaySet returns empty set when metadata fetch throws", async () => {
  __resetPublicHolidayCacheForTesting();
  const originalFetch = global.fetch;
  global.fetch = async () => { throw new Error("network down"); };

  try {
    const result = await getSingaporePublicHolidaySet(2026);
    assert.equal(result.size, 0, "network failure should return empty set, not throw");
  } finally {
    global.fetch = originalFetch;
  }
});

// ── loadSingaporePublicHolidayCache sets lastLoadHadErrors correctly ──────────

test("loadSingaporePublicHolidayCache clears lastLoadHadErrors on a clean load", async () => {
  __resetPublicHolidayCacheForTesting();
  const originalFetch = global.fetch;
  global.fetch = makeMockFetch({
    metadataDatasets: ["ds-2026"],
    dataByDataset: { "ds-2026": HOLIDAYS_2026 }
  });

  try {
    await loadSingaporePublicHolidayCache();
    // Access internal state via __resetPublicHolidayCacheForTesting side-effects —
    // we can probe behaviour by doing another miss check:
    // A second call for 2099 (absent) should set a cooldown, proving lastLoadHadErrors=false
    let fetchCount = 0;
    global.fetch = async (url) => {
      fetchCount++;
      return makeMockFetch({ metadataDatasets: [], dataByDataset: {} })(url);
    };
    await getSingaporePublicHolidaySet(2099);
    const countAfterFirst = fetchCount;
    await getSingaporePublicHolidaySet(2099);
    assert.equal(fetchCount, countAfterFirst, "cooldown should have been set after clean miss");
  } finally {
    global.fetch = originalFetch;
  }
});

// ── Multiple years in single fetch ───────────────────────────────────────────

test("a single API response populates multiple years simultaneously", async () => {
  __resetPublicHolidayCacheForTesting();
  const originalFetch = global.fetch;
  global.fetch = makeMockFetch({
    metadataDatasets: ["ds-multi"],
    dataByDataset: {
      "ds-multi": [
        { date: "2025-12-25" },
        { date: "2026-01-01" },
        { date: "2026-02-17" }
      ]
    }
  });

  try {
    const set2025 = await getSingaporePublicHolidaySet(2025);
    const set2026 = await getSingaporePublicHolidaySet(2026);
    assert.equal(set2025.has("2025-12-25"), true);
    assert.equal(set2026.has("2026-01-01"), true);
    assert.equal(set2026.has("2026-02-17"), true);
  } finally {
    global.fetch = originalFetch;
  }
});
