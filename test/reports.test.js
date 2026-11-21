import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { historyFrom, latestQuery, matchesFilters, parseInput, recordsQuery, sanitize } from '../src/cot.js';
import { DATE_COLUMN, REPORTS, normalizePage, readDate } from '../src/reports.js';

const samples = {
    legacy_futures_only: 'legacy-futures',
    disaggregated_futures_only: 'disaggregated-futures',
    disaggregated_combined: 'disaggregated-combined',
    tff_futures_only: 'tff-futures',
    tff_combined: 'tff-combined',
};
const fetchedAt = '2026-11-22T12:00:00.000Z';
const fixture = (name) => JSON.parse(readFileSync(new URL(`fixtures/${name}.json`, import.meta.url)));

test('official report projections match the five captured API responses', () => {
    for (const [type, file] of Object.entries(samples)) {
        const raw = fixture(file);
        const fields = new Set(raw.flatMap(Object.keys));
        assert.deepEqual(REPORTS[type].columns.filter((field) => !fields.has(field)), [], type);
        const [row] = normalizePage(raw, type, fetchedAt);
        assert.equal(row.reportType, type);
        assert.equal(row.contractCode, raw[0].cftc_contract_market_code);
        assert.equal(row.openInterest, Number(raw[0].open_interest_all));
        assert.equal(row.openInterestChange, Number(raw[0].change_in_open_interest_all));
        assert.equal(row.openInterestPercent, 100);
        assert.equal(row.totalTraders, Number(raw[0].traders_tot_all));
        assert.equal(row.reportDate, '2026-11-17');
        assert.equal(row.fetchedAt, fetchedAt);
        assert.equal(row.source, REPORTS[type].url);
    }
    assert.deepEqual(REPORTS.legacy_combined.columns, REPORTS.legacy_futures_only.columns);
});

test('each report family maps its irregular source fields to numeric measures', () => {
    const [rawLegacy] = fixture('legacy-futures');
    const [legacy] = normalizePage([rawLegacy], 'legacy_futures_only', fetchedAt);
    assert.deepEqual(legacy.positions.nonCommercial.spreading, {
        position: Number(rawLegacy.noncomm_postions_spread_all),
        change: Number(rawLegacy.change_in_noncomm_spead_all),
        percentOfOpenInterest: Number(rawLegacy.pct_of_oi_noncomm_spread),
        traders: Number(rawLegacy.traders_noncomm_spread_all),
    });

    const [rawDisaggregated] = fixture('disaggregated-futures');
    const [disaggregated] = normalizePage([rawDisaggregated], 'disaggregated_futures_only', fetchedAt);
    assert.equal(disaggregated.positions.swapDealer.short.position, Number(rawDisaggregated.swap__positions_short_all));
    assert.equal(disaggregated.positions.managedMoney.spreading.traders, Number(rawDisaggregated.traders_m_money_spread_all));

    const [rawTff] = fixture('tff-combined');
    const [tff] = normalizePage([rawTff], 'tff_combined', fetchedAt);
    assert.equal(tff.positions.assetManager.long.position, Number(rawTff.asset_mgr_positions_long));
    assert.equal(tff.positions.leveragedMoney.spreading.traders, Number(rawTff.traders_lev_money_spread));
});

test('distinguishes omitted, zero and invalid source values', () => {
    const [example] = fixture('disaggregated-futures');
    const type = 'disaggregated_futures_only';
    const raw = { ...example, traders_swap_spread_all: '', traders_m_money_long_all: '0', open_interest_all: null };
    delete raw.traders_m_money_short_all;
    const [row] = normalizePage([raw], type, fetchedAt);
    assert.equal(row.openInterest, null);
    assert.equal(row.positions.swapDealer.spreading.traders, null);
    assert.equal(row.positions.managedMoney.long.traders, 0);
    assert.equal(row.positions.managedMoney.short.traders, null);
    assert.equal(row.positions.producerMerchant.spreading.position, null);
    assert.equal(row.positions.nonReportable.long.traders, null);
    assert.throws(() => normalizePage([{ ...raw, open_interest_all: 'unknown' }], type), /Unrecognized CFTC schema.*open_interest_all/);
    assert.throws(() => normalizePage([{ ...raw, futonly_or_combined: 'Combined' }], type), /Unrecognized CFTC schema.*futonly_or_combined/);
    assert.throws(() => normalizePage([{ [DATE_COLUMN]: raw[DATE_COLUMN] }], type), /Unrecognized CFTC schema.*position columns/);
    assert.throws(() => readDate({ [DATE_COLUMN]: '2026-02-31T00:00:00.000' }, type), /Unrecognized CFTC schema/);
});

