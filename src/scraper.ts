const ORIGIN = 'https://dnashard.it';
const BASE = `${ORIGIN}/api/v1`;
const HEADERS = { 'User-Agent': 'DNA-lamer-bot (community tool)', Accept: 'application/json' };
const SESSION_COOKIE = '__Host-dna_area=';
let sessionCookie: string | undefined;
let resumeAt = 0;

/** The site answers 429 above roughly one request per second: pace the calls and back off on 429. */
const PACE_MS = 1_500;
const MAX_ATTEMPTS = 6;
const PROFILE_ATTEMPTS = 2;
const PROFILE_TIMEOUT_MS = 5_000;
const MAX_INLINE_COOLDOWN_MS = 5_000;
const DEFAULT_RATE_LIMIT_PAUSE_MS = 30_000;
/** A profile whose PX did not move is reopened anyway after this long, at most STALE_PER_CYCLE per refresh (safety net for kills that give no PX). */
const STALE_MS = 20 * 60_000;
const STALE_PER_CYCLE = 4;
export const MAX_WINDOW_MINUTES = 15;

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
}

/** The ranking baseline and, when available, the latest kill within the supported window. */
export interface Tracked {
    serial: number;
    /** PX shown by the ranking when the profile was read: a different value means the player did something. */
    xp: number;
    fetchedAt: number;
    /** Last profile attempt, including failures. Older snapshots fall back to fetchedAt. */
    attemptedAt?: number;
    hunter: Hunter | null;
}

export interface Snapshot {
    updatedAt: Date;
    tracked: Tracked[];
    /** Profiles opened by the refresh that produced this snapshot. */
    fetched: number;
}

interface RefreshResult {
    snapshot: Snapshot;
    read: number;
    unavailable: number;
    failed: number;
    deferred: number;
}

type Fetched<T> = { ok: true; data: T } | { ok: false; reason: 'gone' | 'session' | 'transient' | 'exhausted' | 'rateLimited' };

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export function getDnaCooldownUntil(): number {
    return resumeAt;
}

function isDnaCoolingDown(): boolean {
    return Date.now() < resumeAt;
}

function applyRateLimit(res: Response, path: string): boolean {
    if (res.status !== 429) return false;
    const now = Date.now();
    const retryAfter = res.headers.get('Retry-After');
    const delay = retryAfter && /^\d+$/.test(retryAfter)
        ? Number(retryAfter) * 1000
        : Date.parse(retryAfter ?? '') - now;
    const pause = Number.isFinite(delay) ? Math.max(PACE_MS, delay) : DEFAULT_RATE_LIMIT_PAUSE_MS;
    resumeAt = Math.max(resumeAt, now + pause);
    void res.body?.cancel().catch(() => {});
    const header = retryAfter === null ? 'assente' : JSON.stringify(retryAfter);
    console.warn(`DNA Shard ha risposto 429 su ${path} (Retry-After: ${header}), richieste sospese per almeno ${Math.ceil((resumeAt - now) / 1000)}s`);
    return true;
}

async function login(): Promise<string | undefined> {
    if (isDnaCoolingDown()) return;
    const username = process.env.DNA_USERNAME;
    const password = process.env.DNA_PASSWORD;
    if (!username || !password) throw new Error('Configura DNA_USERNAME e DNA_PASSWORD per leggere i profili DNA Shard');

    const res = await fetch(`${BASE}/area/login`, {
        method: 'POST',
        redirect: 'error',
        headers: { ...HEADERS, 'Content-Type': 'application/json', 'X-DNA-Portal': '1', Origin: ORIGIN },
        body: JSON.stringify({ username, password }),
        signal: AbortSignal.timeout(25_000),
    });
    if (applyRateLimit(res, '/area/login')) return;
    const result = await res.json().catch(() => null) as { ok?: boolean } | null;
    const cookie = res.headers.getSetCookie()
        .map(header => header.split(';', 1)[0] ?? '')
        .find(value => value.startsWith(SESSION_COOKIE) && value.length > SESSION_COOKIE.length);
    if (!res.ok || result?.ok !== true || !cookie) throw new Error(`Accesso a DNA Shard fallito (HTTP ${res.status})`);
    return cookie;
}

