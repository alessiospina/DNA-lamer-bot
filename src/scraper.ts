const ORIGIN = 'https://dnashard.it';
const BASE = `${ORIGIN}/api/v1`;
const HEADERS = { 'User-Agent': 'DNA-lamer-bot (community tool)', Accept: 'application/json' };
const SESSION_COOKIE = '__Host-dna_area=';
let sessionCookie: string | undefined;
let resumeAt = 0;

/** Space out profile reads and back off when the site returns 429. */
const PACE_MS = 3_000;
const MAX_ATTEMPTS = 6;
const PROFILE_ATTEMPTS = 2;
const PROFILE_TIMEOUT_MS = 5_000;
const MAX_INLINE_COOLDOWN_MS = 5_000;
const DEFAULT_RATE_LIMIT_PAUSE_MS = 30_000;
/** A profile whose PX did not move is reopened anyway after this long, at most STALE_PER_CYCLE per refresh (safety net for kills that give no PX). */
const STALE_MS = 20 * 60_000;
const STALE_PER_CYCLE = 4;
const PROFILE_LAG_RETRY_MS = 5 * 60_000;
const PROFILE_WORK_BUDGET_MS = 90_000;
export const DEFAULT_WINDOW_MINUTES = 15;
export const MAX_WINDOW_MINUTES = 60;

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
    character: { name: string; race: string; class: string; level: number; experience?: string | number };
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

export interface XpActivity {
    serial: number;
    name: string;
    value: number;
    observedAt: number;
    awaitingProfile: boolean;
    retryAt?: number;
}

