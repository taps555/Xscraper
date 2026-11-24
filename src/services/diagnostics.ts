/**
 * Diagnostik untuk membedakan "kena rate limit" vs "cara replay salah".
 *
 * Kunci pembedaannya: kita merekam DUA sumber sekaligus.
 *  - 'browser' : request yang dibuat Chromium sendiri (pasti valid, tid asli, HTTP/2)
 *  - 'replay'  : request yang kita kirim ulang via APIRequestContext
 *
 * Kalau browser 200 tapi replay 404 -> bukan rate limit, tapi cara replay.
 * Kalau browser juga 404 body kosong -> sesi/IP memang ditolak (soft block).
 */

type LogLike = {
    info: (message: string) => void;
    warning: (message: string) => void;
    error: (message: string) => void;
};

export interface RateLimitInfo {
    /** x-rate-limit-limit */
    limit: string | null;
    /** x-rate-limit-remaining */
    remaining: string | null;
    /** x-rate-limit-reset (unix detik) */
    reset: string | null;
    /** x-rate-limit-reset dalam ISO, biar kebaca manusia */
    resetAtIso: string | null;
    /** true kalau remaining === '0' */
    exhausted: boolean;
}

export interface NetworkRecord {
    source: 'browser' | 'replay';
    operation: string;
    method: string;
    status: number | null;
    durationMs: number;
    contentType: string | null;
    bodyLength: number;
    bodyPreview: string;
    /** true kalau body kosong total */
    emptyBody: boolean;
    rateLimit: RateLimitInfo;
    hasTransactionId: boolean;
    transactionId: string | null;
    serverDate: string | null;
    error?: string;
}

export type VerdictCode =
    | 'RATE_LIMITED_EXPLICIT'
    | 'RATE_LIMIT_EXHAUSTED'
    | 'LIKELY_SOFT_BLOCK'
    | 'REPLAY_PROBLEM_NOT_RATE_LIMIT'
    | 'NO_BROWSER_TRAFFIC'
    | 'BROWSER_OK_REPLAY_NOT_TRIED'
    | 'OK'
    | 'INCONCLUSIVE';

export interface Diagnosis {
    verdict: VerdictCode;
    title: string;
    explanation: string;
    evidence: string[];
    recommendations: string[];
}

function headerValue(headers: Record<string, string>, name: string): string | null {
    const wanted = name.toLowerCase();
    for (const [key, value] of Object.entries(headers)) {
        if (key.toLowerCase() === wanted) return value ?? null;
    }
    return null;
}

export function parseRateLimit(headers: Record<string, string>): RateLimitInfo {
    const limit = headerValue(headers, 'x-rate-limit-limit');
    const remaining = headerValue(headers, 'x-rate-limit-remaining');
    const reset = headerValue(headers, 'x-rate-limit-reset');

    let resetAtIso: string | null = null;
    if (reset) {
        const seconds = Number(reset);
        if (Number.isFinite(seconds) && seconds > 0) {
            resetAtIso = new Date(seconds * 1000).toISOString();
        }
    }

    return {
        limit,
        remaining,
        reset,
        resetAtIso,
        exhausted: remaining !== null && Number(remaining) === 0,
    };
}

export class Diagnostics {
    private readonly records: NetworkRecord[] = [];
    private readonly log: LogLike;
    private harvestedCount = 0;

    constructor(log: LogLike) {
        this.log = log;
    }

    /** Jumlah tweet yang berhasil dipanen dari respons browser. */
    setHarvestedCount(count: number): void {
        this.harvestedCount = count;
    }

    add(record: NetworkRecord): void {
        this.records.push(record);

        const rl = record.rateLimit;
        const rlPart =
            rl.remaining !== null || rl.limit !== null
                ? ` rateLimit=${rl.remaining ?? '?'}/${rl.limit ?? '?'}${
                      rl.resetAtIso ? ` resetAt=${rl.resetAtIso}` : ''
                  }`
                : ' rateLimitHeader=TIDAK_ADA';

        const tidPart = record.hasTransactionId ? ' tid=ADA' : ' tid=TIDAK_ADA';
        const bodyPart = record.emptyBody ? ' body=KOSONG' : ` body=${record.bodyLength}B`;

        const line =
            `[diag:${record.source}] ${record.operation} ${record.method} ` +
            `status=${record.status ?? 'n/a'} ${record.durationMs}ms${bodyPart}${rlPart}${tidPart}`;

        if (record.status === 200) {
            this.log.info(line);
        } else if (record.status === 429 || record.rateLimit.exhausted) {
            this.log.error(line);
        } else {
            this.log.warning(line);
        }

        // Preview body saat gagal — ini yang biasanya menjelaskan semuanya
        if (record.status !== 200 && record.bodyPreview) {
            this.log.warning(`[diag:${record.source}] body=${record.bodyPreview}`);
        }
    }

