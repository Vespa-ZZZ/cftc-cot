import { createHash, randomBytes } from 'node:crypto';

export const STATE_RECORD = 'STATE';
const LOCK_SECONDS = 300;

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
export const storeName = (key) => `cftc-cot-${sha256(key).slice(0, 32)}`;
export const rowKey = ({ reportType, reportDate, contractCode }) => `${reportType}/${reportDate}/${contractCode}`;

export function readState(saved) {
    if (saved == null) return new Map();
    if (saved.version !== 1 || !Array.isArray(saved.rows)
        || saved.rows.some((entry) => !Array.isArray(entry) || typeof entry[0] !== 'string'
            || !/^[a-f0-9]{64}$/.test(entry[1]?.hash) || !Array.isArray(entry[1]?.values))) {
        throw new Error('Unrecognized CFTC monitoring state. Use a different stateKey to start a new baseline.');
    }
    return new Map(saved.rows);
}

export function savedDates(state, reportType, { from, to }) {
    const dates = new Set();
    for (const key of state.keys()) {
        const [type, date] = key.split('/');
        if (type === reportType && (!from || date >= from) && (!to || date <= to)) dates.add(date);
    }
    return dates;
}

function* fieldEntries(object, prefix = '') {
    for (const [key, value] of Object.entries(object)) {
        const path = `${prefix}${key}`;
        if (value !== null && typeof value === 'object') yield* fieldEntries(value, `${path}.`);
        else yield [path, value];
    }
}

export function observe(row, previous) {
    const { reportType, reportDate, contractCode, source, fetchedAt, ...published } = row;
    const fields = [...fieldEntries(published)];
    const values = fields.map(([, value]) => value);
    const hash = sha256(JSON.stringify(values));
    if (previous?.hash === hash) return null;
    const snapshot = { hash, values };
    if (!previous) return { snapshot, event: { ...row, changeType: 'new', rowHash: hash } };
    if (previous.values.length !== values.length) throw new Error('Unrecognized CFTC monitoring state field layout.');
    const changedFields = fields.flatMap(([field, current], index) => {
        const prior = previous.values[index];
        return prior === current ? [] : [{ field, previous: prior, current }];
    });
    return { snapshot, event: { ...row, changeType: 'revision', rowHash: hash, previousRowHash: previous.hash, changedFields } };
}

export async function withMonitorLock(actor, name, work) {
    if (!actor.isAtHome?.()) return work(async () => {});

    const client = actor.newClient();
    const { id } = await client.requestQueues().getOrCreate(name);
    const queue = client.requestQueue(id, { clientKey: randomBytes(12).toString('hex') });
    // The queue entry serves only as a cloud lease. No request is sent to this URL.
    await queue.addRequest({ url: 'https://example.invalid/cftc-cot-state', uniqueKey: 'state' });
    const { items: [lock] } = await queue.listAndLockHead({ limit: 1, lockSecs: LOCK_SECONDS });
    if (!lock) throw new Error('Another CFTC monitoring run is using this stateKey.');

    let expiresAt = Date.parse(lock.lockExpiresAt);
    async function renew() {
        if (expiresAt - Date.now() > 90_000) return;
        const renewed = await queue.prolongRequestLock(lock.id, { lockSecs: LOCK_SECONDS });
        expiresAt = Date.parse(renewed.lockExpiresAt);
    }

    try {
        return await work(renew);
    } finally {
        // If release fails, the lease still expires after a bounded interval.
        await queue.deleteRequestLock(lock.id).catch(() => {});
    }
}
