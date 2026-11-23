import fs from 'fs';
import path from 'path';
import { ParsedCookieSession } from '../interfaces/Input.js';
import { Cookie } from 'playwright';

interface StoredSession {
    cookies: Cookie[];
    capturedAt: string;
}

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
    async getCookies(): Promise<StoredSession | null> {
        const filePath = path.resolve('storage/key_value_stores/cookie-sessions/x-main.json');

        if (!fs.existsSync(filePath)) {
            console.error(' FILE TIDAK DITEMUKAN DI:', filePath);
            return null;
        }

        try {
            const rawText = fs.readFileSync(filePath, 'utf-8');
            const rawData = JSON.parse(rawText);

            const rawCookies = Array.isArray(rawData) ? rawData : rawData.cookies;
            if (!Array.isArray(rawCookies) || rawCookies.length === 0) {
                console.error(' FORMAT SALAH: Array cookies kosong/tidak ada.');
                return null;
            }

            console.log(` Berhasil load ${rawCookies.length} cookies dari ${filePath}`);
            return {
                cookies: normalizeCookies(rawCookies),
                capturedAt: rawData.capturedAt ?? new Date().toISOString(),
            };
        } catch (error) {
            console.error(' GAGAL PARSE JSON COOKIES:', error);
            return null;
        }
    },
};

export const parseCookieHeaderString = async (rawCookieString: string): Promise<ParsedCookieSession> => {
    const cookieHeader = rawCookieString.trim();
    const playwrightCookies: Cookie[] = [];
    let ct0 = '';

    const pairs = cookieHeader.split(';');

    for (const pair of pairs) {
        const trimmed = pair.trim();
        if (!trimmed) continue;

        const eqIndex = trimmed.indexOf('=');
        if (eqIndex === -1) continue;

        const name = trimmed.slice(0, eqIndex).trim();
        const value = trimmed.slice(eqIndex + 1).trim();

        if (name === 'ct0') ct0 = value;

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

    return {
        cookieHeader,
        ct0,
        playwrightCookies,
    };
};
