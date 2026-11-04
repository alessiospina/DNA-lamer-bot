const BASE = 'https://dnashard.it/api/v1';
const HEADERS = { 'User-Agent': 'DNA-lamer-bot (community tool)', Accept: 'application/json' };

/** The site answers 429 above roughly one request per second: pace the calls and back off on 429. */
const PACE_MS = 900;
const MAX_ATTEMPTS = 6;
/** A profile whose PX did not move is reopened anyway after this long, at most STALE_PER_CYCLE per refresh (safety net for kills that give no PX). */
const STALE_MS = 20 * 60_000;
const STALE_PER_CYCLE = 4;

interface RankingEntry {
    rank: number;
    serial?: number;
    name: string;
    detail: string;
    value: string;
}

interface Kind {
    id: string;
    name: string;
    count: number;
    lastAt: string;
    firstAt: string;
}

interface ProfileResponse {
    character: { name: string; race: string; class: string; level: number };
    kinds: Kind[];
    capturedAt: string | null;
}

export interface Hunter {
    serial: number;
    name: string;
    race: string;
    className: string;
    level: number;
    lastKillAt: Date;
    lastMob: string;
    /** Last distinct mobs killed, most recent first. */
    recentMobs: { name: string; at: Date }[];
}

/** What we know about one player of the ranking. `hunter` is null for private profiles and for players without kills. */
export interface Tracked {
    serial: number;
    /** PX shown by the ranking when the profile was read: a different value means the player did something. */
    xp: number;
    fetchedAt: number;
    hunter: Hunter | null;
}

export interface Snapshot {
    updatedAt: Date;
    tracked: Tracked[];
    /** Profiles opened by the refresh that produced this snapshot. */
    fetched: number;
}

type Fetched<T> = { ok: true; data: T } | { ok: false; gone: boolean };

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** `gone` means 401/403/404 (private or missing profile): definitive. Anything else is transient and worth a retry. */
async function getJson<T>(path: string, attempts = MAX_ATTEMPTS, baseDelayMs = 1500): Promise<Fetched<T>> {
    for (let attempt = 0; attempt < attempts; attempt++) {
        try {
            const res = await fetch(`${BASE}${path}`, { headers: HEADERS, signal: AbortSignal.timeout(15_000) });
            if (res.status === 404 || res.status === 401 || res.status === 403) return { ok: false, gone: true };
            if (res.ok) return { ok: true, data: (await res.json()) as T };
        } catch {
            // network error or timeout: retry below
        }
        if (attempt < attempts - 1) await sleep(baseDelayMs * 2 ** attempt);
    }
    return { ok: false, gone: false };
}

/** "Drow · Balestriere · 747.814 PX" -> 747814 (-2 when the format is not the expected one: it then always counts as changed). */
function parsePx(detail: string): number {
    const digits = (detail.split('·').pop() ?? '').replace(/[^0-9]/g, '');
    return digits ? Number(digits) : -2;
}

function buildHunter(serial: number, profile: ProfileResponse): Hunter | null {
    if (!Array.isArray(profile.kinds)) return null;
    const kinds = profile.kinds
        .map(k => ({ name: k.name, at: new Date(k.lastAt) }))
        .filter(k => Number.isFinite(k.at.getTime()))
        .sort((a, b) => b.at.getTime() - a.at.getTime());
    const last = kinds[0];
    if (!last) return null;
    return {
        serial,
        name: profile.character.name,
        race: profile.character.race,
        className: profile.character.class,
        level: profile.character.level,
        lastKillAt: last.at,
        lastMob: last.name,
        recentMobs: kinds.slice(0, 3),
    };
}

/** Players with a known kill, most recent first. */
export function getHunters(snapshot: Snapshot): Hunter[] {
    return snapshot.tracked
        .map(t => t.hunter)
        .filter((h): h is Hunter => h !== null)
        .sort((a, b) => b.lastKillAt.getTime() - a.lastKillAt.getTime());
}

