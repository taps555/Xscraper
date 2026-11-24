import { Cookie } from 'playwright';

export interface Input {
    searchTerm?: string;
    maxItems?: number;
    maxRequestsPerCrawl?: number;
    /** String cookie mentah: "auth_token=...; ct0=...; ..." */
    cookieHeader?: string;
    /** Path file cookie di dalam key-value store, mis. "cookie-sessions/x-main.json" */
    cookieFilePath?: string;
}

export interface ParsedCookieSession {
    cookieHeader: string;
    ct0: string;
    playwrightCookies: Cookie[];
}