test('validates input and keeps the default report bounded to three contracts', () => {
    const options = parseInput({});
    assert.deepEqual(options.reports, ['disaggregated_futures_only']);
    assert.deepEqual(options.codes, ['002602', '067651', '088691']);
    assert.equal(options.latestOnly, true);
    assert.deepEqual(parseInput({ contractCodes: [] }).codes, []);
    assert.deepEqual(parseInput({ commodityGroups: ['agriculture'] }).codes, []);
    assert.deepEqual(parseInput({ reports: ['tff_futures_only'] }).codes, []);
    assert.deepEqual(parseInput({ contractCodes: [' 03465t ', '03465T'] }).codes, ['03465T']);
    for (const input of [
        { reports: ['constructor'] }, { latestOnly: 'yes' }, { from: '2026-02-29' },
        { from: '2026-11-02', to: '2026-11-01' }, { stateKey: 'not valid' }, { contractCodes: [2602] },
        { latestOnly: false, from: '2025-01-01', to: '2026-01-01' },
    ]) assert.throws(() => parseInput(input));
    assert.equal(historyFrom(undefined, '2026-11-17'), '2025-11-19');
});

test('selects the latest report date before market filters and builds bounded data queries', () => {
    const type = 'legacy_combined';
    const options = parseInput({
        reports: [type], contractCodes: ['002602'], marketNameContains: " Trader's ",
        commodityGroups: ['agriculture', 'natural resources'], from: '2026-11-01', to: '2026-11-17',
    });
    const latest = latestQuery(type, options).searchParams;
    assert.equal(latest.get('$select'), DATE_COLUMN);
    assert.equal(latest.get('$limit'), '1');
    assert.match(latest.get('$where'), />= '2026-11-01T00:00:00\.000'.*<= '2026-11-17T00:00:00\.000'/);
    assert.doesNotMatch(latest.get('$where'), /cftc_contract_market_code|commodity_group_name|market_and_exchange_names/);

    const url = recordsQuery(type, options, { dates: ['2026-11-17'] }, 250, 250);
    const query = url.searchParams;
    assert.equal(url.pathname, '/resource/jun7-fc8e.json');
    assert.equal(query.get('$offset'), '250');
    assert.equal(query.get('$order'), `${DATE_COLUMN} DESC,cftc_contract_market_code ASC,id ASC`);
    assert.match(query.get('$where'), /cftc_contract_market_code in \('002602'\)/);
    assert.match(query.get('$where'), /upper\(commodity_group_name\) in \('AGRICULTURE','NATURAL RESOURCES'\)/);
    assert.match(query.get('$where'), /like '%trader''s%'/);
    const withWildcard = parseInput({ marketNameContains: '%_' });
    assert.equal(matchesFilters({ marketName: 'abc', contractCode: '002602' }, withWildcard), false);
    assert.equal(matchesFilters({ marketName: 'abc %_ def', contractCode: '002602' }, withWildcard), true);
});

test('sanitizes local paths from errors', () => {
    const windowsPath = ['C:', 'Users', 'local', 'file'].join('\\');
    const unixPath = ['', 'home', 'local', 'file'].join('/');
    assert.equal(sanitize(`Read ${windowsPath} and ${unixPath}`), 'Read <path> and <path>');
});