/**
 * One request reads the "Progressione" ranking, which carries every player's PX. Only the profiles of players whose PX changed (plus a few of
 * the oldest ones) are reopened; the first run, without a previous snapshot, opens all of them.
 */
export async function refresh(prev: Snapshot | null, onProgress?: (done: number, total: number) => void): Promise<Snapshot> {
    const updatedAt = new Date();
    const rankings = await getJson<{ boards: { id: string; entries: RankingEntry[] }[] }>('/rankings');
    const board = rankings.ok ? rankings.data.boards.find(b => b.id === 'livello') : undefined;
    if (!board) throw new Error('Classifica Progressione non disponibile');

    const entries = board.entries.flatMap(e => {
        if (typeof e.serial !== 'number') return [];
        // detail is "Race · Class · 747.814 PX", value is the current level
        const [race = '?', className = '?'] = e.detail.split('·').map(part => part.trim());
        return [{ serial: e.serial, xp: parsePx(e.detail), name: e.name, race, className, level: Number(e.value) }];
    });
    const known = new Map((prev?.tracked ?? []).map(t => [t.serial, t]));
    const now = Date.now();

    const changed: typeof entries = [];
    const stale: typeof entries = [];
    for (const e of entries) {
        const p = known.get(e.serial);
        if (!p || p.xp !== e.xp) changed.push(e);
        else if (now - p.fetchedAt > STALE_MS) stale.push(e);
    }
    stale.sort((a, b) => known.get(a.serial)!.fetchedAt - known.get(b.serial)!.fetchedAt);
    const toFetch = [...changed, ...stale.slice(0, STALE_PER_CYCLE)];

    const fresh = new Map<number, Tracked>();
    let done = 0;
    for (const e of toFetch) {
        const res = await getJson<ProfileResponse>(`/profile/${e.serial}`);
        // A transient failure keeps the previous state (or xp -1 for a new player): the PX mismatch makes the next refresh retry.
        if (res.ok) fresh.set(e.serial, { serial: e.serial, xp: e.xp, fetchedAt: Date.now(), hunter: buildHunter(e.serial, res.data) });
        else if (res.gone) fresh.set(e.serial, { serial: e.serial, xp: e.xp, fetchedAt: Date.now(), hunter: null });
        onProgress?.(++done, toFetch.length);
        await sleep(PACE_MS);
    }

    // Name, race, class and level always come from the ranking, so they are current even when the profile was not reopened.
    const tracked = entries.map(e => {
        const t = fresh.get(e.serial) ?? known.get(e.serial) ?? { serial: e.serial, xp: -1, fetchedAt: 0, hunter: null };
        if (!t.hunter) return t;
        const level = Number.isFinite(e.level) ? e.level : t.hunter.level;
        return { ...t, hunter: { ...t.hunter, name: e.name, race: e.race, className: e.className, level } };
    });
    return { updatedAt, tracked, fetched: toFetch.length };
}

export interface ServerStatus {
    online: boolean;
    players: number;
    peak24h: number | null;
    reportedAt: Date | null;
}

/** Reads the number of players from the homepage's status API. Few fast attempts: it is called while a user waits. */
export async function fetchStatus(): Promise<ServerStatus | null> {
    const res = await getJson<{ status?: string; players?: number; playersPeak24h?: number | null; reportedAt?: number }>('/status', 4, 700);
    if (!res.ok) return null;
    const data = res.data;
    if ((data.status !== 'online' && data.status !== 'offline') || typeof data.players !== 'number') return null;
    return {
        online: data.status === 'online',
        players: data.players,
        peak24h: Number.isSafeInteger(data.playersPeak24h) && (data.playersPeak24h ?? -1) >= 0 ? (data.playersPeak24h as number) : null,
        reportedAt: typeof data.reportedAt === 'number' ? new Date(data.reportedAt) : null,
    };
}
