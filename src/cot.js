import { CODE_COLUMN, DATE_COLUMN, GROUP_COLUMN, NAME_COLUMN, REPORTS, isDate } from './reports.js';

const DEFAULT_REPORT = 'disaggregated_futures_only';
const DEFAULT_CODES = ['002602', '067651', '088691'];
const HISTORY_DAYS = 52 * 7;
const DAY_MS = 86_400_000;
const CONTRACT_CODE = /^[A-Za-z0-9]{1,12}$/;

function stringList(value, name, max, pattern) {
    if (!Array.isArray(value) || value.length > max || value.some((item) => typeof item !== 'string' || !pattern.test(item.trim()))) {
        throw new Error(`${name} must be an array of up to ${max} valid strings.`);
    }
    return [...new Set(value.map((item) => item.trim().toUpperCase()))];
}

export function parseInput(input) {
    if (typeof input !== 'object' || !input || Array.isArray(input)) throw new Error('Input must be an object.');
    const {
        reports = [DEFAULT_REPORT], marketNameContains = '', commodityGroups = [],
        from, to, latestOnly = true, onlyNew = false, stateKey = 'default',
    } = input;
    if (!Array.isArray(reports) || !reports.length || reports.length > Object.keys(REPORTS).length
        || reports.some((report) => typeof report !== 'string' || !Object.hasOwn(REPORTS, report))) {
        throw new Error('reports must select at least one supported CFTC report type.');
    }
    if (typeof marketNameContains !== 'string' || marketNameContains.length > 100 || /[\u0000-\u001f]/.test(marketNameContains)) {
        throw new Error('marketNameContains must be a single line of up to 100 characters.');
    }
    const term = marketNameContains.trim().toLowerCase();
    const groups = stringList(commodityGroups, 'commodityGroups', 10, /^[A-Z][A-Z &-]{0,49}$/i);
    const defaultCodes = reports.length === 1 && reports[0] === DEFAULT_REPORT && !term && !groups.length ? DEFAULT_CODES : [];
    const codes = stringList(input.contractCodes === undefined ? defaultCodes : input.contractCodes, 'contractCodes', 10, CONTRACT_CODE);
    if (typeof latestOnly !== 'boolean' || typeof onlyNew !== 'boolean') throw new Error('latestOnly and onlyNew must be booleans.');
    if (typeof stateKey !== 'string' || !/^[a-zA-Z0-9_-]{1,50}$/.test(stateKey)) {
        throw new Error('stateKey must contain 1–50 letters, digits, underscores or hyphens.');
    }
    for (const [key, value] of Object.entries({ from, to })) {
        if (value !== undefined && !isDate(value)) throw new Error(`${key} must be a valid date in YYYY-MM-DD format.`);
    }
    if (from && to && from > to) throw new Error('from must be on or before to.');
    if (!latestOnly && from && to) historyFrom(from, to);
    return { reports: [...new Set(reports)], term, groups, codes, from, to, latestOnly, onlyNew, stateKey };
}

export function historyFrom(from, to) {
    const earliest = new Date(Date.parse(to) - (HISTORY_DAYS - 1) * DAY_MS).toISOString().slice(0, 10);
    if (from && Date.parse(to) - Date.parse(from) >= HISTORY_DAYS * DAY_MS) {
        throw new Error('A historical run covers up to 52 weeks. Narrow the from/to range.');
    }
    return from ?? earliest;
}

const literal = (value) => `'${value.replaceAll("'", "''")}'`;
const timestamp = (value) => `${value}T00:00:00.000`;
const inList = (column, values) => `${column} in (${values.map(literal).join(',')})`;

function dateRange(from, to) {
    const filters = [];
    if (from) filters.push(`${DATE_COLUMN} >= ${literal(timestamp(from))}`);
    if (to) filters.push(`${DATE_COLUMN} <= ${literal(timestamp(to))}`);
    return filters;
}

function queryUrl(reportType, { columns, filters, limit, offset }) {
    const url = new URL(REPORTS[reportType].url);
    url.searchParams.set('$select', columns.join(','));
    if (filters.length) url.searchParams.set('$where', filters.join(' AND '));
    url.searchParams.set('$order', `${DATE_COLUMN} DESC,${CODE_COLUMN} ASC,id ASC`);
    url.searchParams.set('$limit', limit);
    url.searchParams.set('$offset', offset);
    return url;
}

export function latestQuery(reportType, { from, to }) {
    return queryUrl(reportType, { columns: [DATE_COLUMN], filters: dateRange(from, to), limit: 1, offset: 0 });
}

export function recordsQuery(reportType, { codes, groups, term }, { from, to, dates }, limit, offset) {
    const filters = dates ? [inList(DATE_COLUMN, dates.map(timestamp))] : dateRange(from, to);
    if (codes.length) filters.push(inList(CODE_COLUMN, codes));
    if (groups.length) filters.push(inList(`upper(${GROUP_COLUMN})`, groups));
    // Fall back to a literal client-side match for characters meaningful to LIKE.
    if (term && !/[%_\\]/.test(term)) filters.push(`lower(${NAME_COLUMN}) like ${literal(`%${term}%`)}`);
    return queryUrl(reportType, { columns: REPORTS[reportType].columns, filters, limit, offset });
}

export function matchesFilters(row, { codes, groups, term }) {
    return (!codes.length || codes.includes(row.contractCode.toUpperCase()))
        && (!groups.length || groups.includes(row.commodityGroup?.toUpperCase()))
        && (!term || row.marketName.toLowerCase().includes(term));
}

export function sanitize(message) {
    return String(message)
        .replace(/(?<![A-Za-z0-9])[A-Za-z]:[\\/][^\s'"`)]*/g, '<path>')
        .replace(/\/(?:home|Users|root|tmp|var|usr)\/[^\s'"`)]*/g, '<path>');
}
