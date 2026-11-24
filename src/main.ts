import 'dotenv/config';
import { Actor } from 'apify';

import { PlaywrightCrawler } from 'crawlee';
import { Input } from './interfaces/Input.js';
import { fetchSearch } from './QueryIdExtractor.js';
import { collectTweetsFromSearchTimelineResponse } from './services/TweetParses.js';
import { parseCookieHeaderString, AuthService } from './services/auth.js';
import { Diagnostics, buildRecord } from './services/diagnostics.js';
import fs from 'fs';

interface CapturedRequest {
    id: string;
    operation: string;
    url: string;
    method: string;
    headers: Record<string, string>;
    body: string | null;
}

await Actor.init();
const input: any = (await Actor.getInput<Input>()) ?? ({} as any);
const MAX_ITEMS: number = input.maxItems ?? 10;

const session = input.cookieHeader?.trim()
    ? await (async () => {
          const s = await parseCookieHeaderString(input.cookieHeader);
          await AuthService.saveCookies(s.playwrightCookies);
          return s;
      })()
    : await (async () => {
          const authServiceCookies = await AuthService.getCookies();
          if (!authServiceCookies) {
              throw new Error(
                  'Cookie tidak ditemukan: isi "cookieHeader" di input, atau sediakan file cookie di key-value store.',
              );
          }
          return {
              cookieHeader: authServiceCookies.cookies.map((c) => `${c.name}=${c.value}`).join('; '),
              ct0: authServiceCookies.cookies.find((c) => c.name === 'ct0')?.value ?? '',
              playwrightCookies: authServiceCookies.cookies,
          };
      })();

if (!input.searchTerm) {
    await Actor.exit('Input searchTerm wajib diisi', { exitCode: 1 });
}

function extractQueryId(url: string, pattern: RegExp): { id: string; operation: string } | null {
    const match = pattern.exec(url);
    if (!match) return null;
    const opMatch = /\/graphql\/[a-zA-Z0-9_-]+\/([A-Za-z]+)/.exec(url);
    return { id: match[1], operation: opMatch?.[1] ?? 'unknown' };
}

const proxyConfiguration = process.env.PROXY_URL
    ? await Actor.createProxyConfiguration({
          proxyUrls: [process.env.PROXY_URL],
      })
    : undefined;

