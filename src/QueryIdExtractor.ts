import got from 'got';
import { AuthService } from './services/auth.js';
import fs from 'fs';
import { ResponseSearchQuery } from './interfaces/Response.js';
import { error } from 'console';

interface SearchOptions {
    searchTerm: string;
    limit: number;
    queryId: string;
    cookieHeader: string;
    ct0: string;
}

const bearerTokenPublic = process.env.bearerTokenPublic;

export async function fetchSearch({ searchTerm, limit, queryId, cookieHeader, ct0 }: SearchOptions) {
    if (!cookieHeader) throw new Error('cookie tidak tersimpan');
    if (!ct0) throw new Error('token ct0 tidak ada');
    const bearerToken = process.env.BEARER_TOKEN || bearerTokenPublic;

    const client = got.extend({
        headers: {
            authorization: `Bearer ${bearerToken}`,
            cookie: cookieHeader,
            'x-csrf-token': ct0,
            'x-twitter-auth-type': 'OAuth2Session',
            'x-twitter-active-user': 'yes',
            'x-twitter-client-language': 'en',
            'user-agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        },
        responseType: 'json',
    });

    const allResponses: any[] = [];
    let collectedCount = 0;
    let cursor: string | null = null;

    console.log(`Mulai scraping: "${searchTerm}" dengan limit ${limit}`);

    while (collectedCount < limit) {
        await new Promise((r) => setTimeout(r, 1500));

        const variables = {
            rawQuery: `${searchTerm} lang:in`,
            product: 'Top', // ganti ke 'Latest' jika ingin tweet terbaru
            querySource: 'typed_query',
            count: 20,
            cursor,
            withMediaGridTweet: false,
            __relay_internal__pv__xclientsfeaturesappviewerisloggedinrelayprovider: true,
            __relay_internal__pv__xclientsfeaturestranslationgroktranslatedpostenabledrelayprovider: true,
            __relay_internal__pv__replydownvoteenabledrelayprovider: false,
            __relay_internal__pv__postctafetchenabledrelayprovider: false,
            __relay_internal__pv__xclientsfeaturestweetcomponentsgrokanalyzepostrelayprovider: true,
            __relay_internal__pv__xclientsfeaturestranslationnoteautotranslationenabledrelayprovider: true,
            __relay_internal__pv__liveeventpostcontextenabledrelayprovider: true,
            __relay_internal__pv__xclientsfeaturestweetsportspostcontextenabledrelayprovider: true,
            __relay_internal__pv__timelineuserbioautotranslationrelayprovider: true,
        };

        try {
            const res: any = await client.get(`https://api.x.com/graphql/${queryId}/SearchByRawQuery`, {
                searchParams: {
                    variables: JSON.stringify(variables),
                },
            });

            const data: ResponseSearchQuery = res.body;
            allResponses.push(data);
            fs.writeFileSync('debug_response.json', JSON.stringify(data, null, 2));

            const instructions = data.data?.search_by_raw_query?.search_timeline?.timeline?.instructions || [];

            const addEntries = instructions.find((i: any) => (i.__typename || i.type) === 'TimelineAddEntries');
            const entries = addEntries?.entries || [];

            const tweetCountInPage = entries.filter((e: any) => {
                const id = e.entry_id || e.entryId || '';
                const innerType = e.content?.content?.__typename || e.content?.itemContent?.__typename;
                return id.startsWith('tweet-') || innerType === 'TimelineTweet';
            }).length;
            collectedCount += tweetCountInPage;

            const cursorEntry = entries.find((e: any) => {
                const id = e.entry_id || e.entryId || '';
                return (
                    id.startsWith('cursor-bottom') ||
                    e.content?.cursor_type === 'Bottom' ||
                    e.content?.cursorType === 'Bottom'
                );
            });
            cursor = cursorEntry?.content?.value ?? null;

            console.log(
                `Dapat ${tweetCountInPage} item. Total: ${collectedCount}. Cursor: ${cursor ? 'Active' : 'None'}`,
            );

            if (tweetCountInPage === 0) {
                console.log('DEBUG struktur data.data:', Object.keys((data as any)?.data ?? {}));
                break;
            }

            if (collectedCount >= limit || !cursor) break;
        } catch (error: any) {
            console.error('Fetch error:', error?.response?.statusCode, error?.response?.body || error.message);
            break;
        }
    }
    return allResponses;
}
