import { ChatInputCommandInteraction, Client, EmbedBuilder, GatewayIntentBits, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { randomPhrase } from './phrases.js';
import { type Hunter, type Snapshot, DEFAULT_WINDOW_MINUTES, MAX_WINDOW_MINUTES, fetchStatus, getDnaCooldownUntil, getHunters, refresh } from './scraper.js';
import { loadSnapshot, saveSnapshot } from './store.js';

try {
    // Relative to this file, not to the cwd: IDEs often start the script from the workspace root.
    process.loadEnvFile(new URL('../.env', import.meta.url));
} catch {
    // no .env file: the variables may come from the environment
}

const token = process.env.DISCORD_TOKEN;
// TEMP diagnostics: names and lengths only, never the values.
console.log(
    'DIAG env DISCORD*:',
    Object.keys(process.env)
        .filter(k => k.toUpperCase().includes('DISCORD'))
        .map(k => `${JSON.stringify(k)}=${process.env[k]?.length ?? 0} car.`)
        .join(', ') || 'nessuna',
    '| RAILWAY_ENVIRONMENT_NAME:',
    process.env.RAILWAY_ENVIRONMENT_NAME ?? 'n/d',
    '| RAILWAY_SERVICE_NAME:',
    process.env.RAILWAY_SERVICE_NAME ?? 'n/d',
);
if (!token) {
    console.error('DISCORD_TOKEN mancante: copia .env.example in .env e inseriscilo.');
    process.exit(1);
}

const PEAK_START_HOUR = 10;
const PEAK_END_HOUR = 1;
const SNOOZE_START_HOUR = 3;
const PEAK_REFRESH_MINUTES = 2;
const OFF_PEAK_REFRESH_MINUTES = 10;
const MORNING_IDLE_MINUTES = 15;
const IDLE_MINUTES = 60;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const TIME_ZONE = 'Europe/Rome';
const romeHour = new Intl.DateTimeFormat('it-IT', { timeZone: TIME_ZONE, hour: 'numeric', hourCycle: 'h23' });
const EMBED_LIMIT = 3800;

const command = new SlashCommandBuilder()
    .setName('trovasgub')
    .setDescription("Mostra i player che stanno cacciando adesso, con l'ultimo mob ucciso")
    .addIntegerOption(o =>
        o.setName('minuti').setDescription(`Finestra di attività in minuti (default ${DEFAULT_WINDOW_MINUTES})`).setMinValue(1).setMaxValue(MAX_WINDOW_MINUTES),
    );

const playerCommand = new SlashCommandBuilder().setName('player').setDescription('Quanti player ci sono online adesso, con un invito alla violenza');

const infoCommand = new SlashCommandBuilder().setName('info').setDescription('Cosa faccio, come si usa e perché dovresti usarmi');

const INFO_DESCRIPTION = [
    'Sono il bot che tiene d\'occhio i farmatori di Alseran, perché qualcuno deve pur farlo e a te piace PKappare.',
    'Quando i PX di un nerd si muovono, gli apro il profilo e annoto l\'ultimo mob che ha massacrato e a che ora.',
    'Zero fatica per te, zero dignità per loro.',
].join('\n');

const INFO_FIELDS = [
    {
        name: 'Quando aggiorno i dati · ora italiana',
        value: [
            `${PEAK_START_HOUR}:00–0${PEAK_END_HOUR}:00 · ogni ${PEAK_REFRESH_MINUTES} minuti. Mi addormento dopo ${IDLE_MINUTES} minuti senza \`/trovasgub\`.`,
            `0${PEAK_END_HOUR}:00–0${SNOOZE_START_HOUR}:00 · ogni ${OFF_PEAK_REFRESH_MINUTES} minuti. Mi addormento dopo ${IDLE_MINUTES} minuti senza \`/trovasgub\`.`,
            `0${SNOOZE_START_HOUR}:00–${PEAK_START_HOUR}:00 · parto in pausa. Se mi svegli, aggiorno ogni ${OFF_PEAK_REFRESH_MINUTES} minuti e torno a dormire dopo ${MORNING_IDLE_MINUTES} minuti senza \`/trovasgub\`.`,
            'Se sto dormendo, solo `/trovasgub` mi sveglia. Ti chiedo di riprovare tra qualche minuto, appena ho aggiornato i dati.',
        ].join('\n'),
    },
    {
        name: '/trovasgub  ·  [minuti]',
        value: [
            'La lista dei farmatori attivi, dal più fresco al più sudato, con l\'ultimo mob ucciso e quanto tempo fa.',
            `Di default guardo gli ultimi ${DEFAULT_WINDOW_MINUTES} minuti. Puoi scegliere una finestra da 1 a ${MAX_WINDOW_MINUTES} minuti, per esempio \`/trovasgub minuti:${MAX_WINDOW_MINUTES}\`.`,
        ].join('\n'),
    },
    {
        name: '/player',
        value: 'Quanti sono online adesso, più una frase di incoraggiamento alla violenza scelta tra 200. Il numero è vero, l\'istigazione è puro intrattenimento: zero responsabilità morali.',
    },
    {
        name: '/info',
        value: 'Questo messaggio. Sì, lo hai appena letto, e sì, mi stupisce che tu sia arrivato fin qui.',
    },
];

let snapshot: Snapshot | null = loadSnapshot();
if (snapshot) console.log(`Snapshot caricato da file (${snapshot.updatedAt.toISOString()})`);
let refreshing = false;
let progress: { done: number; total: number } | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
let lastRefreshStartedAt = -Infinity;
let lastTrovasgubAt = Date.now();
let awakeUntil = lastTrovasgubAt + IDLE_MINUTES * MINUTE_MS;
let wasMorning = false;
let wakeRefreshPending = false;

function isSnoozeHour(hour: number): boolean {
    return hour >= SNOOZE_START_HOUR && hour < PEAK_START_HOUR;
}

function updateSnooze(now: number, hour: number): void {
    const morning = isSnoozeHour(hour);
    if (now >= awakeUntil || (morning && !wasMorning)) {
        awakeUntil = 0;
    } else if (!morning && wasMorning) {
        awakeUntil = lastTrovasgubAt + IDLE_MINUTES * MINUTE_MS;
    }
    wasMorning = morning;
}

function scheduleRefresh(): void {
    clearTimeout(refreshTimer);
    if (refreshing) return;

    const now = Date.now();
    const hour = Number(romeHour.format(now));
    updateSnooze(now, hour);
    const interval = hour >= PEAK_START_HOUR || hour < PEAK_END_HOUR
        ? PEAK_REFRESH_MINUTES : OFF_PEAK_REFRESH_MINUTES;
    const dueAt = Math.max(lastRefreshStartedAt + interval * MINUTE_MS, getDnaCooldownUntil());
    if (now < awakeUntil && now >= dueAt) {
        lastRefreshStartedAt = now;
        void runRefresh().finally(scheduleRefresh);
        return;
    }

    // Rome's clock and its DST changes align with UTC hour boundaries.
    const nextHour = (Math.floor(now / HOUR_MS) + 1) * HOUR_MS;
    const nextCheck = now < awakeUntil ? Math.min(nextHour, dueAt, awakeUntil) : nextHour;
    refreshTimer = setTimeout(scheduleRefresh, nextCheck - now);
}

function wakeForTrovasgub(): boolean {
    const now = Date.now();
    const hour = Number(romeHour.format(now));
    updateSnooze(now, hour);
    if (now >= awakeUntil) {
        wakeRefreshPending = true;
        if (!refreshing) lastRefreshStartedAt = -Infinity;
    }
    lastTrovasgubAt = now;
    const idleMinutes = isSnoozeHour(hour) ? MORNING_IDLE_MINUTES : IDLE_MINUTES;
    awakeUntil = now + idleMinutes * MINUTE_MS;
    scheduleRefresh();
    return wakeRefreshPending;
}

async function runRefresh(): Promise<void> {
    refreshing = true;
    const startedAt = performance.now();
    try {
        const result = await refresh(snapshot, (done, total) => {
            progress = { done, total };
        });
        snapshot = result.snapshot;
        saveSnapshot(snapshot);
        if (Date.now() >= getDnaCooldownUntil()) wakeRefreshPending = false;
        const recentCutoff = Date.now() - DEFAULT_WINDOW_MINUTES * MINUTE_MS;
        const recentKills = snapshot.tracked.filter(t => t.hunter && t.hunter.lastKillAt.getTime() >= recentCutoff).length;
        const seconds = ((performance.now() - startedAt) / 1_000).toFixed(1);
        console.log(`Aggiornamento in ${seconds}s: ${result.read} profili letti, ${result.unavailable} privati o assenti, ${result.failed} falliti, ${result.deferred} rimandati. ${snapshot.tracked.length} seguiti, ${recentKills} con kill negli ultimi ${DEFAULT_WINDOW_MINUTES} minuti.`);
        const latestKill = result.latestKillAt?.toLocaleString('it-IT', { timeZone: TIME_ZONE }) ?? 'nessuna';
        console.log(`Kill nei profili letti: ${result.recentKills} entro ${DEFAULT_WINDOW_MINUTES} min, ${result.olderKills} più vecchie, ${result.noKill} senza kill rilevate. Più recente (ora italiana): ${latestKill}.`);
    } catch (err) {
        console.error('Aggiornamento fallito, resta lo snapshot precedente', err);
    } finally {
        refreshing = false;
        progress = null;
    }
}

const unix = (d: Date) => Math.floor(d.getTime() / 1000);

function line(h: Hunter, i: number): string {
    return `**${i + 1}. ${h.name}** · Lv ${h.level} · ${h.race} ${h.className}\n└ ${h.lastMob} · <t:${unix(h.lastKillAt)}:R>`;
}

function pages(lines: string[]): string[] {
    const out: string[] = [];
    let cur = '';
    for (const l of lines) {
        if (cur && cur.length + l.length + 1 > EMBED_LIMIT) {
            out.push(cur);
            cur = '';
        }
        cur += (cur ? '\n' : '') + l;
    }
    if (cur) out.push(cur);
    return out;
}

async function handleTrovasgub(interaction: ChatInputCommandInteraction): Promise<void> {
    const waking = wakeForTrovasgub();
    if (waking || !snapshot) {
        const where = progress ? ` (${progress.done}/${progress.total} profili elaborati)` : '';
        const loading = waking ? 'Stavo ronfando! Mi rimetto a caccia' : 'I primi dati sono ancora in preparazione';
        await interaction.reply({
            content: `${loading}${where}. Riprova tra qualche minuto.`,
            flags: MessageFlags.Ephemeral,
        });
        return;
    }
    const minutes = Math.min(interaction.options.getInteger('minuti') ?? DEFAULT_WINDOW_MINUTES, MAX_WINDOW_MINUTES);
    const result = snapshot;
    const threshold = Date.now() - minutes * 60_000;
    const active = getHunters(result).filter(h => h.lastKillAt.getTime() >= threshold);
    const footer = `Aggiornato alle ${result.updatedAt.toLocaleTimeString('it-IT', { timeZone: TIME_ZONE })} · ${result.tracked.length} player seguiti`;

    if (active.length === 0) {
        await interaction.reply({
            embeds: [
                new EmbedBuilder()
                    .setTitle('Nessuno sta expando')
                    .setDescription(`Nessun kill negli ultimi ${minutes} minuti (dati aggiornati <t:${unix(result.updatedAt)}:R>).`)
                    .setFooter({ text: footer }),
            ],
        });
        return;
    }

    const chunks = pages(active.map(line));
    const embeds = chunks.map((description, i) => {
        const e = new EmbedBuilder().setDescription(description);
        if (i === 0) e.setTitle(`Player che expano · ultimi ${minutes} min (${active.length})`);
        if (i === chunks.length - 1) e.setFooter({ text: footer }).setTimestamp(result.updatedAt);
        return e;
    });
    await interaction.reply({ embeds: [embeds[0]!] });
    for (const e of embeds.slice(1)) await interaction.followUp({ embeds: [e] });
}

async function handlePlayer(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply();
    const status = await fetchStatus();
    const embed = new EmbedBuilder();
    if (!status) {
        embed.setTitle('👥 Player online: boh').setDescription(`Il sito non mi ha dato il numero (colpa sua, non mia).\n\n${randomPhrase(null)}`);
    } else if (!status.online) {
        embed.setTitle('💤 Server offline').setDescription('Nessuno da PKappare: i farmatori sono già tutti morti, o forse dormono. Riprova più tardi.');
    } else {
        embed.setTitle(`👥 ${status.players} player online`).setDescription(randomPhrase(status.players));
        if (status.peak24h !== null) embed.setFooter({ text: `Picco nelle ultime 24 ore: ${status.peak24h}` });
        if (status.reportedAt) embed.setTimestamp(status.reportedAt);
    }
    await interaction.editReply({ embeds: [embed] });
}

async function handleInfo(interaction: ChatInputCommandInteraction): Promise<void> {
    const embed = new EmbedBuilder()
        .setTitle("DNA-lamer-bot · istruzioni per l'uso (per chi sa leggere)")
        .setDescription(INFO_DESCRIPTION)
        .addFields(INFO_FIELDS)
        .setFooter({ text: 'Dati: dnashard.it · il tuo karma è affar tuo' });
    await interaction.reply({ embeds: [embed] });
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('clientReady', async c => {
    console.log(`Bot connesso come ${c.user.tag}`);
    // Global commands: they also work when the app is installed with the applications.commands scope only (no bot member).
    try {
        await c.application.commands.set([command.toJSON(), playerCommand.toJSON(), infoCommand.toJSON()]);
        console.log(`Comandi registrati: /${command.name}, /${playerCommand.name}, /${infoCommand.name}`);
    } catch (err) {
        console.error('Registrazione dei comandi fallita', err);
    }
});

client.on('interactionCreate', interaction => {
    if (!interaction.isChatInputCommand()) return;
    const handlers: Record<string, (i: ChatInputCommandInteraction) => Promise<void>> = {
        [command.name]: handleTrovasgub,
        [playerCommand.name]: handlePlayer,
        [infoCommand.name]: handleInfo,
    };
    handlers[interaction.commandName]?.(interaction).catch(err => console.error(`Comando /${interaction.commandName} fallito`, err));
});

await client.login(token);
scheduleRefresh();