interface JsonOptions {
    attempts?: number;
    baseDelayMs?: number;
    timeoutMs?: number;
    cookie?: string;
}

async function getJson<T>(path: string, options: JsonOptions = {}): Promise<Fetched<T>> {
    const { attempts = MAX_ATTEMPTS, baseDelayMs = 1500, timeoutMs = 15_000, cookie } = options;
    for (let attempt = 0; attempt < attempts; attempt++) {
        if (isDnaCoolingDown()) return { ok: false, reason: 'rateLimited' };
        try {
            const res = await fetch(`${BASE}${path}`, {
                headers: cookie ? { ...HEADERS, 'X-DNA-Portal': '1', Cookie: cookie } : HEADERS,
                redirect: cookie ? 'error' : 'follow',
                signal: AbortSignal.timeout(timeoutMs),
            });
            if (applyRateLimit(res, path)) {
                const wait = Math.max(0, resumeAt - Date.now());
                if (!cookie || attempt === attempts - 1 || wait > MAX_INLINE_COOLDOWN_MS) {
                    return { ok: false, reason: 'rateLimited' };
                }
                await sleep(wait);
                continue;
            }
            if (res.status === 401) return { ok: false, reason: cookie ? 'session' : 'gone' };
            if (res.status === 403) {
                if (!cookie) return { ok: false, reason: 'gone' };
                const body = await res.json().catch(() => null) as { error?: string } | null;
                if (body?.error === 'session') return { ok: false, reason: 'session' };
                return { ok: false, reason: 'transient' };
            }
            if (res.status === 404) return { ok: false, reason: 'gone' };
            if (res.ok) return { ok: true, data: (await res.json()) as T };
        } catch {
            // network error or timeout: retry below
        }
        if (attempt < attempts - 1) await sleep(baseDelayMs * 2 ** attempt);
    }
    return { ok: false, reason: 'exhausted' };
}

/** "Drow · Balestriere · 747.814 PX" -> 747814 (-2 when the format is not the expected one: it then always counts as changed). */
function parsePx(detail: string): number {
    const digits = (detail.split('·').pop() ?? '').replace(/[^0-9]/g, '');
    return digits ? Number(digits) : -2;
}