    getRecords(): NetworkRecord[] {
        return this.records;
    }

    /**
     * Bandingkan sumber 'browser' vs 'replay' untuk menyimpulkan penyebab.
     */
    diagnose(): Diagnosis {
        const browser = this.records.filter((r) => r.source === 'browser');
        const replay = this.records.filter((r) => r.source === 'replay');

        const browserOk = browser.filter((r) => r.status === 200);
        const replayOk = replay.filter((r) => r.status === 200);
        const exhausted = this.records.filter((r) => r.rateLimit.exhausted);
        const explicit429 = this.records.filter((r) => r.status === 429);
        const emptyBodyFailures = this.records.filter((r) => r.status !== null && r.status !== 200 && r.emptyBody);

        const evidence: string[] = [];
        evidence.push(`request browser: ${browser.length} (sukses 200: ${browserOk.length})`);
        evidence.push(`request replay : ${replay.length} (sukses 200: ${replayOk.length})`);

        for (const r of this.records) {
            evidence.push(
                `${r.source} ${r.method} -> ${r.status ?? 'n/a'} ` +
                    `(${r.durationMs}ms, body ${r.bodyLength}B` +
                    `${r.rateLimit.remaining !== null ? `, remaining=${r.rateLimit.remaining}` : ''})`,
            );
        }

        if (explicit429.length > 0) {
            const r = explicit429[0];
            return {
                verdict: 'RATE_LIMITED_EXPLICIT',
                title: 'Kena rate limit (429 eksplisit)',
                explanation: 'X membalas 429 Too Many Requests. Ini rate limit yang jelas dan tidak ambigu.',
                evidence,
                recommendations: [
                    `Tunggu sampai ${r.rateLimit.resetAtIso ?? 'window reset berikutnya'} sebelum run lagi.`,
                    'Turunkan frekuensi run / pakai proxy residential agar kuota per-IP terpisah.',
                ],
            };
        }

        if (exhausted.length > 0) {
            const r = exhausted[0];
            return {
                verdict: 'RATE_LIMIT_EXHAUSTED',
                title: 'Kuota rate limit habis (remaining=0)',
                explanation:
                    `Header x-rate-limit-remaining = 0 pada sumber "${r.source}". ` +
                    'Kuota endpoint SearchTimeline untuk sesi/IP ini sudah terpakai habis.',
                evidence,
                recommendations: [
                    `Tunggu sampai ${r.rateLimit.resetAtIso ?? 'window reset berikutnya'}.`,
                    'Pasang PROXY_URL residential supaya tiap run pakai IP berbeda.',
                ],
            };
        }

        // Kasus paling penting: browser sukses, replay gagal.
        if (browserOk.length > 0 && replay.length > 0 && replayOk.length === 0) {
            return {
                verdict: 'REPLAY_PROBLEM_NOT_RATE_LIMIT',
                title: 'BUKAN rate limit — masalahnya di cara replay',
                explanation:
                    'Browser berhasil mendapat 200 dari SearchTimeline, tapi request yang kita kirim ulang ' +
                    'gagal. Artinya sesi Anda masih sehat dan tidak sedang diblokir. Yang salah adalah ' +
                    'request hasil replay (header transaksional basi, stack HTTP berbeda, atau header yang dibuang).',
                evidence,
                recommendations: [
                    'Jangan replay request GraphQL. Ambil data langsung dari response browser (pola old.ts).',
                    'Kalau tetap replay: pakai response browser yang PALING BARU, bukan yang tertua.',
                ],
            };
        }

        if (browser.length === 0) {
            return {
                verdict: 'NO_BROWSER_TRAFFIC',
                title: 'Tidak ada request SearchTimeline dari browser',
                explanation:
                    'Chromium tidak pernah mengirim request SearchTimeline sama sekali. Ini bukan rate limit, ' +
                    'tapi biasanya cookie tidak valid, halaman tidak termuat, atau query kosong.',
                evidence,
                recommendations: [
                    'Cek apakah halaman menampilkan form login (sesi mati).',
                    'Periksa debug_page.png untuk melihat kondisi halaman.',
                ],
            };
        }

        // Browser juga gagal dengan body kosong -> soft block.
        if (browserOk.length === 0 && emptyBodyFailures.length > 0) {
            return {
                verdict: 'LIKELY_SOFT_BLOCK',
                title: 'Kemungkinan besar soft-block / rate limit senyap',
                explanation:
                    'Browser sendiri juga ditolak dengan body kosong. Body kosong berarti request dibuang di ' +
                    'edge X sebelum masuk GraphQL, yang merupakan signature penolakan senyap (bukan error data). ' +
                    'Penyebab paling umum: sesi/IP dianggap terlalu agresif.',
                evidence,
                recommendations: [
                    'Tunggu 15-30 menit, lalu jalankan ulang sekali saja untuk memastikan.',
                    'Pasang PROXY_URL residential — jangan pakai IP datacenter yang sama berulang.',
                    'Ganti akun/cookie kalau tetap gagal setelah jeda.',
                ],
            };
        }

        if (browserOk.length > 0 && replay.length === 0) {
            return {
                verdict: 'BROWSER_OK_REPLAY_NOT_TRIED',
                title: 'Browser sehat, replay belum dijalankan',
                explanation: 'Browser mendapat 200 dan belum ada request replay yang tercatat.',
                evidence,
                recommendations: ['Tidak ada aksi.'],
            };
        }

        if (browserOk.length > 0 && replayOk.length > 0) {
            return {
                verdict: 'OK',
                title: 'Sehat',
                explanation: 'Browser dan replay sama-sama mendapat 200.',
                evidence,
                recommendations: ['Tidak ada aksi.'],
            };
        }

        return {
            verdict: 'INCONCLUSIVE',
            title: 'Belum bisa disimpulkan',
            explanation: 'Data yang terkumpul belum cukup untuk menentukan penyebab.',
            evidence,
            recommendations: ['Jalankan ulang dengan debug aktif dan kirim log lengkapnya.'],
        };
    }

