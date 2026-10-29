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
  handleMessageUpdate,
  handleGuildBanAdd,
  handleGuildBanRemove,
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
  startFunScheduler
} = require('./fun.js');
const {
  levelsSlashCommands,
  handledCommands: levelsHandled,
  handleLevelsInteraction,
  handleXp
} = require('./levels.js');
const {
  rolesSlashCommands,
  handledCommands: rolesHandled,
  handleRolesInteraction
} = require('./roles.js');
const {
  expressionsSlashCommands,
  handledCommands: expressionsHandled,
  handleExpressionsInteraction
} = require('./expressions.js');
const {
  helpSlashCommands,
  handledCommands: helpHandled,
  handleHelpInteraction,
  setHelpSources
} = require('./help.js');
const {
  backupSlashCommands,
  prefixOnlyNames: backupPrefixOnly,
  handledCommands: backupHandled,
  handleBackupInteraction,
  autoRestoreOnStart,
  startBackupScheduler,
  pushBackup
} = require('./backup.js');
const {
  changelogSlashCommands,
  handledCommands: changelogHandled,
  handleChangelogInteraction
} = require('./changelog.js');
const {
  empresasSlashCommands,
  handledCommands: empresasHandled,
  handleEmpresasInteraction
} = require('./empresas.js');
const {
  aiSlashCommands,
  handledCommands: aiHandled,
  handleAiInteraction,
  handleAiMention
} = require('./ai.js');
const { createPrefixHandler } = require('./hybrid.js');
const { flushAll } = require('./storage.js');
const { PREFIX } = require('./utils.js');
const { denyIfNotAllowed, inviteUrl, setAppOwners } = require('./perms.js');

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
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildModeration // eventos de ban/unban feitos direto no Discord (log)
  ],
  // Necessário para receber eventos de mensagens/membros que não estão em cache
  partials: [Partials.Message, Partials.Channel, Partials.GuildMember]
});

/* ------------------------------------------------------------
 *  Comandos: cada um funciona como /slash E com prefixo
 * ------------------------------------------------------------ */
const allBuilders = [
  ...allSlashCommands, ...economySlashCommands, ...funSlashCommands, ...aiSlashCommands,
  ...levelsSlashCommands, ...rolesSlashCommands, ...expressionsSlashCommands, ...helpSlashCommands,
  ...backupSlashCommands, ...changelogSlashCommands, ...empresasSlashCommands
];

// O Discord só aceita 100 slash commands. Estes funcionam apenas com o prefixo (?backup, ?logs),
// não ocupam vaga e continuam aparecendo na ajuda.
const prefixOnly = new Set([...backupPrefixOnly, 'logs']);
const slashBuilders = allBuilders.filter((b) => !prefixOnly.has(b.name));
setHelpSources(allBuilders, [...prefixOnly]); // a ajuda é montada a partir dos comandos reais

/** Cada módulo ignora o que não é dele e trata os próprios erros. */
async function dispatch(interaction) {
  // Permissão automática: cada comando exige a permissão do Discord correspondente (veja perms.js)
  if (interaction.isChatInputCommand() && await denyIfNotAllowed(interaction)) return;

  await handleInteraction(interaction);
  await handleEconomyInteraction(interaction);
  await handleFunInteraction(interaction);
  await handleAiInteraction(interaction);
  await handleLevelsInteraction(interaction);
  await handleRolesInteraction(interaction);
  await handleExpressionsInteraction(interaction);
  await handleHelpInteraction(interaction);
  await handleBackupInteraction(interaction);
  await handleChangelogInteraction(interaction);
  await handleEmpresasInteraction(interaction);
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

  // Dono do bot (quem criou o aplicativo): usado em comandos exclusivos, sem precisar de CREATOR_ID
  try {
    const app = await c.application.fetch();
    const dono = app.owner;
    const ids = dono?.members ? [...dono.members.values()].map((m) => m.user?.id ?? m.id) : [dono?.id];
    if (dono?.ownerId) ids.push(dono.ownerId);
    setAppOwners(ids);
  } catch (err) {
    console.warn('⚠️ Não consegui descobrir o dono do bot:', err.message);
  }

  // 1º: se o disco foi apagado (atualização no Render), recupera os dados do canal de backup
  await autoRestoreOnStart(c).catch((err) => console.error('[backup] restauração:', err.message));

  try {
    const nomes = slashBuilders.map((cmd) => cmd.name);
    const duplicados = nomes.filter((n, i) => nomes.indexOf(n) !== i);
    if (duplicados.length) console.warn('⚠️ Comandos duplicados:', [...new Set(duplicados)].join(', '));
    if (nomes.length > 100) console.warn(`⚠️ ${nomes.length} slash commands (o limite do Discord é 100): o registro vai falhar.`);

    const tratados = new Set([...ticketHandled, ...economyHandled, ...funHandled, ...aiHandled, ...levelsHandled, ...rolesHandled, ...expressionsHandled, ...helpHandled, ...backupHandled, ...changelogHandled, ...empresasHandled]);
    const semHandler = allBuilders.map((cmd) => cmd.name).filter((n) => !tratados.has(n));
    if (semHandler.length) console.warn('⚠️ Comandos registrados sem handler:', semHandler.join(', '));

    await c.application.commands.set(slashBuilders.map((cmd) => cmd.toJSON()));
    console.log(`✅ ${nomes.length} slash commands + ${prefixOnly.size} só com prefixo ("${PREFIX}") registrados!`);
  } catch (error) {
    console.error('❌ Erro ao registrar comandos:', error);
  }

  startScheduler(c);
  startEconomyScheduler(c);
  startFunScheduler(c);
  startBackupScheduler(c);

  const link = inviteUrl(c);
  if (link) console.log(`🔗 Link para adicionar o bot em qualquer servidor:\n${link}`);
  atualizarPresenca(c);
});