function buildHunter(serial: number, profile: ProfileResponse): Hunter | null {
    if (!Array.isArray(profile.kinds)) return null;
    let last: { name: string; at: number } | undefined;
    for (const kind of profile.kinds) {
        const at = Date.parse(kind.lastAt);
        if (Number.isFinite(at) && (!last || at > last.at)) last = { name: kind.name, at };
    }
    if (!last) return null;
    return {
        serial,
        name: profile.character.name,
        race: profile.character.race,
        className: profile.character.class,
        level: profile.character.level,
        lastKillAt: new Date(last.at),
        lastMob: last.name,
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
export async function refresh(prev: Snapshot | null, onProgress?: (done: number, total: number) => void): Promise<RefreshResult> {
    const updatedAt = new Date();
    const rankings = await getJson<{ boards: { id: string; entries: RankingEntry[] }[] }>('/rankings');
    const board = rankings.ok ? rankings.data.boards.find(b => b.id === 'livello') : undefined;
    if (!board) {
        if (!rankings.ok && rankings.reason === 'rateLimited') throw new Error('Classifica Progressione rimandata per limite richieste');
        throw new Error('Classifica Progressione non disponibile');
    }

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
        if (!p) known.set(e.serial, { serial: e.serial, xp: -1, fetchedAt: 0, hunter: null });
        if (!p || p.xp !== e.xp) changed.push(e);
        else if (now - p.fetchedAt > STALE_MS) stale.push(e);
    }
    const lastAttempt = (serial: number) => {
        const player = known.get(serial)!;
        return player.attemptedAt ?? player.fetchedAt;
    };
    changed.sort((a, b) => lastAttempt(a.serial) - lastAttempt(b.serial));
    stale.sort((a, b) => lastAttempt(a.serial) - lastAttempt(b.serial));
    const toFetch = [...changed, ...stale.slice(0, STALE_PER_CYCLE)];

    let done = 0;
    let read = 0;
    let unavailable = 0;
    let failed = 0;
    let renewedSession = false;
    const readProfile = (serial: number, cookie: string) => getJson<ProfileResponse>(
        `/profile/${serial}`, { attempts: PROFILE_ATTEMPTS, timeoutMs: PROFILE_TIMEOUT_MS, cookie },
    );
    for (const e of toFetch) {
        if (isDnaCoolingDown()) break;
        sessionCookie ??= await login();
        if (!sessionCookie) break;
        let res = await readProfile(e.serial, sessionCookie);
        if (!res.ok && res.reason === 'session' && !renewedSession) {
            renewedSession = true;
            sessionCookie = undefined;
            await sleep(PACE_MS);
            sessionCookie = await login();
            if (!sessionCookie) break;
            res = await readProfile(e.serial, sessionCookie);
        }
        if (!res.ok && res.reason === 'session') {
            sessionCookie = undefined;
            throw new Error('Sessione DNA Shard rifiutata dopo il rinnovo');
        }
        const attemptedAt = Date.now();
        if (res.ok || res.reason === 'gone') {
            const hunter = res.ok ? buildHunter(e.serial, res.data) : null;
            if (res.ok) read++;
            else unavailable++;
            known.set(e.serial, { serial: e.serial, xp: e.xp, fetchedAt: attemptedAt, hunter });
        } else {
            // Keep the PX baseline and last valid data so a failed read can be retried.
            known.set(e.serial, { ...known.get(e.serial)!, attemptedAt });
            if (res.reason === 'exhausted') {
                console.warn(`Profilo non recuperato dopo ${PROFILE_ATTEMPTS} tentativi: ${JSON.stringify(e.name)} (seriale ${e.serial})`);
            } else if (res.reason === 'rateLimited') {
                console.warn(`Profilo rimandato per limite richieste: ${JSON.stringify(e.name)} (seriale ${e.serial})`);
            }
            if (res.reason !== 'rateLimited') failed++;
        }
        done++;
        onProgress?.(done, toFetch.length);
        if (!res.ok && res.reason === 'rateLimited') break;
        if (done < toFetch.length) await sleep(PACE_MS);
    }

    // Name, race, class and level always come from the ranking, so they are current even when the profile was not reopened.
    const cutoff = Date.now() - MAX_WINDOW_MINUTES * 60_000;
    const tracked = entries.map(e => {
        const t = known.get(e.serial)!;
        if (!t.hunter) return t;
        if (t.hunter.lastKillAt.getTime() < cutoff) return { ...t, hunter: null };
        const level = Number.isFinite(e.level) ? e.level : t.hunter.level;
        return { ...t, hunter: { ...t.hunter, name: e.name, race: e.race, className: e.className, level } };
    });
    return {
        snapshot: { updatedAt, tracked, fetched: done },
        read,
        unavailable,
        failed,
        deferred: toFetch.length - read - unavailable - failed,
    };
}

export interface ServerStatus {
    online: boolean;
    players: number;
    peak24h: number | null;
    reportedAt: Date | null;
}

/** Reads the number of players from the homepage's status API. Few fast attempts: it is called while a user waits. */
export async function fetchStatus(): Promise<ServerStatus | null> {
    const res = await getJson<{ status?: string; players?: number; playersPeak24h?: number | null; reportedAt?: number }>(
        '/status', { attempts: 4, baseDelayMs: 700 },
    );
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
