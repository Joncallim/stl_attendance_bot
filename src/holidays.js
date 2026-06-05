const SINGAPORE_PUBLIC_HOLIDAY_COLLECTION_ID = "691";
const PUBLIC_HOLIDAY_FETCH_TIMEOUT_MS = 10000;
// Brief pause between fetching individual dataset pages to avoid 429s from
// the data.gov.sg API when the collection contains multiple datasets.
const PUBLIC_HOLIDAY_INTER_FETCH_DELAY_MS = 500;
const PUBLIC_HOLIDAY_MAX_RETRY_ATTEMPTS = 3;
const PUBLIC_HOLIDAY_RETRY_INITIAL_DELAY_MS = 2000;
// When a year's data is not available from the API (e.g. next year not yet
// published), cache the "not found" result and back off for 24 hours before
// retrying, rather than hitting the API on every reminder check.
const PUBLIC_HOLIDAY_MISS_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const publicHolidayCache = {
  years: new Map(),
  loadingPromise: null,
  missTimestamps: new Map(),
  // Set to true when the last load had at least one per-dataset fetch error.
  // A miss timestamp is only recorded when this is false so that a transient
  // per-dataset failure doesn't suppress retries for 24 hours.
  lastLoadHadErrors: false
};

function createPublicHolidayTimeoutError(url, timeoutMs) {
  const error = new Error(
    `Public holiday request timed out after ${timeoutMs}ms for ${url}`
  );
  error.name = "PublicHolidayTimeoutError";
  error.code = "ETIMEDOUT";
  error.status = 504;
  return error;
}

async function fetchJsonOnce(url, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  let response;

  try {
    response = await fetch(url, { signal: controller.signal });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw createPublicHolidayTimeoutError(url, timeoutMs);
    }

    throw error;
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    const error = new Error(`Request failed: ${response.status} ${response.statusText}`);
    error.status = response.status;
    throw error;
  }

  return response.json();
}

async function fetchJson(url, options = {}) {
  const timeoutMs = options.timeoutMs ?? PUBLIC_HOLIDAY_FETCH_TIMEOUT_MS;
  let delayMs = PUBLIC_HOLIDAY_RETRY_INITIAL_DELAY_MS;

  for (let attempt = 1; attempt <= PUBLIC_HOLIDAY_MAX_RETRY_ATTEMPTS; attempt++) {
    try {
      return await fetchJsonOnce(url, timeoutMs);
    } catch (error) {
      const isRateLimit = error?.status === 429;
      const isLastAttempt = attempt >= PUBLIC_HOLIDAY_MAX_RETRY_ATTEMPTS;

      if (!isRateLimit || isLastAttempt) {
        throw error;
      }

      console.warn(
        `Public holiday fetch rate-limited (429). Retry ${attempt}/${PUBLIC_HOLIDAY_MAX_RETRY_ATTEMPTS - 1} after ${delayMs}ms for ${url}`
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      delayMs = Math.min(delayMs * 2, 16000);
    }
  }
}

export async function loadSingaporePublicHolidayCache() {
  if (publicHolidayCache.loadingPromise) {
    await publicHolidayCache.loadingPromise;
    return;
  }

  publicHolidayCache.loadingPromise = (async () => {
    publicHolidayCache.lastLoadHadErrors = false;

    const metadata = await fetchJson(
      `https://api-production.data.gov.sg/v2/public/api/collections/${SINGAPORE_PUBLIC_HOLIDAY_COLLECTION_ID}/metadata`
    );
    const datasetIds = metadata?.data?.collectionMetadata?.childDatasets ?? [];

    for (const [index, datasetId] of datasetIds.entries()) {
      if (index > 0) {
        await new Promise((resolve) => setTimeout(resolve, PUBLIC_HOLIDAY_INTER_FETCH_DELAY_MS));
      }

      try {
        const payload = await fetchJson(
          `https://data.gov.sg/api/action/datastore_search?resource_id=${datasetId}`
        );
        const records = payload?.result?.records ?? [];

        for (const record of records) {
          const rawDate = String(record.date ?? "").trim();

          if (!/^\d{4}-\d{2}-\d{2}$/.test(rawDate)) {
            continue;
          }

          const year = Number(rawDate.slice(0, 4));

          if (!publicHolidayCache.years.has(year)) {
            publicHolidayCache.years.set(year, new Set());
          }

          publicHolidayCache.years.get(year).add(rawDate);
        }
      } catch (error) {
        publicHolidayCache.lastLoadHadErrors = true;
        console.error(`Failed to load public holiday dataset ${datasetId}:`, error.message);
      }
    }
  })().finally(() => {
    publicHolidayCache.loadingPromise = null;
  });

  await publicHolidayCache.loadingPromise;
}

export function __resetPublicHolidayCacheForTesting() {
  publicHolidayCache.years.clear();
  publicHolidayCache.loadingPromise = null;
  publicHolidayCache.missTimestamps.clear();
  publicHolidayCache.lastLoadHadErrors = false;
}

export async function getSingaporePublicHolidaySet(year) {
  if (!publicHolidayCache.years.has(year)) {
    const lastMiss = publicHolidayCache.missTimestamps.get(year);
    const onCooldown = lastMiss != null &&
      (Date.now() - new Date(lastMiss).getTime() < PUBLIC_HOLIDAY_MISS_COOLDOWN_MS);

    if (!onCooldown) {
      try {
        await loadSingaporePublicHolidayCache();
      } catch (error) {
        console.error("Failed to load Singapore public holiday cache:", error.message);
        return new Set();
      }

      // Only record a miss when the load completed without any dataset errors.
      // If a per-dataset fetch failed, the year might still be available — don't
      // suppress retries for 24 hours based on a transient partial failure.
      if (!publicHolidayCache.years.has(year) && !publicHolidayCache.lastLoadHadErrors) {
        publicHolidayCache.missTimestamps.set(year, new Date().toISOString());
      }
    }
  }

  return publicHolidayCache.years.get(year) ?? new Set();
}
