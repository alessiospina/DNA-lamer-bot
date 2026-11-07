import { ChatInputCommandInteraction, Client, EmbedBuilder, GatewayIntentBits, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { randomPhrase } from './phrases.js';
import { type Snapshot, DEFAULT_WINDOW_MINUTES, MAX_WINDOW_MINUTES, fetchStatus, getDnaCooldownUntil, refresh } from './scraper.js';
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

const REFRESH_MINUTES = 2;
const IDLE_MINUTES = 60;
const MINUTE_MS = 60_000;
const TIME_ZONE = 'Europe/Rome';
const EMBED_LIMIT = 3800;
const formatPxDelta = new Intl.NumberFormat('it-IT', { signDisplay: 'always' });

const command = new SlashCommandBuilder()
    .setName('trovasgub')
    .setDescription('Mostra le kill confermate e i personaggi con variazioni recenti dei PX')
    .addIntegerOption(o =>
        o.setName('minuti').setDescription(`Finestra di attività in minuti (default ${DEFAULT_WINDOW_MINUTES})`).setMinValue(1).setMaxValue(MAX_WINDOW_MINUTES),
    );

const playerCommand = new SlashCommandBuilder().setName('player').setDescription('Quanti player ci sono online adesso, con un invito alla violenza');

const infoCommand = new SlashCommandBuilder().setName('info').setDescription('Cosa faccio, come si usa e perché dovresti usarmi');

const INFO_DESCRIPTION = [
    'Sono il bot che tiene d\'occhio i farmatori di Alseran, perché qualcuno deve pur farlo e a te piace PKappare.',
    'Quando i PX di un nerd si muovono, lo segnalo e cerco l’ultima kill nel suo profilo.',
    'Zero fatica per te, zero dignità per loro.',
].join('\n');

const INFO_FIELDS = [
    {
        name: 'Quando aggiorno i dati',
        value: [
            `Leggo la classifica ogni ${REFRESH_MINUTES} minuti. Mi addormento dopo ${IDLE_MINUTES} minuti senza \`/trovasgub\`.`,
            'Dopo l’avvio o il risveglio, la prima classifica fa da riferimento. Segnalo i cambi di PX dal giro successivo.',
        ].join('\n'),
    },
    {
        name: '/trovasgub  ·  [minuti]',
        value: [
            'Ogni PG ha una riga con mob e orario, oppure con la differenza di PX tra due letture della classifica.',
            'DNA Shard aggiorna i profili una volta all’ora. L’ora indicata per un cambio di PX è quella in cui l’ho rilevato.',
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
let awakeUntil = Date.now() + IDLE_MINUTES * MINUTE_MS;
let baselinePending = true;
let wakeGeneration = 0;
let wakeRefreshPending = false;

function scheduleRefresh(): void {
    clearTimeout(refreshTimer);
    if (refreshing) return;

    const now = Date.now();
    if (now >= awakeUntil) return;
    const dueAt = Math.max(lastRefreshStartedAt + REFRESH_MINUTES * MINUTE_MS, getDnaCooldownUntil());
    if (now >= dueAt) {
        lastRefreshStartedAt = now;
        void runRefresh().finally(scheduleRefresh);
        return;
    }

    refreshTimer = setTimeout(scheduleRefresh, Math.min(dueAt, awakeUntil) - now);
}

function wakeForTrovasgub(): boolean {
    const now = Date.now();
    if (now >= awakeUntil) {
        wakeGeneration++;
        baselinePending = true;
        wakeRefreshPending = true;
        progress = null;
        lastRefreshStartedAt = -Infinity;
    }
    awakeUntil = now + IDLE_MINUTES * MINUTE_MS;
    scheduleRefresh();
    return wakeRefreshPending;
}

async function runRefresh(): Promise<void> {
    refreshing = true;
    const generation = wakeGeneration;
    const startedAt = performance.now();
    try {
        const result = await refresh(snapshot, {
            resetBaseline: baselinePending,
            isAwake: () => generation === wakeGeneration && Date.now() < awakeUntil,
            onProgress: (done, total) => {
                if (generation === wakeGeneration) progress = { done, total };
            },
            onRanking: ranking => {
                if (generation !== wakeGeneration) return;
                snapshot = ranking;
                baselinePending = false;
                wakeRefreshPending = false;
            },
        });
        if (generation !== wakeGeneration) return;
        snapshot = result.snapshot;
        saveSnapshot(snapshot);
        const recentCutoff = Date.now() - DEFAULT_WINDOW_MINUTES * MINUTE_MS;
        const recentKills = snapshot.tracked.filter(t => t.hunter && t.hunter.lastKillAt.getTime() >= recentCutoff).length;
        const seconds = ((performance.now() - startedAt) / 1_000).toFixed(1);
        console.log(`Aggiornamento in ${seconds}s: ${result.read} profili letti (${result.lagging} in ritardo rispetto ai PX), ${result.unavailable} privati o assenti, ${result.failed} falliti, ${result.deferred} rimandati. ${snapshot.tracked.length} seguiti, ${recentKills} con kill negli ultimi ${DEFAULT_WINDOW_MINUTES} minuti.`);
        const latestKill = result.latestKillAt?.toLocaleString('it-IT', { timeZone: TIME_ZONE }) ?? 'nessuna';
        console.log(`Kill nei profili letti: ${result.recentKills} entro ${DEFAULT_WINDOW_MINUTES} min, ${result.olderKills} più vecchie, ${result.noKill} senza kill rilevate. Più recente (ora italiana): ${latestKill}.`);
    } catch (err) {
        console.error('Aggiornamento interrotto, restano i dati già acquisiti', err);
    } finally {
        refreshing = false;
        progress = null;
    }
}

const unix = (d: Date) => Math.floor(d.getTime() / 1000);

async function handleTrovasgub(interaction: ChatInputCommandInteraction): Promise<void> {
    const waking = wakeForTrovasgub();
    const minutes = Math.min(interaction.options.getInteger('minuti') ?? DEFAULT_WINDOW_MINUTES, MAX_WINDOW_MINUTES);
    const threshold = Date.now() - minutes * MINUTE_MS;
    const result = baselinePending ? null : snapshot;
    if (!result) {
        const where = progress ? ` (${progress.done}/${progress.total} profili elaborati)` : '';
        const loading = waking ? 'Stavo ronfando! Mi rimetto a caccia' : 'I primi dati sono ancora in preparazione';
        await interaction.reply({
            content: `${loading}${where}. Riprova tra qualche minuto.`,
            flags: MessageFlags.Ephemeral,
        });
        return;
    }
    const { updatedAt } = result;
    const time = updatedAt.toLocaleTimeString('it-IT', { timeZone: TIME_ZONE });
    const footer = `Classifica letta alle ${time} · ${result.tracked.length} player seguiti`;

    const rows: { name: string; detail: string; at: number }[] = [];
    for (const { hunter, xpActivity } of result.tracked) {
        const change = xpActivity && xpActivity.observedAt >= threshold ? xpActivity : undefined;
        const killAt = hunter?.lastKillAt.getTime() ?? -Infinity;
        if (hunter && killAt >= threshold && (!change?.awaitingProfile || killAt >= change.observedAt)) {
            rows.push({
                name: hunter.name,
                detail: `Lv ${hunter.level} · ${hunter.race} ${hunter.className} · ${hunter.lastMob}`,
                at: killAt,
            });
        } else if (change) {
            const detail = change.delta === undefined ? 'PX cambiati' : `${formatPxDelta.format(change.delta)} PX`;
            rows.push({ name: change.name, detail, at: change.observedAt });
        }
    }
    rows.sort((a, b) => b.at - a.at);

    if (rows.length === 0) {
        await interaction.reply({
            embeds: [
                new EmbedBuilder()
                    .setTitle('Nessuna attività rilevata')
                    .setDescription(`Nessuna kill confermata o variazione di PX rilevata negli ultimi ${minutes} minuti (ultimo controllo <t:${unix(updatedAt)}:R>).`)
                    .setFooter({ text: footer }),
            ],
        });
        return;
    }

    let description = '';
    let shown = 0;
    for (const row of rows) {
        const line = `**${shown + 1}. ${row.name}** · ${row.detail} · <t:${Math.floor(row.at / 1000)}:R>`;
        if (description.length + line.length + 1 > EMBED_LIMIT) break;
        description += (description ? '\n' : '') + line;
        shown++;
    }
    const files = [];
    if (shown < rows.length) {
        description += `\n\nMostro ${shown} di ${rows.length} PG. Elenco completo in allegato.`;
        const fullList = rows.map((row, i) => {
            const at = new Date(row.at).toLocaleTimeString('it-IT', { timeZone: TIME_ZONE });
            return `${i + 1}. ${row.name} · ${row.detail} · ${at}`;
        }).join('\n');
        files.push({ attachment: Buffer.from(fullList), name: 'trovasgub.txt' });
    }
    const embed = new EmbedBuilder()
        .setTitle(`Attività · ultimi ${minutes} min (${rows.length})`)
        .setDescription(description)
        .setFooter({ text: footer })
        .setTimestamp(updatedAt);
    await interaction.reply({ embeds: [embed], files });
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
