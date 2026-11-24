import fs from 'fs';
import { ResponseSearchQuery } from './interfaces/Response.js';

export interface SearchRequest {
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: string | null;
}

interface SearchOptions {
    limit: number;
    request: SearchRequest;
    fetchFn: (req: SearchRequest) => Promise<{ status: number; body: any }>;
    /** Jeda antar halaman (halaman pertama tidak ditunda). Default 400ms. */
    pageDelayMs?: number;
}

function safeParseJson(value: string | null | undefined): any {
    if (!value) return null;
    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
}

function withCursor(base: SearchRequest, cursor: string | null): SearchRequest {
    if (!cursor) return base;

    if ((base.method || 'GET').toUpperCase() === 'GET') {
        const u = new URL(base.url);
        const variables = safeParseJson(u.searchParams.get('variables')) ?? {};
        variables.cursor = cursor;
        u.searchParams.set('variables', JSON.stringify(variables));
        return { ...base, url: u.toString() };
    }

    const payload = safeParseJson(base.body) ?? {};
    const parsedVariables = safeParseJson(payload.variables) ?? payload.variables ?? {};
    payload.variables = { ...parsedVariables, cursor };
    return { ...base, body: JSON.stringify(payload) };
}

export async function fetchSearch({ limit, request, fetchFn, pageDelayMs = 400 }: SearchOptions) {
    if (!request?.url) throw new Error('request URL tidak tersedia');

    const allResponses: any[] = [];
    let collectedCount = 0;
    let cursor: string | null = null;
    let pageIndex = 0;

    console.log(`Mulai scraping dengan limit ${limit} (${request.method} ${request.url.split('?')[0]})`);

    while (collectedCount < limit) {
        // Delay hanya ANTAR halaman. Dulu selalu menunggu 1500ms bahkan sebelum request
        // pertama, padahal request pertama itu replay dari request yang barusan dikirim X.
        if (pageIndex > 0 && pageDelayMs > 0) {
            await new Promise((r) => setTimeout(r, pageDelayMs));
        }
        pageIndex++;

        // halaman berikutnya: sunting cursor sesuai bentuk request asli (GET/POST)
        const currentRequest = withCursor(request, cursor);

        try {
            const res = await fetchFn(currentRequest);
            // body mentah dari network: belum tentu JSON/objek yang valid
            const raw: any = res.body;

            if (res.status !== 200 || !raw || typeof raw !== 'object') {
                const preview = typeof raw === 'string' ? raw.slice(0, 300) : raw;
                console.error(`Response tidak valid (status ${res.status}):`, preview || '(body kosong)');

                // Diagnosa: 404 body kosong biasanya berarti path GraphQL tidak menerima
                // operasi yang diminta (variables tidak terbaca / queryId tidak cocok).
                try {
                    const u = new URL(currentRequest.url);
                    console.error(
                        `  method=${currentRequest.method} ` +
                            `variables=${u.searchParams.get('variables') ? 'ada' : 'TIDAK ADA'} ` +
                            `features=${u.searchParams.get('features') ? 'ada' : 'TIDAK ADA'} ` +
                            `body=${currentRequest.body ? `${currentRequest.body.length} byte` : 'kosong'}`,
                    );
                } catch {
                    // best-effort
                }
                break;
            }

            const data = raw as ResponseSearchQuery;

            allResponses.push(data);
            fs.writeFileSync('debug_response.json', JSON.stringify(data, null, 2));

            // GraphQL error ada di level atas (data.errors), bukan di data.data
            const topErrors = (data as any)?.errors;
            if (topErrors) {
                console.error('GraphQL errors:', JSON.stringify(topErrors).slice(0, 500));
            }
            const root: any = (data as any)?.data ?? {};
            const timeline = root?.search_by_raw_query?.search_timeline?.timeline ?? root?.search_timeline?.timeline;
            const instructions = timeline?.instructions || [];

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
