import 'dotenv/config';
import { Actor } from 'apify';

import { PlaywrightCrawler } from 'crawlee';
import { AuthService } from './services/auth.js';
import { Input } from './interfaces/Input.js';
import { fetchSearch } from './QueryIdExtractor.js';
import { collectTweetsFromSearchTimelineResponse } from './services/TweetParses.js';
import { parseCookieHeaderString } from './services/auth.js';
import fs from 'fs';
import { json } from 'stream/consumers';

await Actor.init();
const input: any = (await Actor.getInput<Input>()) ?? ({} as any);
const MAX_ITEMS: number = input.maxItems ?? 10;

const authServiceCookies = await AuthService.getCookies();
const session = authServiceCookies
    ? {
          cookieHeader: authServiceCookies.cookies.map((c) => `${c.name}=${c.value}`).join('; '),
          ct0: authServiceCookies.cookies.find((c) => c.name === 'ct0')?.value ?? '',
          playwrightCookies: authServiceCookies.cookies,
      }
    : await parseCookieHeaderString(input.cookieHeader ?? '');

if (!input.searchTerm) {
    await Actor.exit('Input searchTerm wajib diisi', { exitCode: 1 });
}

function extractQueryId(url: string, operationName: string): string | null {
    const regex = new RegExp(String.raw`/graphql/([a-zA-Z0-9_-]+)/${operationName}(?:\?|$)`);
    const match = regex.exec(url);
    return match ? match[1] : null;
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

        const queryIdPromise = new Promise<string>((resolve) => {
            page.on('request', (req) => {
                const url = req.url();
                if (url.includes('SearchByRawQuery')) {
                    const id = extractQueryId(url, 'SearchByRawQuery');
                    console.log('BERHASIL TANGKAP QUERY ID:', id);
                    if (id) resolve(id);
                }
            });
        });

        log.info(`Navigating: ${request.url}`);
        await page.goto(request.url, { waitUntil: 'domcontentloaded', timeout: 60000 });

        const scrollInterval = setInterval(async () => {
            await page.evaluate(() => window.scrollBy(0, 1500)).catch(() => {});
        }, 2000);

        const capturedQueryId = await Promise.race([
            queryIdPromise,
            new Promise<string>((_, reject) => setTimeout(() => reject('Timeout'), 30000)),
        ]).catch(() => null);

        clearInterval(scrollInterval);

        if (!capturedQueryId) {
            log.error('Gagal menangkap QueryId, menutup crawler.');
            return;
        }

        log.info(`QueryId captured: ${capturedQueryId}. Fetching data...`);

        const collectedTweets = new Map<string, any>();

        try {
            const tweets = await fetchSearch({
                searchTerm: input.searchTerm,
                limit: MAX_ITEMS,
                queryId: capturedQueryId,
                cookieHeader: session.cookieHeader,
                ct0: session.ct0,
            });

            collectTweetsFromSearchTimelineResponse(tweets, input.maxItems ?? 10, collectedTweets);

            const allTweetsInCrawl = Array.from(collectedTweets.values()).slice(0, input.maxItems ?? 10);

            if (allTweetsInCrawl.length > 0) {
                await Actor.pushData(allTweetsInCrawl);
                fs.writeFileSync('hasilscraping_bunated.json', JSON.stringify(allTweetsInCrawl, null, 2));
                console.log(`Saved ${allTweetsInCrawl.length} tweets.`);
            }
        } catch (err) {
            log.error('Error saat fetchSearch:');
            await Actor.exit(`Gagal fetch data: ${err instanceof Error ? err.message : String(err)}`, { exitCode: 1 });
        }
    },
});

const rawQuery: string = `${input.searchTerm} lang:in`;
await crawler.run([`https://x.com/search?q=${encodeURIComponent(rawQuery)}&src=typed_query&f=top`]);
await Actor.exit();
