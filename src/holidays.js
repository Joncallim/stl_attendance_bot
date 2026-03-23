const SINGAPORE_PUBLIC_HOLIDAY_COLLECTION_ID = "691";
const publicHolidayCache = {
  years: new Map(),
  loadingPromise: null
};

async function fetchJson(url) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Request failed: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

export async function loadSingaporePublicHolidayCache() {
  if (publicHolidayCache.loadingPromise) {
    await publicHolidayCache.loadingPromise;
    return;
  }

  publicHolidayCache.loadingPromise = (async () => {
    const metadata = await fetchJson(
      `https://api-production.data.gov.sg/v2/public/api/collections/${SINGAPORE_PUBLIC_HOLIDAY_COLLECTION_ID}/metadata`
    );
    const datasetIds = metadata?.data?.collectionMetadata?.childDatasets ?? [];

    for (const datasetId of datasetIds) {
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
        console.error(`Failed to load public holiday dataset ${datasetId}:`, error.message);
      }
    }
  })().finally(() => {
    publicHolidayCache.loadingPromise = null;
  });

  await publicHolidayCache.loadingPromise;
}

export async function getSingaporePublicHolidaySet(year) {
  if (!publicHolidayCache.years.has(year)) {
    await loadSingaporePublicHolidayCache();
  }

  return publicHolidayCache.years.get(year) ?? new Set();
}