/** "Jogando /help | ?help • N servidores" */
function atualizarPresenca(c) {
  c.user.setPresence({
    activities: [{ name: `/help | ${PREFIX}help • ${c.guilds.cache.size} servidor(es)`, type: ActivityType.Playing }],
    status: 'online'
  });
}

/** Quando o bot entra num servidor novo: manda um "primeiros passos" no canal certo. */
client.on(Events.GuildCreate, async (guild) => {
  atualizarPresenca(client);
  if (Date.now() - (guild.joinedTimestamp || 0) > 60_000) return; // já estava no servidor: não repete a mensagem a cada reinício
  console.log(`➕ Entrei no servidor "${guild.name}" (${guild.memberCount} membros)`);
  try {
    const me = guild.members.me;
    const canal = [guild.systemChannel, ...guild.channels.cache.filter((ch) => ch.isTextBased?.() && !ch.isThread?.()).values()]
      .find((ch) => ch && me && ch.permissionsFor(me)?.has(['ViewChannel', 'SendMessages']));
    if (!canal) return;
    await canal.send({
      embeds: [{
        color: 0x00AE86,
        title: '👋 Obrigado por me adicionar!',
        description: [
          `Use **/help** (ou **${PREFIX}help**) para ver todos os comandos.`,
          '',
          '**Primeiros passos (para a staff):**',
          '• As permissões são automáticas: quem tem *Banir Membros* usa `/ban`, quem tem *Silenciar Membros* usa `/mute`, e assim por diante.',
          '• `/setlogs`, `/setpunicoes` e `/setwelcome` definem os canais de log e boas-vindas.',
          '• `/logs` liga e desliga cada tipo de aviso. `/cargosnivel criar` cria os cargos de nível.',
          '',
          '⚠️ Coloque o **meu cargo acima** dos cargos que eu preciso gerenciar.'
        ].join('\n')
      }]
    });
  } catch (err) {
    console.error('[guildCreate]', err.message);
  }
});

client.on(Events.GuildDelete, (guild) => {
  console.log(`➖ Saí do servidor "${guild?.name ?? 'desconhecido'}"`);
  atualizarPresenca(client);
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
client.on(Events.MessageUpdate, handleMessageUpdate);
client.on(Events.GuildBanAdd, handleGuildBanAdd);
client.on(Events.GuildBanRemove, handleGuildBanRemove);
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
let desligando = false;
async function shutdown(signal) {
  if (desligando) return;
  desligando = true;
  console.log(`\n${signal} recebido, salvando dados e encerrando...`);
  flushAll();
  try {
    await Promise.race([pushBackup(client, { force: true }), new Promise((r) => setTimeout(r, 12000))]); // última cópia no Discord
  } catch (_) { /* ignora */ }
  client.destroy();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

/* ------------------------------------------------------------
 *  Anti-sono do Render: o serviço gratuito "dorme" depois de 15 min sem acessos.
 *  O bot acessa o próprio endereço público (RENDER_EXTERNAL_URL, criada pelo Render) a cada 10 min.
 * ------------------------------------------------------------ */
if (process.env.RENDER_EXTERNAL_URL) {
  setInterval(() => {
    fetch(process.env.RENDER_EXTERNAL_URL, { signal: AbortSignal.timeout(15000) }).catch(() => {});
  }, 10 * 60_000).unref();
  console.log('🔔 Anti-sono ativo (auto-ping a cada 10 min).');
}
