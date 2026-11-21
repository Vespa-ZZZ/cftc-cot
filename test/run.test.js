import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { STATE_RECORD, storeName, withMonitorLock } from '../src/monitor.js';
import { DATE_COLUMN } from '../src/reports.js';
import { runActor } from '../src/run.js';

const disaggregated = JSON.parse(readFileSync(new URL('fixtures/disaggregated-futures.json', import.meta.url)));
const legacy = JSON.parse(readFileSync(new URL('fixtures/legacy-futures.json', import.meta.url)));
const reportType = 'disaggregated_futures_only';
const latestDate = '2026-11-17';
const olderDate = '2026-11-10';
const asTimestamp = (date) => `${date}T00:00:00.000`;

function storage() {
    const data = [];
    const calls = [];
    const stored = new Map();
    const actor = {
        async pushData(rows) {
            calls.push(['push', rows.length]);
            data.push(...rows);
        },
        async openKeyValueStore(name) {
            return {
                getValue: async (key) => structuredClone(stored.get(`${name}:${key}`)),
                async setValue(key, state) {
                    calls.push(['save', key]);
                    stored.set(`${name}:${key}`, structuredClone(state));
                },
            };
        },
    };
    return { actor, stored, data, calls };
}

const sleep = async () => {};
const json = (value) => Response.json(value);
const isDateQuery = (url) => url.searchParams.get('$select') === DATE_COLUMN;
const dateResult = (date) => json([{ [DATE_COLUMN]: asTimestamp(date) }]);

test('the default run requests the most recent week and emits three snapshot rows', async () => {
    const { actor, data } = storage();
    const intervals = [];
    const count = await runActor({}, {
        actor,
        sleep: async (ms) => intervals.push(ms),
        fetchImpl: async (url, options) => {
            assert.equal(url.pathname, '/resource/72hh-3qpy.json');
            assert.equal(options.redirect, 'error');
            if (isDateQuery(url)) return dateResult(latestDate);
            assert.match(url.searchParams.get('$where'), /'002602','067651','088691'/);
            return json(disaggregated.slice(0, 3));
        },
    });
    assert.equal(count, 3);
    assert.deepEqual(data.map(({ contractCode }) => contractCode), ['002602', '067651', '088691']);
    assert.ok(data.every((row) => row.reportDate === latestDate && row.changeType === 'snapshot'));
    assert.deepEqual(intervals, [2300]);
});

test('historical pagination advances the offset even when a filter drops rows', async () => {
    const { actor, data } = storage();
    const offsets = [];
    const count = await runActor({ latestOnly: false, from: olderDate, to: latestDate, marketNameContains: '%_' }, {
        actor, sleep,
        fetchImpl: async (url) => {
            const query = url.searchParams;
            const size = Number(query.get('$limit'));
            const offset = Number(query.get('$offset'));
            offsets.push(offset);
            assert.match(query.get('$where'), /report_date_as_yyyy_mm_dd >=/);
            if (offset === 0) return json(Array.from({ length: size }, (_, id) => ({
                ...disaggregated[0], cftc_contract_market_code: `A${id}`,
            })));
            return json([{ ...disaggregated[3], market_and_exchange_names: 'CORN %_ TEST MARKET' }]);
        },
    });
    assert.deepEqual(offsets, [0, 250]);
    assert.equal(count, 1);
    assert.equal(data[0].reportDate, olderDate);
});

