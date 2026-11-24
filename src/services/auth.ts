import fs from 'fs';
import path from 'path';
import { ParsedCookieSession } from '../interfaces/Input.js';
import { Cookie } from 'playwright';
import { KeyValueStore } from 'crawlee';

interface StoredSession {
    cookies: Cookie[];
    capturedAt: string;
}
const STORE_NAME = 'cookie-sessions';
const KEY = 'x-main';

export function normalizeCookies(rawCookies: any[]): Cookie[] {
    return rawCookies.map((c) => {
        let sameSite: 'Strict' | 'Lax' | 'None' = 'Lax';
        const rawSameSite = String(c.sameSite ?? '').toLowerCase();

        if (rawSameSite === 'no_restriction' || rawSameSite === 'none') {
            sameSite = 'None';
        } else if (rawSameSite === 'strict') {
            sameSite = 'Strict';
        }

        return {
            name: c.name,
            value: c.value,
            domain: c.domain,
            path: c.path || '/',
            expires:
                typeof c.expires === 'number'
                    ? c.expires
                    : typeof c.expirationDate === 'number'
                      ? Math.floor(c.expirationDate)
                      : -1,
            httpOnly: Boolean(c.httpOnly),
            secure: Boolean(c.secure),
            sameSite,
        };
    });
}

export const AuthService = {
    async saveCookies(cookie: any[]) {
        const store = await KeyValueStore.open('cookie-session');
        await store.setValue('x-main', cookie);
    },
    async getCookies(): Promise<StoredSession | null> {
        try {
            const store = await KeyValueStore.open(STORE_NAME);
            const cookie = await store.getValue<any[]>(KEY);

            if (!Array.isArray(cookie) || cookie.length === 0) {
                console.error('x-main kosong atau belum ada di store cookie-sessions.');
                return null;
            }

            console.log(`Load ${cookie.length} cookies dari store`);
            return {
                cookies: cookie, // sudah format Playwright, tanpa normalizeCookies
                capturedAt: new Date().toISOString(),
            };
        } catch (error) {
            console.error('Gagal load cookies:', error);
            return null;
        }
    },
};

export const parseCookieHeaderString = async (rawCookieString: string): Promise<ParsedCookieSession> => {
    const cookieHeader = rawCookieString.trim();
    const playwrightCookies: Cookie[] = [];
    let ct0 = '';
    const names: string[] = [];

    const pairs = cookieHeader.split(';');

    for (const pair of pairs) {
        const trimmed = pair.trim();
        if (!trimmed) continue;

        const eqIndex = trimmed.indexOf('=');
        if (eqIndex === -1) continue;

        const name = trimmed.slice(0, eqIndex).trim();
        const value = trimmed.slice(eqIndex + 1).trim();

        if (name === 'ct0') ct0 = value;
        names.push(name);

        playwrightCookies.push({
            name,
            value,
            domain: '.x.com',
            path: '/',
            expires: -1,
            httpOnly: name === 'auth_token',
            secure: true,
            sameSite: name === 'ct0' ? 'Lax' : 'None',
        });
    }

    if (!ct0) {
        throw new Error('Token ct0 tidak ditemukan di dalam cookie string header.');
    }

    // auth_token adalah SATU-SATUNYA cookie yang menentukan "sudah login atau belum".
    // Tanpa ini, X tetap membalas 200 tapi menampilkan halaman publik tanpa request
    // SearchTimeline -> queryId tidak akan pernah tertangkap.
    if (!names.includes('auth_token')) {
        throw new Error(
            `Cookie "auth_token" TIDAK ADA di dalam cookieHeader (hanya ada ${names.length} cookie: ${names.join(', ')}).\n` +
                'auth_token adalah cookie penentu login. Tanpa itu, X menganggap kamu pengunjung anonim\n' +
                'dan tidak pernah mengirim request SearchTimeline, sehingga QueryId tidak bisa ditangkap.\n' +
                'Cara mengambil: buka x.com di browser -> login -> DevTools > Application > Cookies > https://x.com\n' +
                '-> copy SEMUA cookie (terutama auth_token dan ct0) dalam format "nama=nilai; nama=nilai".',
        );
    }

    return {
        cookieHeader,
        ct0,
        playwrightCookies,
    };
};
