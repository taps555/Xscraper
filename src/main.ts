import 'dotenv/config';
import { Actor } from 'apify';

import { PlaywrightCrawler } from 'crawlee';
import { Input } from './interfaces/Input.js';
import { collectTweetsFromSearchTimelineResponse } from './services/TweetParses.js';
import { resolveCookieHeader } from './services/auth.js';
import { Diagnostics, buildRecord } from './services/diagnostics.js';
import { listKeyword } from './services/keyword.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

await Actor.init();
const input: any = (await Actor.getInput<Input>()) ?? ({} as any);
const MAX_ITEMS: number = input.maxItems ?? 10;

const searchTerms = listKeyword(input.searchTerms ?? input.searchTerms);

const session = await resolveCookieHeader();
console.log(`Cookie source=${session.source}, jumlah=${session.playwrightCookies.length}`);

if (searchTerms.length === 0) {
    await Actor.exit('Input searchTerm wajib diisi', { exitCode: 1 });
}

console.log(`start scarping ${searchTerms.length}`);
const pushedTweetIds = new Set<string>();
let remaining = MAX_ITEMS;
let keywordsWithData = 0;
let keywordsWithZero = 0;
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
    headless: true,
    proxyConfiguration,
    maxConcurrency: 1,
    maxRequestsPerMinute: 6,
    requestHandlerTimeoutSecs: 120,
    async requestHandler({ page, request, log }) {
        const term = (request.userData.term as string) ?? 'unknown';

        const quotaLeft = Math.max(0, remaining);
        if (quotaLeft === 0) {
            log.info(`[${term}] Kuota total ${MAX_ITEMS} sudah terpakai, keyword dilewati.`);
            return;
        }

        const limtiKeyword = MAX_ITEMS;
        await page.context().addCookies(session.playwrightCookies);

        const QUERY_ID_REGEX = /\/graphql\/([a-zA-Z0-9_-]+)\/Search[A-Za-z]*(?:\?|$)/;
        const diagnostics = new Diagnostics(log);
        const collectedTweets = new Map<string, any>();
        const browserRequestsAt = new Map<any, number>();
        const harvested = new Set<string>();

        page.on('request', (req) => {
            browserRequestsAt.set(req, Date.now());
        });

        page.on('response', async (res) => {
            const url = res.url();
            if (!/\/graphql\/[A-Za-z0-9_-]+\/[A-Za-z]/.test(url)) return;
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

            if (res.status() !== 200 || !bodyText) return;

            const key = `${url}#${bodyText.length}`;
            if (harvested.has(key)) return;
            harvested.add(key);

            let parsed: any;
            try {
                parsed = JSON.parse(bodyText);
            } catch {
                return;
            }

            const before = collectedTweets.size;
            collectTweetsFromSearchTimelineResponse([parsed], limtiKeyword, collectedTweets);

            const added = collectedTweets.size - before;
            if (added > 0) {
                log.info(`[${term}] Panen ${added} tweet (total ${collectedTweets.size}/${limtiKeyword})`);
            }
        });
        // =========================================================

        log.info(`Navigating: ${request.url}`);
        await page.goto(request.url, { waitUntil: 'domcontentloaded', timeout: 60000 });

        const deadline = Date.now() + 60_000;
        let stagnantRounds = 0;
        let lastSize = 0;

        while (collectedTweets.size < limtiKeyword && Date.now() < deadline) {
            await sleep(1200);
            await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});

            if (collectedTweets.size === lastSize) {
                stagnantRounds++;
                if (stagnantRounds >= 4 && collectedTweets.size > 0) {
                    log.warning(`Tidak ada tweet baru setelah ${stagnantRounds} putaran scroll, berhenti.`);
                    break;
                }
            } else {
                stagnantRounds = 0;
                lastSize = collectedTweets.size;
            }
        }

        log.info(`Selesai /* memanen */: ${collectedTweets.size} tweet terkumpul.`);
        diagnostics.setHarvestedCount(collectedTweets.size);

        const allTweetsInCrawl = Array.from(collectedTweets.values())
            .slice(0, limtiKeyword)
            .map((tweet) => ({ ...tweet, searchTerm: term }));

        // Buang tweet yang sudah dikirim oleh keyword sebelumnya
        const freshTweets = allTweetsInCrawl.filter((t) => !pushedTweetIds.has(t.id));

        if (freshTweets.length > 0) {
            freshTweets.forEach((t) => pushedTweetIds.add(t.id));
            remaining -= freshTweets.length;

            await Actor.pushData(freshTweets);
            // fs.writeFileSync(
            //     `hasilscraping_${term.replace(/[^a-z0-9]+/gi, '_').toLowerCase()}.json`,
            //     JSON.stringify(freshTweets, null, 2),
            // );
            log.info(`[${term}] Saved ${freshTweets.length} tweets. Sisa kuota: ${remaining}/${MAX_ITEMS}`);
            await diagnostics.save();
            keywordsWithData++;
        } else {
            log.info(`[${term}] URL sekarang: ${page.url()}`);
            log.info(`[${term}] Judul halaman: ${await page.title()}`);
            const accountBtn = await page.locator('[data-testid="SideNav_AccountSwitcher_Button"]').count();
            log.info(`[${term}] Terdeteksi sudah login: ${accountBtn > 0}`);

            await Actor.setValue(
                `debug_page_${term.replace(/[^a-z0-9]+/gi, '_').toLowerCase()}.png`,
                await page.screenshot({ fullPage: true }),
                { contentType: 'image/png' },
            );

            const diagnosis = await diagnostics.save();
            // TIDAK Actor.exit di sini: 0 tweet pada satu keyword bukan alasan membunuh seluruh run.
            log.warning(`[${term}] 0 tweet (${diagnosis.verdict}). Lanjut keyword berikutnya.`);
            keywordsWithZero++;
        }
    },
});

// ---------- loop semua keyword ----------
for (const [index, term] of searchTerms.entries()) {
    if (remaining <= 0) {
        console.log(`Kuota total ${MAX_ITEMS} sudah terpakai, sisa keyword dilewati.`);
        break;
    }

    const rawQuery = `${term} lang:in`;
    const url = `https://x.com/search?q=${encodeURIComponent(rawQuery)}&src=typed_query&f=top`;

    console.log(`\n=== [${index + 1}/${searchTerms.length}] Keyword: "${term}" ===`);

    await crawler.run([{ url, userData: { term } }]);

    if (index < searchTerms.length - 1 && remaining > 0) {
        console.log('Jeda 10 detik sebelum keyword berikutnya...');
        await sleep(10_000);
    }
}

// ---------- keputusan akhir ----------
console.log(
    `\nSelesai. Keyword berhasil: ${keywordsWithData}, keyword kosong: ${keywordsWithZero}, total tweet: ${pushedTweetIds.size}`,
);

if (keywordsWithData === 0) {
    await Actor.exit('Semua keyword menghasilkan 0 tweet', { exitCode: 1 });
}

await Actor.exit();
