import { setTimeout as delay } from 'node:timers/promises';
import { historyFrom, latestQuery, matchesFilters, parseInput, recordsQuery, sanitize } from './cot.js';
import { STATE_RECORD, observe, readState, rowKey, savedDates, storeName, withMonitorLock } from './monitor.js';
import { normalizePage, readDate } from './reports.js';

const REQUEST_INTERVAL_MS = 2300;
const MAX_RETRIES = 3;
const PAGE_SIZE = 250;
const DATE_BATCH_SIZE = 52;
const LEASE_CHECK_MS = 30_000;

function retryAfterMs(response) {
    const value = response?.headers.get('retry-after');
    if (!value) return 0;
    const wait = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now();
    return Number.isSafeInteger(wait) ? Math.max(0, wait) : 0;
}

function requester({ fetchImpl, sleep, warn, renew }) {
    let requested = false;

    return async (reportType, url) => {
        let waitMs = requested ? REQUEST_INTERVAL_MS : 0;
        for (let attempt = 0; ; attempt++) {
            while (waitMs > LEASE_CHECK_MS) {
                await renew();
                await sleep(LEASE_CHECK_MS);
                waitMs -= LEASE_CHECK_MS;
            }
            if (waitMs) await sleep(waitMs);
            await renew();
            requested = true;

            let response;
            let body;
            let failure;
            try {
                response = await fetchImpl(url, {
                    headers: { Accept: 'application/json', 'User-Agent': 'cftc-cot-actor/1.0' },
                    redirect: 'error',
                    signal: AbortSignal.timeout(30_000),
                });
                body = await response.text();
            } catch (error) {
                failure = `CFTC ${reportType} network error (${sanitize(error?.message ?? error)}).`;
            }

            if (response && !response.ok) {
                const status = response.status;
                if (status === 400) throw new Error(`CFTC ${reportType} rejected the SoQL query (HTTP 400). Check the dataset columns and filters.`);
                failure = `CFTC ${reportType} returned HTTP ${status}.`;
                if (status !== 429 && (status < 500 || status > 599)) throw new Error(failure);
            }
            if (!failure) {
                let rows;
                try { rows = JSON.parse(body); } catch { /* Invalid JSON is a schema error. */ }
                if (!Array.isArray(rows) || rows.some((row) => row == null || typeof row !== 'object' || Array.isArray(row))) {
                    throw new Error(`Unrecognized CFTC schema for ${reportType}: expected a JSON array of records.`);
                }
                return rows;
            }

            if (attempt === MAX_RETRIES) throw new Error(failure);
            waitMs = Math.max(REQUEST_INTERVAL_MS * 2 ** (attempt + 1), retryAfterMs(response));
            warn(`${failure} Retrying in ${waitMs} ms.`);
        }
    };
}

async function dateScopes(get, reportType, options, state, deferredDates) {
    const { from, to, latestOnly } = options;
    let latest;
    if (latestOnly || !to) {
        const [row] = await get(reportType, latestQuery(reportType, options));
        if (row) latest = readDate(row, reportType);
    }
    if (!latestOnly) {
        const end = to ?? latest;
        return { scopes: end ? [{ from: historyFrom(from, end), to: end }] : [] };
    }

    const dates = state ? savedDates(state, reportType, options) : new Set();
    for (const date of deferredDates) {
        if ((!from || date >= from) && (!to || date <= to)) dates.add(date);
    }
    if (latest) dates.add(latest);
    const descending = [...dates].sort().reverse();
    const scopes = [];
    for (let i = 0; i < descending.length; i += DATE_BATCH_SIZE) {
        scopes.push({ dates: descending.slice(i, i + DATE_BATCH_SIZE) });
    }
    return { latest, scopes };
}

async function* pages(get, reportType, options, scope) {
    for (let offset = 0; ; offset += PAGE_SIZE) {
        const raw = await get(reportType, recordsQuery(reportType, options, scope, PAGE_SIZE, offset));
        const rows = normalizePage(raw, reportType, new Date().toISOString());
        if (rows.length > PAGE_SIZE || rows.some(({ reportDate }) => scope.dates
            ? !scope.dates.includes(reportDate)
            : reportDate < scope.from || reportDate > scope.to)) {
            throw new Error(`CFTC ${reportType} returned rows outside the requested page or date scope.`);
        }
        yield rows;
        if (raw.length < PAGE_SIZE) return;
    }
}

async function collect(options, { actor, fetchImpl, sleep, warn }, store, renew) {
    const saved = store ? await store.getValue(STATE_RECORD) : null;
    const state = store ? readState(saved) : null;
    const pendingDates = { ...saved?.pendingDates };
    const get = requester({ fetchImpl, sleep, warn, renew });
    const seen = new Set();
    let count = 0;
    let pendingDatesChanged = false;

    reports:
    for (const reportType of options.reports) {
        const deferredDates = new Set(pendingDates[reportType] ?? []);
        const { latest, scopes } = await dateScopes(get, reportType, options, state, deferredDates);
        for (const scope of scopes) {
            for await (const page of pages(get, reportType, options, scope)) {
                const results = [];
                const snapshots = [];
                for (const row of page) {
                    if (!matchesFilters(row, options)) continue;
                    const key = rowKey(row);
                    if (seen.has(key)) throw new Error(`CFTC ${reportType} returned a duplicate contract/date row.`);
                    seen.add(key);
                    if (!state) {
                        results.push({ ...row, changeType: 'snapshot' });
                        continue;
                    }
                    const previous = state.get(key);
                    if (!previous && options.latestOnly && row.reportDate !== latest && !deferredDates.has(row.reportDate)) continue;
                    const change = observe(row, previous);
                    if (change) {
                        results.push(change.event);
                        snapshots.push([key, change.snapshot]);
                    }
                }
                if (results.length) {
                    await renew();
                    const result = await actor.pushData(results);
                    const chargeLimitReached = result?.eventChargeLimitReached === true;
                    const savedCount = chargeLimitReached ? result.chargedCount : results.length;
                    count += savedCount;
                    if (state) {
                        for (const [key, snapshot] of snapshots.slice(0, savedCount)) state.set(key, snapshot);
                    }
                    if (chargeLimitReached) {
                        // Keep the current date eligible even if a newer report appears before the next run.
                        if (state && latest && !deferredDates.has(latest)) {
                            pendingDates[reportType] = [...deferredDates, latest];
                            pendingDatesChanged = true;
                        }
                        warn('Pay-per-event charge limit reached. Stopping dataset output.');
                        break reports;
                    }
                }
            }
        }
        if (options.latestOnly && deferredDates.size) {
            delete pendingDates[reportType];
            pendingDatesChanged = true;
        }
    }

    // Commit a single baseline after the search completes or stops at the charge limit.
    if (state && (count || pendingDatesChanged)) {
        await renew();
        await store.setValue(STATE_RECORD, {
            version: 1,
            rows: [...state],
            ...(Object.keys(pendingDates).length ? { pendingDates } : {}),
        });
    }
    return count;
}

export async function runActor(input, { actor, fetchImpl = fetch, sleep = delay, warn = () => {} }) {
    const options = parseInput(input);
    const dependencies = { actor, fetchImpl, sleep, warn };
    if (!options.onlyNew) return collect(options, dependencies, null, async () => {});
    const name = storeName(options.stateKey);
    return withMonitorLock(actor, name, async (renew) => {
        const store = await actor.openKeyValueStore(name);
        return collect(options, dependencies, store, renew);
    });
}
