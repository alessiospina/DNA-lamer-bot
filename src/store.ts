import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Hunter, Snapshot } from './scraper.js';

const DATA_DIR = fileURLToPath(new URL('../data/', import.meta.url));
const FILE = `${DATA_DIR}snapshot.json`;

export function saveSnapshot(snapshot: Snapshot): void {
    try {
        mkdirSync(DATA_DIR, { recursive: true });
        const tmp = `${FILE}.tmp`;
        writeFileSync(tmp, JSON.stringify(snapshot));
        renameSync(tmp, FILE);
    } catch (err) {
        console.error('Salvataggio dello snapshot fallito', err);
    }
}

export function loadSnapshot(): Snapshot | null {
    try {
        const raw = JSON.parse(readFileSync(FILE, 'utf8')) as Snapshot;
        const revive = (h: Hunter): Hunter => ({
            ...h,
            lastKillAt: new Date(h.lastKillAt),
            recentMobs: h.recentMobs.map(m => ({ name: m.name, at: new Date(m.at) })),
        });
        return {
            ...raw,
            updatedAt: new Date(raw.updatedAt),
            tracked: raw.tracked.map(t => ({ ...t, hunter: t.hunter ? revive(t.hunter) : null })),
        };
    } catch {
        return null;
    }
}