test('monitoring emits a new week and a revision of an older reported date once', async () => {
    const { actor, data, calls } = storage();
    const options = { onlyNew: true, stateKey: 'weekly_1', contractCodes: ['002602'] };
    const first = disaggregated.find((row) => row.cftc_contract_market_code === '002602' && row[DATE_COLUMN] === asTimestamp(olderDate));
    const revised = { ...first, open_interest_all: String(Number(first.open_interest_all) + 10), traders_swap_short_all: null };
    const run = (date, rows) => runActor(options, {
        actor, sleep,
        fetchImpl: async (url) => {
            if (isDateQuery(url)) return dateResult(date);
            const where = url.searchParams.get('$where');
            for (const row of rows) assert.ok(where.includes(row[DATE_COLUMN]));
            return json(rows);
        },
    });

    assert.equal(await run(olderDate, [first]), 1);
    assert.equal(await run(olderDate, [first]), 0);
    assert.equal(await run(latestDate, [disaggregated[0], revised]), 2);
    assert.equal(await run(latestDate, [disaggregated[0], revised]), 0);
    assert.deepEqual(data.map((row) => [row.reportDate, row.changeType]), [
        [olderDate, 'new'], [latestDate, 'new'], [olderDate, 'revision'],
    ]);
    assert.deepEqual(data[2].changedFields, [
        { field: 'openInterest', previous: Number(first.open_interest_all), current: Number(revised.open_interest_all) },
        { field: 'positions.swapDealer.short.traders', previous: Number(first.traders_swap_short_all), current: null },
    ]);
    assert.equal(data[2].previousRowHash, data[0].rowHash);
    assert.notEqual(data[2].rowHash, data[2].previousRowHash);
    assert.deepEqual(calls, [['push', 1], ['save', STATE_RECORD], ['push', 2], ['save', STATE_RECORD]]);
});

test('a later report or dataset failure leaves the baseline at its previous version', async () => {
    const { actor, stored, calls } = storage();
    const options = { reports: [reportType, 'legacy_futures_only'], latestOnly: false, from: latestDate, to: latestDate, onlyNew: true };
    const firstRun = async (url) => json([url.pathname.includes('6dca') ? legacy[0] : disaggregated[0]]);
    assert.equal(await runActor(options, { actor, sleep, fetchImpl: firstRun }), 2);
    const key = `${storeName('default')}:${STATE_RECORD}`;
    const baseline = structuredClone(stored.get(key));
    const updated = { ...disaggregated[0], change_in_prod_merc_long: '1' };
    const laterFailure = async (url) => url.pathname.includes('6dca') ? json({ malformed: true }) : json([updated]);

    await assert.rejects(runActor(options, { actor, sleep, fetchImpl: laterFailure }), /Unrecognized CFTC schema.*legacy_futures_only/);
    assert.deepEqual(stored.get(key), baseline);
    assert.equal(calls.at(-1)[0], 'push');
    const brokenActor = { ...actor, pushData: async () => { throw new Error('Dataset unavailable'); } };
    await assert.rejects(runActor(options, { actor: brokenActor, sleep, fetchImpl: async () => json([updated]) }), /Dataset unavailable/);
    assert.deepEqual(stored.get(key), baseline);
});

test('retries network errors, 429 and 5xx with a shared minimum interval and Retry-After', async () => {
    const { actor } = storage();
    const calls = [];
    const replies = [
        () => { throw new Error('offline'); },
        () => new Response('', { status: 429, headers: { 'retry-after': '15' } }),
        () => new Response('', { status: 503 }),
        () => dateResult(latestDate),
        () => json([]),
    ];
    assert.equal(await runActor({}, {
        actor,
        sleep: async (ms) => calls.push(ms),
        fetchImpl: async () => replies.shift()(),
    }), 0);
    assert.deepEqual(calls, [4600, 15000, 18400, 2300]);

    let attempts = 0;
    await assert.rejects(runActor({}, { actor, sleep, fetchImpl: async () => {
        attempts++;
        return new Response('', { status: 403 });
    } }), /HTTP 403/);
    assert.equal(attempts, 1);
});

test('fails when a cloud monitoring run already holds the state lease', async () => {
    const queue = {
        addRequest: async () => {},
        listAndLockHead: async () => ({ items: [] }),
    };
    const actor = {
        isAtHome: () => true,
        newClient: () => ({ requestQueues: () => ({ getOrCreate: async () => ({ id: 'queue' }) }), requestQueue: () => queue }),
    };
    await assert.rejects(withMonitorLock(actor, 'cftc-cot-test', async () => assert.fail('Must hold the lease')), /already|Another/);
});
