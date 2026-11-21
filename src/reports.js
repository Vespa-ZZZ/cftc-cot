export const ORIGIN = 'https://publicreporting.cftc.gov';
export const DATE_COLUMN = 'report_date_as_yyyy_mm_dd';
export const CODE_COLUMN = 'cftc_contract_market_code';
export const NAME_COLUMN = 'market_and_exchange_names';
export const GROUP_COLUMN = 'commodity_group_name';

const SIDES = ['long', 'short', 'spreading'];
const METRICS = ['position', 'change', 'percentOfOpenInterest', 'traders'];

function category(stem, { spreading = false, traders = true, columns = {} } = {}) {
    return Object.fromEntries(SIDES.map((side) => {
        if (side === 'spreading' && !spreading) return [side, null];
        const direction = side === 'spreading' ? 'spread' : side;
        const names = columns[side] ?? [
            `${stem}_positions_${direction}_all`,
            `change_in_${stem}_${direction}_all`,
            `pct_of_oi_${stem}_${direction}_all`,
            `traders_${stem}_${direction}_all`,
        ];
        return [side, traders ? names : [...names.slice(0, 3), null]];
    }));
}

function withoutAllSuffix(stem, side, traders) {
    return [
        `${stem}_positions_${side}`,
        `change_in_${stem}_${side}`,
        `pct_of_oi_${stem}_${side}`,
        `traders_${stem}_${side}${traders ? '_all' : ''}`,
    ];
}

const totals = {
    totalReportable: category('tot_rept', {
        columns: { short: withoutAllSuffix('tot_rept', 'short', true) },
    }),
    nonReportable: category('nonrept', { traders: false }),
};

const otherReportable = category('other_rept', {
    spreading: true,
    columns: {
        long: withoutAllSuffix('other_rept', 'long', true),
        short: withoutAllSuffix('other_rept', 'short', false),
        spreading: withoutAllSuffix('other_rept', 'spread', false),
    },
});

const legacy = {
    nonCommercial: category('noncomm', {
        spreading: true,
        columns: {
            // These spellings are the API field names in both Legacy views.
            spreading: ['noncomm_postions_spread_all', 'change_in_noncomm_spead_all', 'pct_of_oi_noncomm_spread', 'traders_noncomm_spread_all'],
        },
    }),
    commercial: category('comm'),
    ...totals,
};

const disaggregated = {
    producerMerchant: category('prod_merc', {
        columns: {
            long: withoutAllSuffix('prod_merc', 'long', true),
            short: withoutAllSuffix('prod_merc', 'short', true),
        },
    }),
    swapDealer: category('swap', {
        spreading: true,
        columns: {
            short: ['swap__positions_short_all', 'change_in_swap_short_all', 'pct_of_oi_swap_short_all', 'traders_swap_short_all'],
            spreading: ['swap__positions_spread_all', 'change_in_swap_spread_all', 'pct_of_oi_swap_spread_all', 'traders_swap_spread_all'],
        },
    }),
    managedMoney: category('m_money', {
        spreading: true,
        columns: { spreading: withoutAllSuffix('m_money', 'spread', true) },
    }),
    otherReportable,
    ...totals,
};

function financialCategory(stem) {
    return category(stem, {
        spreading: true,
        columns: {
            long: withoutAllSuffix(stem, 'long', true),
            short: withoutAllSuffix(stem, 'short', true),
            spreading: withoutAllSuffix(stem, 'spread', false),
        },
    });
}

const financial = {
    dealer: category('dealer', { spreading: true }),
    assetManager: financialCategory('asset_mgr'),
    leveragedMoney: financialCategory('lev_money'),
    otherReportable,
    ...totals,
};

const OPEN_INTEREST_COLUMNS = {
    openInterest: 'open_interest_all',
    openInterestChange: 'change_in_open_interest_all',
    openInterestPercent: 'pct_of_open_interest_all',
    totalTraders: 'traders_tot_all',
};

