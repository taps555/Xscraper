import { describe, expect, it } from 'vitest';

import { Diagnostics, buildRecord, parseRateLimit, type NetworkRecord } from '../src/services/diagnostics.js';

const silent = { info: () => {}, warning: () => {}, error: () => {} };

function rec(
    source: 'browser' | 'replay',
    status: number,
    opts: { body?: string; remaining?: string; reset?: string; tid?: boolean } = {},
): NetworkRecord {
    const headers: Record<string, string> = {};
    if (opts.remaining !== undefined) {
        headers['x-rate-limit-remaining'] = opts.remaining;
        headers['x-rate-limit-limit'] = '50';
    }
    if (opts.reset !== undefined) headers['x-rate-limit-reset'] = opts.reset;

    return buildRecord({
        source,
        operation: 'SearchTimeline',
        method: 'GET',
        status,
        durationMs: 400,
        headers,
        bodyText: opts.body ?? (status === 200 ? '{"data":{}}' : ''),
        requestHeaders: opts.tid === false ? {} : { 'x-client-transaction-id': 'abcdefghijklmnop1234' },
    });
}

function verdictOf(records: NetworkRecord[]): string {
    const d = new Diagnostics(silent);
    for (const r of records) d.add(r);
    return d.diagnose().verdict;
}

describe('parseRateLimit', () => {
    it('membaca header rate limit dan menandai kuota habis', () => {
        const info = parseRateLimit({
            'x-rate-limit-limit': '50',
            'x-rate-limit-remaining': '0',
            'x-rate-limit-reset': '1795491600',
        });

        expect(info.limit).toBe('50');
        expect(info.remaining).toBe('0');
        expect(info.exhausted).toBe(true);
        expect(info.resetAtIso).toBe(new Date(1795491600 * 1000).toISOString());
    });

    it('tidak menandai exhausted kalau header tidak ada', () => {
        const info = parseRateLimit({});
        expect(info.remaining).toBeNull();
        expect(info.exhausted).toBe(false);
    });
});

describe('buildRecord', () => {
    it('mendeteksi body kosong dan ketiadaan transaction id', () => {
        const record = rec('replay', 404, { body: '', tid: false });
        expect(record.emptyBody).toBe(true);
        expect(record.bodyLength).toBe(0);
        expect(record.hasTransactionId).toBe(false);
    });

    it('mencatat transaction id kalau ada', () => {
        const record = rec('browser', 200);
        expect(record.hasTransactionId).toBe(true);
        expect(record.transactionId).toBe('abcdefghijklmnop...');
    });
});

describe('Diagnostics.diagnose', () => {
    it('429 eksplisit -> RATE_LIMITED_EXPLICIT', () => {
        expect(verdictOf([rec('replay', 429, { body: '{"errors":[]}', remaining: '0' })])).toBe(
            'RATE_LIMITED_EXPLICIT',
        );
    });

    it('remaining=0 -> RATE_LIMIT_EXHAUSTED', () => {
        expect(verdictOf([rec('browser', 200, { remaining: '0' })])).toBe('RATE_LIMIT_EXHAUSTED');
    });

    it('browser 200 tapi replay 404 kosong -> REPLAY_PROBLEM_NOT_RATE_LIMIT', () => {
        expect(verdictOf([rec('browser', 200), rec('replay', 404, { body: '' })])).toBe(
            'REPLAY_PROBLEM_NOT_RATE_LIMIT',
        );
    });

    it('browser sendiri 404 kosong -> LIKELY_SOFT_BLOCK', () => {
        expect(verdictOf([rec('browser', 404, { body: '' })])).toBe('LIKELY_SOFT_BLOCK');
    });

    it('tanpa traffic browser -> NO_BROWSER_TRAFFIC', () => {
        expect(verdictOf([])).toBe('NO_BROWSER_TRAFFIC');
    });

    it('browser dan replay 200 -> OK', () => {
        expect(verdictOf([rec('browser', 200), rec('replay', 200)])).toBe('OK');
    });

    it('browser 200 dan tweet dipanen -> OK', () => {
        const d = new Diagnostics(silent);
        d.add(rec('browser', 200));
        d.setHarvestedCount(10);
        expect(d.diagnose().verdict).toBe('OK');
    });

    it('browser 200 tapi 0 tweet -> BROWSER_OK_NO_TWEETS', () => {
        const d = new Diagnostics(silent);
        d.add(rec('browser', 200));
        d.setHarvestedCount(0);
        expect(d.diagnose().verdict).toBe('BROWSER_OK_NO_TWEETS');
    });
});