const crawler = new PlaywrightCrawler({
    headless: false,
    proxyConfiguration,
    maxConcurrency: 1,
    requestHandlerTimeoutSecs: 120,
    async requestHandler({ page, request, log }) {
        await page.context().addCookies(session.playwrightCookies);

        const QUERY_ID_REGEX = /\/graphql\/([a-zA-Z0-9_-]+)\/Search[A-Za-z]*(?:\?|$)/;

        // X bisa mengirim lebih dari satu operasi Search* (SearchByRawQuery, SearchTimeline, ...).
        // Yang kita mau: SearchByRawQuery (paling lengkap + biasanya GET).
        // Tapi kalau tidak muncul, pakai kandidat pertama yang tertangkap.
        const candidates: CapturedRequest[] = [];
        let resolveCaptured: (value: CapturedRequest | null) => void = () => {};
        const queryIdPromise = new Promise<CapturedRequest | null>((resolve) => {
            resolveCaptured = resolve;
        });

        page.on('request', (req) => {
            const url = req.url();
            const result = extractQueryId(url, QUERY_ID_REGEX);
            if (!result) return;

            const captured: CapturedRequest = {
                ...result,
                url,
                method: req.method(),
                headers: req.headers() as Record<string, string>,
                // body WAJIB ikut disimpan: SearchTimeline dikirim sebagai POST
                body: req.postData() ?? null,
            };

            candidates.push(captured);
            log.info(
                `QueryId ditangkap: operation=${captured.operation}, id=${captured.id}, method=${captured.method}`,
            );

            if (captured.operation === 'SearchByRawQuery') {
                resolveCaptured(captured);
            } else {
                setTimeout(() => resolveCaptured(captured), 3000);
            }
        });

        // ================= DIAGNOSTIK =================
        // Rekam respons yang dibuat BROWSER sendiri (bukan replay).
        // Ini pembeda utama: kalau browser 200 tapi replay 404 -> bukan rate limit.
        const diagnostics = new Diagnostics(log);
        const browserRequestsAt = new Map<any, number>();

        page.on('request', (req) => {
            browserRequestsAt.set(req, Date.now());
        });

        page.on('response', async (res) => {
            const url = res.url();
            if (!url.includes('/i/api/graphql/')) return;
            const result = extractQueryId(url, QUERY_ID_REGEX);
            if (!result) return;

            const req = res.request();
            const startedAt = browserRequestsAt.get(req) ?? Date.now();

            let bodyText = '';
            let readError: string | undefined;
            try {
                bodyText = await res.text();
            } catch (error) {
                readError = error instanceof Error ? error.message : String(error);
            }

            diagnostics.add(
                buildRecord({
                    source: 'browser',
                    operation: result.operation,
                    method: req.method(),
                    status: res.status(),
                    durationMs: Date.now() - startedAt,
                    headers: res.headers() as Record<string, string>,
                    bodyText,
                    requestHeaders: req.headers() as Record<string, string>,
                    error: readError,
                }),
            );
        });
        // ==============================================

        log.info(`Navigating: ${request.url}`);
        await page.goto(request.url, { waitUntil: 'domcontentloaded', timeout: 60000 });

        const scrollInterval = setInterval(async () => {
            await page.evaluate(() => window.scrollBy(0, 1500)).catch(() => {});
        }, 2000);

        const captured = await Promise.race([
            queryIdPromise,
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 20000)),
        ]).catch(() => null);

        clearInterval(scrollInterval);

        // Fallback: kalau SearchByRawQuery tidak muncul, pakai kandidat TERBARU.
        // Versi sebelumnya memakai candidates[0] (yang tertua) -> header transaksional basi.
        const capturedQueryId = captured ?? candidates[candidates.length - 1] ?? null;
        if (!captured && capturedQueryId) {
            log.warning(
                `SearchByRawQuery tidak muncul, fallback ke kandidat terbaru: ` +
                    `${capturedQueryId.operation} (${capturedQueryId.method})`,
            );
        }

        if (!capturedQueryId) {
            log.error('Gagal menangkap QueryId, menutup crawler.');
            log.info(`URL sekarang: ${page.url()}`);
            log.info(`Judul halaman: ${await page.title()}`);

            const accountBtn = await page.locator('[data-testid="SideNav_AccountSwitcher_Button"]').count();
            log.info(`Terdeteksi sudah login: ${accountBtn > 0}`);

            await Actor.setValue('debug_page.png', await page.screenshot({ fullPage: true }), {
                contentType: 'image/png',
            });
            await diagnostics.save();
            return;
        }

        log.info(`QueryId captured: ${capturedQueryId.operation} (${capturedQueryId.id}). Fetching data...`);

        const collectedTweets = new Map<string, any>();

        try {
            const tweets = await fetchSearch({
                limit: MAX_ITEMS,
                request: {
                    url: capturedQueryId.url,
                    method: capturedQueryId.method,
                    headers: capturedQueryId.headers,
                    body: capturedQueryId.body,
                },
                fetchFn: async (req) => {
                    // Header yang tidak boleh/ tidak perlu dikirim manual lewat APIRequestContext
                    const skip = new Set([
                        'cookie',
                        'content-length',
                        'host',
                        'connection',
                        'accept-encoding',
                        'origin',
                    ]);
                    const cleanHeaders: Record<string, string> = {};
                    for (const [k, v] of Object.entries(req.headers ?? {})) {
                        if (!skip.has(k.toLowerCase())) cleanHeaders[k] = v;
                    }

                    // Jangan timpa dengan string kosong: kalau ct0 tidak ada, header
                    // yang sudah ada dari capture tetap dipakai.
                    if (session.ct0) {
                        cleanHeaders['x-csrf-token'] = session.ct0;
                    }

                    const startedAt = Date.now();
                    const res = await page.context().request.fetch(req.url, {
                        method: req.method,
                        headers: cleanHeaders,
                        data: req.body ?? undefined,
                        failOnStatusCode: false,
                        timeout: 60000,
                    });

                    const text = await res.text();

                    diagnostics.add(
                        buildRecord({
                            source: 'replay',
                            operation: extractQueryId(req.url, QUERY_ID_REGEX)?.operation ?? 'unknown',
                            method: req.method,
                            status: res.status(),
                            durationMs: Date.now() - startedAt,
                            headers: res.headers() as Record<string, string>,
                            bodyText: text,
                            requestHeaders: cleanHeaders,
                        }),
                    );

                    let body: any = text;
                    try {
                        body = JSON.parse(text);
                    } catch {
                        // biarkan string kalau bukan JSON
                    }
                    return { status: res.status(), body };
                },
            });

            collectTweetsFromSearchTimelineResponse(tweets, input.maxItems ?? 10, collectedTweets);

            const allTweetsInCrawl = Array.from(collectedTweets.values()).slice(0, input.maxItems ?? 10);

            if (allTweetsInCrawl.length > 0) {
                await Actor.pushData(allTweetsInCrawl);
                fs.writeFileSync('hasilscraping2.json', JSON.stringify(allTweetsInCrawl, null, 2));
                console.log(`Saved ${allTweetsInCrawl.length} tweets.`);
            } else {
                // Jangan diam-diam "sukses": 0 tweet harus terlihat gagal.
                const diagnosis = await diagnostics.save();
                log.error(
                    `Tidak ada tweet yang tersimpan. Verdict: ${diagnosis.verdict} (${diagnosis.title})`,
                );
                throw new Error(`Scraping gagal: 0 tweet (${diagnosis.verdict})`);
            }
        } catch (err) {
            log.error('Error saat fetchSearch:');
            await diagnostics.save();
            await Actor.exit(`Gagal fetch data: ${err instanceof Error ? err.message : String(err)}`, { exitCode: 1 });
        }
    },
});

const rawQuery: string = `${input.searchTerm} lang:in`;
await crawler.run([`https://x.com/search?q=${encodeURIComponent(rawQuery)}&src=typed_query&f=top`]);
await Actor.exit();