function report(id, coverage, categories) {
    const numericColumns = [
        ...Object.values(OPEN_INTEREST_COLUMNS),
        ...Object.values(categories).flatMap((sides) => Object.values(sides).flat()).filter(Boolean),
    ];
    return {
        url: `${ORIGIN}/resource/${id}.json`,
        coverage,
        categories,
        numericColumns,
        columns: ['id', DATE_COLUMN, CODE_COLUMN, NAME_COLUMN, GROUP_COLUMN, 'futonly_or_combined', ...numericColumns],
    };
}

// Filtered views published in the CFTC Public Reporting Environment.
export const REPORTS = {
    legacy_futures_only: report('6dca-aqww', 'FutOnly', legacy),
    legacy_combined: report('jun7-fc8e', 'Combined', legacy),
    disaggregated_futures_only: report('72hh-3qpy', 'FutOnly', disaggregated),
    disaggregated_combined: report('kh3c-gbw2', 'Combined', disaggregated),
    tff_futures_only: report('gpe5-46if', 'FutOnly', financial),
    tff_combined: report('yw9f-hn96', 'Combined', financial),
};

function schemaError(reportType, field) {
    return new Error(`Unrecognized CFTC schema for ${reportType}: invalid or missing ${field}.`);
}

export function isDate(value) {
    return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
        && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().startsWith(value);
}

export function readDate(row, reportType) {
    const timestamp = row?.[DATE_COLUMN];
    const date = typeof timestamp === 'string' ? timestamp.slice(0, 10) : null;
    if (!isDate(date) || !/^(?:\d{4}-\d{2}-\d{2})(?:T00:00:00(?:\.\d+)?)?$/.test(timestamp)) {
        throw schemaError(reportType, DATE_COLUMN);
    }
    return date;
}

function readNumber(row, column, reportType) {
    if (!column || row[column] == null) return null;
    const raw = row[column];
    if (typeof raw === 'string' && !raw.trim()) return null;
    if (typeof raw !== 'number' && (typeof raw !== 'string' || !/^[+-]?\d+(?:\.\d+)?$/.test(raw.trim()))) {
        throw schemaError(reportType, column);
    }
    const value = Number(raw);
    if (!Number.isFinite(value)) throw schemaError(reportType, column);
    return value;
}

export function normalizePage(rows, reportType, fetchedAt) {
    const config = REPORTS[reportType];
    if (rows.length && !rows.some((row) => row && config.numericColumns.some((column) => Object.hasOwn(row, column)))) {
        throw schemaError(reportType, 'position columns');
    }
    return rows.map((row) => {
        const reportDate = readDate(row, reportType);
        const contractCode = row[CODE_COLUMN];
        const marketName = row[NAME_COLUMN];
        const commodityGroup = row[GROUP_COLUMN];
        if (typeof contractCode !== 'string' || !/^[A-Za-z0-9]{1,12}$/.test(contractCode)) throw schemaError(reportType, CODE_COLUMN);
        if (typeof marketName !== 'string' || !marketName.trim()) throw schemaError(reportType, NAME_COLUMN);
        if (commodityGroup != null && typeof commodityGroup !== 'string') throw schemaError(reportType, GROUP_COLUMN);
        if (row.futonly_or_combined !== config.coverage) throw schemaError(reportType, 'futonly_or_combined');

        const openInterest = Object.fromEntries(Object.entries(OPEN_INTEREST_COLUMNS)
            .map(([field, column]) => [field, readNumber(row, column, reportType)]));
        const positions = Object.fromEntries(Object.entries(config.categories).map(([name, sides]) => [
            name,
            Object.fromEntries(Object.entries(sides).map(([side, fields]) => [
                side, Object.fromEntries(METRICS.map((metric, index) => [metric, readNumber(row, fields?.[index], reportType)])),
            ])),
        ]));

        return {
            reportType, reportDate, contractCode, marketName: marketName.trim(), commodityGroup: commodityGroup?.trim() || null,
            ...openInterest, positions, source: config.url, fetchedAt,
        };
    });
}
