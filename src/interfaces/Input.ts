import type { Cookie } from 'playwright';

export interface Input {
    searchTerm?: string;
    maxItems?: number;
    maxRequestsPerCrawl?: number;
}

export interface ParsedCookieSession {
    cookieHeader: string;
    ct0: string;
    playwrightCookies: Cookie[];
}