/** The ranking baseline and, when available, the latest kill within the supported window. */
export interface Tracked {
    serial: number;
    /** PX shown by the ranking when the profile was read: a different value means the player did something. */
    xp: number;
    rankingXp?: number;
    fetchedAt: number;
    /** Last profile attempt, including failures. Older snapshots fall back to fetchedAt. */
    attemptedAt?: number;
    hunter: Hunter | null;
    xpActivity?: XpActivity;
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
    lagging: number;
    deferred: number;
    recentKills: number;
    olderKills: number;
    noKill: number;
    latestKillAt: Date | null;
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
interface RefreshOptions {
    resetBaseline?: boolean;
    onProgress?: (done: number, total: number) => void;
    onRanking?: (snapshot: Snapshot) => void;
    isAwake?: () => boolean;
}

export async function refresh(prev: Snapshot | null, options: RefreshOptions = {}): Promise<RefreshResult> {
    const profileDeadline = Date.now() + PROFILE_WORK_BUDGET_MS;
    const canReadProfile = () => Date.now() < profileDeadline && (options.isAwake?.() ?? true) && !isDnaCoolingDown();
    const rankings = await getJson<{ boards: { id: string; entries: RankingEntry[] }[] }>(
        '/rankings', { attempts: 2, timeoutMs: 5_000 },
    );
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

    const pending: typeof entries = [];
    const changed: typeof entries = [];
    const stale: typeof entries = [];
    for (const e of entries) {
        const p = known.get(e.serial) ?? { serial: e.serial, xp: -1, fetchedAt: 0, hunter: null };
        const previousXp = p.rankingXp;
        let activity = options.resetBaseline ? undefined : p.xpActivity;
        if (!options.resetBaseline && e.xp >= 0 && previousXp !== undefined && previousXp !== e.xp) {
            activity = {
                serial: e.serial, name: e.name, value: e.xp, observedAt: now,
                awaitingProfile: true, retryAt: activity?.retryAt,
            };
        }
        const withinWindow = activity !== undefined && now - activity.observedAt <= MAX_WINDOW_MINUTES * 60_000;
        if (activity && !withinWindow && !activity.awaitingProfile) activity = undefined;
        const rankingXp = e.xp >= 0 ? e.xp : options.resetBaseline ? undefined : previousXp;
        known.set(e.serial, { ...p, rankingXp, xpActivity: activity });
        if (activity?.awaitingProfile && e.xp >= 0) {
            if (now >= (activity.retryAt ?? 0)) {
                const queue = withinWindow ? pending : stale;
                queue.push(e);
            }
        } else if (p.xp !== e.xp) changed.push(e);
        else if (now - p.fetchedAt > STALE_MS) stale.push(e);
    }
    options.onRanking?.({ updatedAt: new Date(now), tracked: entries.map(e => known.get(e.serial)!), fetched: 0 });
    const lastAttempt = (serial: number) => {
        const player = known.get(serial)!;
        return player.attemptedAt ?? player.fetchedAt;
    };
    pending.sort((a, b) => lastAttempt(a.serial) - lastAttempt(b.serial));
    changed.sort((a, b) => lastAttempt(a.serial) - lastAttempt(b.serial));
    stale.sort((a, b) => lastAttempt(a.serial) - lastAttempt(b.serial));
    const toFetch = options.resetBaseline ? [] : [...pending, ...changed, ...stale.slice(0, STALE_PER_CYCLE)];

    let done = 0;
    let read = 0;
    let unavailable = 0;
    let failed = 0;
    let lagging = 0;
    const readKillTimes: number[] = [];
    let renewedSession = false;
    const readProfile = (serial: number, cookie: string) => getJson<ProfileResponse>(
        `/profile/${serial}`, { attempts: PROFILE_ATTEMPTS, timeoutMs: PROFILE_TIMEOUT_MS, cookie },
    );
    for (const e of toFetch) {
        if (!canReadProfile()) break;
        sessionCookie ??= await login();
        if (!sessionCookie || !canReadProfile()) break;
        let res = await readProfile(e.serial, sessionCookie);
        if (!res.ok && res.reason === 'session' && !renewedSession) {
            renewedSession = true;
            sessionCookie = undefined;
            await sleep(PACE_MS);
            if (!canReadProfile()) break;
            sessionCookie = await login();
            if (!sessionCookie || !canReadProfile()) break;
            res = await readProfile(e.serial, sessionCookie);
        }
        if (!res.ok && res.reason === 'session') {
            sessionCookie = undefined;
            throw new Error('Sessione DNA Shard rifiutata dopo il rinnovo');
        }
        const attemptedAt = Date.now();
        const previous = known.get(e.serial)!;
        if (res.ok) {
            const rawXp = res.data.character?.experience;
            const profileXp = typeof rawXp === 'number' || (typeof rawXp === 'string' && /^\d+$/.test(rawXp))
                ? Number(rawXp) : NaN;
            const hunter = buildHunter(e.serial, res.data);
            if (hunter) readKillTimes.push(hunter.lastKillAt.getTime());
            const activity = previous.xpActivity;
            if (activity?.awaitingProfile && profileXp !== activity.value) {
                lagging++;
                const lastKnownKill = previous.hunter?.lastKillAt.getTime() ?? -Infinity;
                known.set(e.serial, {
                    ...previous,
                    attemptedAt,
                    hunter: hunter && hunter.lastKillAt.getTime() > lastKnownKill ? hunter : previous.hunter,
                    xpActivity: { ...activity, awaitingProfile: true, retryAt: attemptedAt + PROFILE_LAG_RETRY_MS },
                });
            } else {
                known.set(e.serial, {
                    serial: e.serial, rankingXp: previous.rankingXp, xp: e.xp, fetchedAt: attemptedAt, hunter,
                    xpActivity: activity && { ...activity, awaitingProfile: false, retryAt: undefined },
                });
            }
            read++;
        } else if (res.reason === 'gone') {
            unavailable++;
            const activity = previous.xpActivity;
            known.set(e.serial, {
                serial: e.serial, rankingXp: previous.rankingXp, xp: e.xp, fetchedAt: attemptedAt, hunter: null,
                xpActivity: activity?.awaitingProfile ? { ...activity, retryAt: attemptedAt + STALE_MS } : activity,
            });
        } else {
            // Keep the PX baseline and last valid data so a failed read can be retried.
            known.set(e.serial, { ...previous, attemptedAt });
            if (res.reason === 'exhausted') {
                console.warn(`Profilo non recuperato dopo ${PROFILE_ATTEMPTS} tentativi: ${JSON.stringify(e.name)} (seriale ${e.serial})`);
            } else if (res.reason === 'rateLimited') {
                console.warn(`Profilo rimandato per limite richieste: ${JSON.stringify(e.name)} (seriale ${e.serial})`);
            }
            if (res.reason !== 'rateLimited') failed++;
        }
        done++;
        options.onProgress?.(done, toFetch.length);
        if (!res.ok && res.reason === 'rateLimited') break;
        if (done < toFetch.length) await sleep(PACE_MS);
    }

    // Name, race, class and level always come from the ranking, so they are current even when the profile was not reopened.
    const finishedAt = Date.now();
    const cutoff = finishedAt - MAX_WINDOW_MINUTES * 60_000;
    const recentCutoff = finishedAt - DEFAULT_WINDOW_MINUTES * 60_000;
    const recentKills = readKillTimes.filter(at => at >= recentCutoff).length;
    const latestKillTime = readKillTimes.reduce((latest, at) => Math.max(latest, at), -Infinity);
    const tracked = entries.map(e => {
        const t = known.get(e.serial)!;
        if (!t.hunter) return t;
        if (t.hunter.lastKillAt.getTime() < cutoff) return { ...t, hunter: null };
        const level = Number.isFinite(e.level) ? e.level : t.hunter.level;
        return { ...t, hunter: { ...t.hunter, name: e.name, race: e.race, className: e.className, level } };
    });
    return {
        snapshot: { updatedAt: new Date(now), tracked, fetched: done },
        read,
        unavailable,
        failed,
        lagging,
        deferred: toFetch.length - read - unavailable - failed,
        recentKills,
        olderKills: readKillTimes.length - recentKills,
        noKill: read - readKillTimes.length,
        latestKillAt: Number.isFinite(latestKillTime) ? new Date(latestKillTime) : null,
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