    async save(): Promise<Diagnosis> {
        const diagnosis = this.diagnose();

        this.log.info('================ DIAGNOSIS ================');
        this.log.info(`VERDICT: ${diagnosis.verdict}`);
        this.log.info(`JUDUL  : ${diagnosis.title}`);
        this.log.info(`SEBAB  : ${diagnosis.explanation}`);
        for (const e of diagnosis.evidence) this.log.info(`  bukti: ${e}`);
        for (const r of diagnosis.recommendations) this.log.info(`  saran: ${r}`);
        this.log.info('==========================================');

        try {
            const { Actor } = await import('apify');
            await Actor.setValue('diagnostics.json', {
                diagnosis,
                records: this.records,
                generatedAt: new Date().toISOString(),
            });
        } catch (error) {
            this.log.warning(`Gagal simpan diagnostics.json: ${String(error)}`);
        }

        return diagnosis;
    }
}

/**
 * Bungkus satu respons jadi NetworkRecord. Dipakai untuk browser maupun replay.
 */
export function buildRecord(params: {
    source: 'browser' | 'replay';
    operation: string;
    method: string;
    status: number | null;
    durationMs: number;
    headers: Record<string, string>;
    bodyText: string;
    requestHeaders: Record<string, string>;
    error?: string;
}): NetworkRecord {
    const previewLimit = 400;
    const bodyText = params.bodyText ?? '';
    const transactionId = headerValue(params.requestHeaders, 'x-client-transaction-id');

    return {
        source: params.source,
        operation: params.operation,
        method: params.method,
        status: params.status,
        durationMs: params.durationMs,
        contentType: headerValue(params.headers, 'content-type'),
        bodyLength: bodyText.length,
        bodyPreview: bodyText.slice(0, previewLimit),
        emptyBody: bodyText.trim().length === 0,
        rateLimit: parseRateLimit(params.headers),
        hasTransactionId: Boolean(transactionId),
        transactionId: transactionId ? `${transactionId.slice(0, 16)}...` : null,
        serverDate: headerValue(params.headers, 'date'),
        error: params.error,
    };
}
