import { ChatInputCommandInteraction, Client, EmbedBuilder, GatewayIntentBits, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { randomPhrase } from './phrases.js';
import { type Hunter, type Snapshot, fetchStatus, getHunters, refresh } from './scraper.js';
import { loadSnapshot, saveSnapshot } from './store.js';

try {
    process.loadEnvFile();
} catch {
    // no .env file: the variables may come from the environment
}

const token = process.env.DISCORD_TOKEN;
if (!token) {
    console.error('DISCORD_TOKEN mancante: copia .env.example in .env e inseriscilo.');
    process.exit(1);
}

const DEFAULT_WINDOW_MIN = 60;
const REFRESH_INTERVAL_MS = 2 * 60_000;
const EMBED_LIMIT = 3800;

const command = new SlashCommandBuilder()
    .setName('trovasgub')
    .setDescription("Mostra i player che stanno cacciando adesso, con l'ultimo mob ucciso")
    .addIntegerOption(o =>
        o.setName('minuti').setDescription(`Finestra di attività in minuti (default ${DEFAULT_WINDOW_MIN})`).setMinValue(1).setMaxValue(1440),
    );

const playerCommand = new SlashCommandBuilder().setName('player').setDescription('Quanti player ci sono online adesso, con un invito alla violenza');

const infoCommand = new SlashCommandBuilder().setName('info').setDescription('Cosa faccio, come si usa e perché dovresti usarmi');

const INFO_DESCRIPTION = [
    'Sono il bot che tiene d\'occhio i farmatori di Alseran, perché qualcuno deve pur farlo e a te piace PKappare.',
    'Ogni 2 minuti guardo la classifica: quando i PX di un nerd si muovono, gli apro il profilo e annoto l\'ultimo mob che ha massacrato e a che ora.',
    'Zero fatica per te, zero dignità per loro.',
].join('\n');

const INFO_FIELDS = [
    {
        name: '/trovasgub  ·  [minuti]',
        value: [
            'La lista dei farmatori attivi, dal più fresco al più sudato, con l\'ultimo mob ucciso e quanto tempo fa.',
            `Di default guardo l'ultima ora. Con \`minuti:15\` restringo il campo a chi è ancora caldo: prede perfette. Massimo 1440, perché un giorno intero di farm è già un sintomo.`,
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

async function runRefresh(): Promise<void> {
    if (refreshing) return;
    refreshing = true;
    try {
        const result = await refresh(snapshot, (done, total) => {
            progress = { done, total };
        });
        snapshot = result;
        saveSnapshot(result);
        const noData = result.tracked.filter(t => !t.hunter).length;
        console.log(`Aggiornamento: ${result.fetched} profili riaperti, ${result.tracked.length} seguiti, ${noData} senza dati`);
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
    const minutes = interaction.options.getInteger('minuti') ?? DEFAULT_WINDOW_MIN;
    if (!snapshot) {
        const where = progress ? ` (${progress.done}/${progress.total} profili letti)` : '';
        await interaction.reply({
            content: `Sto ancora facendo la prima scansione${where}. La prima volta richiede fino a circa 8 minuti, poi i dati restano in memoria e le risposte sono immediate.`,
            flags: MessageFlags.Ephemeral,
        });
        return;
    }
    const result = snapshot;
    const threshold = Date.now() - minutes * 60_000;
    const active = getHunters(result).filter(h => h.lastKillAt.getTime() >= threshold);
    const noData = result.tracked.filter(t => !t.hunter).length;
    const footer = `Aggiornato alle ${result.updatedAt.toLocaleTimeString('it-IT', { timeZone: 'Europe/Rome' })} · ${result.tracked.length} player seguiti, ${noData} senza dati`;

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
        .setFooter({ text: 'Dati: dnashard.it, aggiornati ogni 2 minuti · il tuo karma è affar tuo' });
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
void runRefresh();
setInterval(() => void runRefresh(), REFRESH_INTERVAL_MS);
