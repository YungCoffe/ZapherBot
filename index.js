'use strict';

const http = require('http');
const { Client, GatewayIntentBits, Partials, Events, ActivityType } = require('discord.js');
const {
  allSlashCommands,
  handledCommands: ticketHandled,
  handleInteraction,
  handleMessage,
  handleMessageDelete,
  handleMessageDeleteBulk,
  handleGuildMemberAdd,
  handleGuildMemberRemove,
  handleGuildMemberUpdate,
  startScheduler
} = require('./ticket.js');
const {
  economySlashCommands,
  handledCommands: economyHandled,
  handleEconomyInteraction,
  startEconomyScheduler
} = require('./economy.js');
const {
  funSlashCommands,
  handledCommands: funHandled,
  handleFunInteraction,
  handleXp,
  startFunScheduler
} = require('./fun.js');
const {
  aiSlashCommands,
  handledCommands: aiHandled,
  handleAiInteraction,
  handleAiMention
} = require('./ai.js');
const { createPrefixHandler } = require('./hybrid.js');
const { flushAll } = require('./storage.js');
const { PREFIX } = require('./utils.js');

const TOKEN = process.env.DISCORD_TOKEN;
const PORT = process.env.PORT || 10000;

if (!TOKEN) {
  console.error('❌ Variável de ambiente DISCORD_TOKEN não definida. Configure-a no Render (Environment).');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ],
  // Necessário para receber eventos de mensagens/membros que não estão em cache
  partials: [Partials.Message, Partials.Channel, Partials.GuildMember]
});

/* ------------------------------------------------------------
 *  Comandos: cada um funciona como /slash E com prefixo
 * ------------------------------------------------------------ */
const allBuilders = [...allSlashCommands, ...economySlashCommands, ...funSlashCommands, ...aiSlashCommands];

/** Cada módulo ignora o que não é dele e trata os próprios erros. */
async function dispatch(interaction) {
  await handleInteraction(interaction);
  await handleEconomyInteraction(interaction);
  await handleFunInteraction(interaction);
  await handleAiInteraction(interaction);
}

const handlePrefix = createPrefixHandler({ builders: allBuilders, dispatch });

/* ------------------------------------------------------------
 *  Servidor HTTP de uptime (o Render exige uma porta aberta)
 *  Sobe ANTES do login para o deploy ser considerado saudável.
 * ------------------------------------------------------------ */
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    status: 'ok',
    ready: client.isReady(),
    uptime: Math.floor(process.uptime()),
    ping: client.isReady() ? Math.round(client.ws.ping) : null
  }));
}).listen(PORT, '0.0.0.0', () => console.log(`🌐 Servidor de uptime ativo na porta ${PORT}`));

/* ------------------------------------------------------------
 *  Eventos
 * ------------------------------------------------------------ */
client.once(Events.ClientReady, async (c) => {
  console.log(`✅ Bot online como ${c.user.tag}`);
  c.user.setPresence({ activities: [{ name: `/help | ${PREFIX}help`, type: ActivityType.Playing }], status: 'online' });

  try {
    const nomes = allBuilders.map((cmd) => cmd.name);
    const duplicados = nomes.filter((n, i) => nomes.indexOf(n) !== i);
    if (duplicados.length) console.warn('⚠️ Comandos duplicados:', [...new Set(duplicados)].join(', '));
    if (nomes.length > 100) console.warn(`⚠️ ${nomes.length} comandos registrados (o limite do Discord é 100).`);

    const tratados = new Set([...ticketHandled, ...economyHandled, ...funHandled, ...aiHandled]);
    const semHandler = nomes.filter((n) => !tratados.has(n));
    if (semHandler.length) console.warn('⚠️ Comandos registrados sem handler:', semHandler.join(', '));

    await c.application.commands.set(allBuilders.map((cmd) => cmd.toJSON()));
    console.log(`✅ ${nomes.length} comandos registrados (slash + prefixo "${PREFIX}")!`);
  } catch (error) {
    console.error('❌ Erro ao registrar comandos:', error);
  }

  startScheduler(c);
  startEconomyScheduler(c);
  startFunScheduler(c);
});

client.on(Events.MessageCreate, async (message) => {
  try {
    if (await handleMessage(message)) return;     // calado / censura / automod
    if (await handlePrefix(message)) return;      // comandos com prefixo
    if (await handleAiMention(message)) return;   // @Bot pergunta...
    await handleXp(message);                      // XP de nível
  } catch (err) {
    console.error('[messageCreate]', err);
  }
});

client.on(Events.MessageDelete, handleMessageDelete);
client.on(Events.MessageBulkDelete, handleMessageDeleteBulk);
client.on(Events.InteractionCreate, dispatch);

client.on(Events.GuildMemberAdd, handleGuildMemberAdd);
client.on(Events.GuildMemberRemove, handleGuildMemberRemove);
client.on(Events.GuildMemberUpdate, handleGuildMemberUpdate);

/* ------------------------------------------------------------
 *  Diagnóstico de conexão (útil para o aviso de timeout do Gateway)
 * ------------------------------------------------------------ */
client.on(Events.Error, (err) => console.error('[client] erro:', err));
client.on(Events.Warn, (msg) => console.warn('[client] aviso:', msg));
client.on(Events.ShardError, (err, id) => console.error(`[shard ${id}] erro:`, err.message));
client.on(Events.ShardDisconnect, (event, id) => console.warn(`[shard ${id}] desconectado (código ${event.code})`));
client.on(Events.ShardReconnecting, (id) => console.log(`[shard ${id}] reconectando...`));
client.on(Events.ShardResume, (id) => console.log(`[shard ${id}] conexão retomada`));

process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err));
process.on('uncaughtException', (err) => console.error('[uncaughtException]', err));

/* ------------------------------------------------------------
 *  Login com nova tentativa automática
 * ------------------------------------------------------------ */
async function login(tentativa = 1) {
  try {
    await client.login(TOKEN);
  } catch (err) {
    console.error(`❌ Falha no login (tentativa ${tentativa}): ${err.message}`);
    if (err.code === 'TokenInvalid') {
      console.error('Token inválido. Gere um novo no Developer Portal e atualize DISCORD_TOKEN.');
      return;
    }
    if (err.code === 'DisallowedIntents') {
      console.error('Ative "Message Content Intent" e "Server Members Intent" no Developer Portal (aba Bot).');
      return;
    }
    const espera = Math.min(60000, 5000 * tentativa);
    console.log(`🔁 Nova tentativa em ${espera / 1000}s...`);
    setTimeout(() => login(tentativa + 1), espera);
  }
}
login();

/* ------------------------------------------------------------
 *  Desligamento limpo (o Render envia SIGTERM a cada deploy)
 * ------------------------------------------------------------ */
function shutdown(signal) {
  console.log(`\n${signal} recebido, salvando dados e encerrando...`);
  flushAll();
  client.destroy();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
