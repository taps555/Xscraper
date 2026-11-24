import 'dotenv/config';
import { Actor } from 'apify';

import { PlaywrightCrawler } from 'crawlee';
import { Input } from './interfaces/Input.js';
import { collectTweetsFromSearchTimelineResponse } from './services/TweetParses.js';
import { resolveCookieHeader } from './services/auth.js';
import { Diagnostics, buildRecord } from './services/diagnostics.js';
import fs from 'fs';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

await Actor.init();
const input: any = (await Actor.getInput<Input>()) ?? ({} as any);
const MAX_ITEMS: number = input.maxItems ?? 10;

const session = await resolveCookieHeader();
console.log(`Cookie source=${session.source}, jumlah=${session.playwrightCookies.length}`);

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
        const diagnostics = new Diagnostics(log);
        const collectedTweets = new Map<string, any>();
        const browserRequestsAt = new Map<any, number>();
        const harvested = new Set<string>();

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

            if (res.status() !== 200 || !bodyText) return;

            // Respons yang sama bisa terpicu dua kali (mis. saat React re-render).
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
            collectTweetsFromSearchTimelineResponse([parsed], MAX_ITEMS, collectedTweets);
            const added = collectedTweets.size - before;
            if (added > 0) {
                log.info(`Panen ${added} tweet dari respons browser (total ${collectedTweets.size}/${MAX_ITEMS})`);
            }
        });
        // =========================================================

        log.info(`Navigating: ${request.url}`);
        await page.goto(request.url, { waitUntil: 'domcontentloaded', timeout: 60000 });

        // Scroll sampai target terpenuhi. Setiap scroll memicu X mengirim
        // SearchTimeline berikutnya, dan listener di atas memanennya.
        const deadline = Date.now() + 60_000;
        let stagnantRounds = 0;
        let lastSize = 0;

        while (collectedTweets.size < MAX_ITEMS && Date.now() < deadline) {
            await sleep(1200);
            await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});

            if (collectedTweets.size === lastSize) {
                stagnantRounds++;
                // 4 putaran tanpa tambahan -> kemungkinan sudah habis / kena batas.
                if (stagnantRounds >= 4) {
                    log.warning(`Tidak ada tweet baru setelah ${stagnantRounds} putaran scroll, berhenti.`);
                    break;
                }
            } else {
                stagnantRounds = 0;
                lastSize = collectedTweets.size;
            }
        }

        log.info(`Selesai memanen: ${collectedTweets.size} tweet terkumpul.`);
        diagnostics.setHarvestedCount(collectedTweets.size);

        const allTweetsInCrawl = Array.from(collectedTweets.values()).slice(0, MAX_ITEMS);

        if (allTweetsInCrawl.length > 0) {
            await Actor.pushData(allTweetsInCrawl);
            fs.writeFileSync('hasilscraping2.json', JSON.stringify(allTweetsInCrawl, null, 2));
            log.info(`Saved ${allTweetsInCrawl.length} tweets.`);
            await diagnostics.save();
        } else {
            // Jangan diam-diam "sukses": 0 tweet harus terlihat gagal.
            log.info(`URL sekarang: ${page.url()}`);
            log.info(`Judul halaman: ${await page.title()}`);
            const accountBtn = await page.locator('[data-testid="SideNav_AccountSwitcher_Button"]').count();
            log.info(`Terdeteksi sudah login: ${accountBtn > 0}`);

            await Actor.setValue('debug_page.png', await page.screenshot({ fullPage: true }), {
                contentType: 'image/png',
            });
            const diagnosis = await diagnostics.save();
            await Actor.exit(`Scraping gagal: 0 tweet (${diagnosis.verdict})`, { exitCode: 1 });
        }
    },
});

const rawQuery: string = `${input.searchTerm} lang:in`;
await crawler.run([`https://x.com/search?q=${encodeURIComponent(rawQuery)}&src=typed_query&f=top`]);
await Actor.exit();
