import { readFileSync } from 'node:fs';

const phrases = JSON.parse(readFileSync(new URL('../data/phrases.json', import.meta.url), 'utf8')) as string[];
if (phrases.length === 0) throw new Error('data/phrases.json è vuoto');

let last = -1;

/** A random phrase, never the same twice in a row. `{n}` is replaced by the number of players. */
export function randomPhrase(players: number | null): string {
    let i = Math.floor(Math.random() * phrases.length);
    if (phrases.length > 1 && i === last) i = (i + 1) % phrases.length;
    last = i;
    return phrases[i]!.replaceAll('{n}', players === null ? 'chissà quanti' : String(players));
}
