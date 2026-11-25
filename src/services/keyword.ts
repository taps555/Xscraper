export function listKeyword(raw: unknown): string[] {
    const list: unknown[] = Array.isArray(raw) ? raw : typeof raw == 'string' ? raw.split(/[,\n]/) : [];

    const seen = new Set<string>();
    const result: string[] = [];

    for (const item of list) {
        if (typeof item !== 'string') continue;

        const term = item.trim().replace(/\s+/g, ' ');
        if (!term) continue;
        const key = term.toLowerCase();

        if (seen.has(key)) continue;

        seen.add(key);
        result.push(term);
    }
    return result;
}
