import type { ParsedCookieSession } from '../interfaces/Input.js';
import type { Cookie } from 'playwright';
import { KeyValueStore } from 'crawlee';

interface StoredSession {
    cookies: Cookie[];
    capturedAt: string;
}
const STORE_NAME = 'cookie-session';
const KEY = 'x-main';
const ENV_COOKIE_HEADER = 'X_COOKIE_HEADER';

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
        const store = await KeyValueStore.open(STORE_NAME);
        await store.setValue(KEY, cookie);
    },
    async getCookies(): Promise<StoredSession | null> {
        try {
            const store = await KeyValueStore.open(STORE_NAME);
            const cookie = await store.getValue<any[]>(KEY);

            if (!Array.isArray(cookie) || cookie.length === 0) {
                console.error(`x-main kosong atau belum ada di store ${STORE_NAME}.`);
                return null;
            }

            console.log(`Load ${cookie.length} cookies dari store ${STORE_NAME}`);
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

export async function resolveCookieHeader(): Promise<{
    cookieHeader: string;
    ct0: string;
    playwrightCookies: Cookie[];
    source: 'env' | 'store';
}> {
    const envCookie = process.env[ENV_COOKIE_HEADER]?.trim();

    if (envCookie) {
        console.log(`Cookie diambil dari env var ${ENV_COOKIE_HEADER}`);
        const parsed = await parseCookieHeaderString(envCookie);
        await AuthService.saveCookies(parsed.playwrightCookies);
        return { ...parsed, source: 'env' };
    }

    const stored = await AuthService.getCookies();
    if (stored) {
        const ct0 = stored.cookies.find((c) => c.name === 'ct0')?.value ?? '';
        if (!ct0) {
            throw new Error(
                `Cookie di store ${STORE_NAME} tidak punya "ct0". Hapus isi store itu, ` +
                    `lalu isi env var ${ENV_COOKIE_HEADER} dengan cookie yang lengkap.`,
            );
        }
        return {
            cookieHeader: stored.cookies.map((c) => `${c.name}=${c.value}`).join('; '),
            ct0,
            playwrightCookies: stored.cookies,
            source: 'store',
        };
    }

    throw new Error(
        `Cookie tidak ditemukan. Isi environment variable "${ENV_COOKIE_HEADER}" ` +
            'di Apify Console > Actor > Settings > Environment variables.\n' +
            'Caranya: buka x.com di browser -> login -> DevTools > Application > Cookies > https://x.com ' +
            '-> copy semua cookie dalam format "nama=nilai; nama=nilai".',
    );
}

export const parseCookieHeaderString = async (rawCookieString: string): Promise<ParsedCookieSession> => {
    const cookieHeader = rawCookieString.trim();
    if (cookieHeader.startsWith('ENCRYPTED_VALUE:')) {
        throw new Error(
            'Nilai cookieHeader berisi "ENCRYPTED_VALUE:..." — itu BUKAN cookie X, melainkan data terenkripsi ' +
                'dari sistem lain.\n' +
                'Yang dibutuhkan adalah cookie string mentah dari browser, contoh bentuknya:\n' +
                '  auth_token=xxxx; guest_id=xxxx; twid=u%3D123; ct0=xxxx\n' +
                'Cara mengambil: buka x.com -> login -> DevTools (F12) -> Application -> Cookies -> https://x.com ' +
                '-> copy SEMUA baris name=value, gabungkan dengan "; ".',
        );
    }

    if (!cookieHeader.includes('=') || !cookieHeader.includes(';')) {
        throw new Error(
            `Nilai cookieHeader tidak berbentuk cookie string (panjang ${cookieHeader.length} karakter).\n` +
                'Format yang benar: "nama1=nilai1; nama2=nilai2; ..." — minimal ada auth_token dan ct0.',
        );
    }

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
    if (!names.includes('auth_token')) {
        throw new Error(
            `Cookie "auth_token" TIDAK ADA di dalam cookieHeader (hanya ada ${names.length} cookie: ${names.join(', ')}).\n`,
        );
    }

    return {
        cookieHeader,
        ct0,
        playwrightCookies,
    };
};
