'use strict';

const {
  ChannelType, PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder,
  SlashCommandBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, AttachmentBuilder, AuditLogEvent
} = require('discord.js');
const { JsonStore } = require('./storage');
const { isStaff, hasFullAccess, checkAccess } = require('./perms');
const { EPHEMERAL, PREFIX, eph, truncate, normalize, fmtDate, fmtDateTime, unix, respond, describeError } = require('./utils');

const NO_PERM = '❌ Sem permissão.';
const GUILD_ONLY = '❌ Este comando só funciona dentro de um servidor.';
const MENTIONS_NONE = { parse: [] };
const LINK_REGEX = /(https?:\/\/|www\.|discord\.gg\/|discord(?:app)?\.com\/invite\/)\S+/i;

/* ============================================================
 *  ARMAZENAMENTO (cache em memória + gravação atrasada/atômica)
 * ============================================================ */
const configStore = new JsonStore('welcome_config.json', {
  migrate: (raw) => {
    const out = {};
    for (const [guildId, val] of Object.entries(raw || {})) {
      out[guildId] = typeof val === 'string' ? { verifyRole: val } : val;
    }
    return out;
  }
});
const warningsStore = new JsonStore('warnings.json');
const censuraStore = new JsonStore('censura.json');
const stateStore = new JsonStore('moderation_state.json', {
  init: (d) => {
    d.tempBans ??= []; d.giveaways ??= []; d.calados ??= {}; d.permNicks ??= {}; d.ratings ??= {};
  }
});

const ticketStore = new JsonStore('tickets.json', {
  init: (d) => { d.guilds ??= {}; }
});

const state = stateStore.data;
state.tempBans ??= [];
state.giveaways ??= [];
state.calados ??= {};
state.permNicks ??= {};
state.ratings ??= {};

const ticketData = ticketStore.data;
ticketData.guilds ??= {};

const getConfig = () => configStore.data;
const getGuildConfig = (guildId) => configStore.data[guildId] || {};
const ensureGuildConfig = (guildId) => (configStore.data[guildId] ??= {});
const saveConfig = () => configStore.save();

/* ============================================================
 *  ESTADO EM MEMÓRIA
 * ============================================================ */
const closingTickets = new Set();
const creatingTickets = new Set();
const floodMap = new Map(); // `${servidor}:${usuário}` -> horários das últimas mensagens
const botDeleted = new Set(); // mensagens apagadas pelo próprio bot (não vão para o log)

const isCalado = (guildId, userId) => (state.calados[guildId] || []).includes(userId);

/* ============================================================
 *  PERMISSÕES
 * ============================================================ */
/** Administrador do Discord (ou "admin do bot" cadastrado): acesso total. As demais permissões vêm do perms.js. */
const hasAdminPermission = hasFullAccess;

/** Quem executa precisa estar acima do alvo na hierarquia de cargos. */
function canModerate(actor, target) {
  if (!target) return true;
  if (actor.id === target.guild.ownerId) return true;
  if (target.id === target.guild.ownerId) return false;
  return actor.roles.highest.position > target.roles.highest.position;
}

/** Barra o comando se o usuário não tiver a permissão exigida (veja RULES no perms.js). Comando fora de RULES = só admin. */
async function deny(ctx) {
  const erro = checkAccess(ctx.interaction, { strict: true });
  if (!erro) return false;
  await ctx.interaction.reply(eph(erro));
  return true;
}

function checkTarget({ interaction, member, guild }, alvo, alvoMembro, flag) {
  if (alvo.id === interaction.user.id) return '❌ Não podes fazer isso contigo próprio.';
  if (alvo.id === interaction.client.user.id) return '❌ Não podes fazer isso comigo.';
  if (alvo.id === guild.ownerId) return '❌ Não podes fazer isso ao dono do servidor.';
  if (alvoMembro) {
    if (!canModerate(member, alvoMembro)) return '❌ Esse membro tem um cargo igual ou superior ao teu.';
    if (flag && !alvoMembro[flag]) return '❌ Não consigo fazer isso a esse membro (cargo dele acima do meu ou falta de permissão).';
  }
  return null;
}

/* ============================================================
 *  LOGS
 * ============================================================ */
const LOG_KEYS = {
  denuncia: 'denunciasChannel',
  duvida: 'duvidasChannel',
  punicao: 'punicoesChannel',
  sugestao: 'suggestionChannel',
  apagada: 'msgDeleteChannel',
  editada: 'msgDeleteChannel'
};

/** Categorias de log/aviso que a staff pode ligar ou desligar com /logs (padrões pensados para NÃO fazer barulho). */
const LOG_DEFAULTS = { apagadas: true, editadas: false, punicoes: true, tickets: true, entradas: true, saidas: false, nivel: true };
const LOG_NAMES = {
  apagadas: 'Mensagens apagadas',
  editadas: 'Mensagens editadas',
  punicoes: 'Punições (ban, kick, mute, aviso)',
  tickets: 'Transcripts de tickets',
  entradas: 'Boas-vindas (entrada de membros)',
  saidas: 'Saída de membros',
  nivel: 'Avisos de subida de nível'
};
/** Canal de destino de cada categoria de log (ou null se nenhum estiver configurado). */
function destinationOf(guild, key) {
  const c = getGuildConfig(guild.id);
  const map = {
    apagadas: c.msgDeleteChannel || c.logsChannel, editadas: c.msgDeleteChannel || c.logsChannel,
    punicoes: c.punicoesChannel || c.logsChannel, tickets: c.duvidasChannel || c.denunciasChannel || c.logsChannel,
    entradas: c.welcomeChannel, saidas: c.welcomeChannel, nivel: c.levelChannel
  };
  return map[key] || null;
}

const TYPE_TOGGLE = { apagada: 'apagadas', editada: 'editadas', punicao: 'punicoes' };

function logEnabled(guildId, key) {
  const t = getGuildConfig(guildId).logToggles;
  return t && key in t ? !!t[key] : LOG_DEFAULTS[key] !== false;
}

const botActions = new Map(); // "ban:servidor:usuario" -> expira (ações feitas pelos comandos do bot, já logadas)
function markBotAction(tipo, guildId, userId) { botActions.set(`${tipo}:${guildId}:${userId}`, Date.now() + 30000); }
function wasBotAction(tipo, guildId, userId) {
  const k = `${tipo}:${guildId}:${userId}`;
  const exp = botActions.get(k);
  if (exp && exp > Date.now()) { botActions.delete(k); return true; }
  return false;
}

const quietBulk = new Set(); // canais onde um /clear está apagando mensagens (não vai para o log)
function quietChannel(channelId) {
  quietBulk.add(channelId);
  setTimeout(() => quietBulk.delete(channelId), 15000);
}

/** Envia um embed para o canal de log certo. Devolve a mensagem enviada (ou null). */
async function sendLog(guild, type, embed, attachment = null, toggle = TYPE_TOGGLE[type]) {
  try {
    if (toggle && !logEnabled(guild.id, toggle)) return null;
    const cfg = getGuildConfig(guild.id);
    const channelId = (LOG_KEYS[type] && cfg[LOG_KEYS[type]]) || cfg.logsChannel;
    if (!channelId) return null;
    const channel = guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null);
    if (!channel?.isTextBased()) return null;
    const options = { embeds: [embed], allowedMentions: MENTIONS_NONE };
    if (attachment) options.files = [attachment];
    return await channel.send(options);
  } catch (err) {
    console.error('[log]', err);
    return null;
  }
}

function punishEmbed(titulo, cor, alvo, moderador, motivo, extra = []) {
  return new EmbedBuilder()
    .setColor(cor)
    .setTitle(titulo)
    .addFields(
      { name: '👤 Usuário', value: `<@${alvo.id}> (${alvo.tag})`, inline: true },
      { name: '🛡️ Staff', value: moderador?.id ? `<@${moderador.id}>` : 'Não identificado', inline: true },
      ...extra,
      { name: '📄 Motivo', value: truncate(motivo, 1000) }
    )
    .setTimestamp();
}

async function silentDelete(message) {
  botDeleted.add(message.id);
  setTimeout(() => botDeleted.delete(message.id), 30000);
  try {
    await message.delete();
    return true;
  } catch (_) {
    botDeleted.delete(message.id);
    return false;
  }
}

/* ============================================================
 *  DEFINIÇÃO DOS SLASH COMMANDS
 * ============================================================ */
const textChannelTypes = [ChannelType.GuildText, ChannelType.GuildAnnouncement];
const canalOpt = (desc) => (o) => o.setName('canal').setDescription(desc).setRequired(true).addChannelTypes(...textChannelTypes);

const allSlashCommands = [
  new SlashCommandBuilder().setName('ping').setDescription('Latência do bot'),
  new SlashCommandBuilder().setName('say').setDescription('Faz o bot falar').addStringOption(o => o.setName('texto').setDescription('Texto').setRequired(true).setMaxLength(2000)),
  new SlashCommandBuilder().setName('clear').setDescription('Limpa mensagens').addIntegerOption(o => o.setName('qtd').setDescription('Quantidade (1-100)').setRequired(true).setMinValue(1).setMaxValue(100)).addUserOption(o => o.setName('usuario').setDescription('Apagar só as mensagens desta pessoa').setRequired(false)),
  new SlashCommandBuilder().setName('avatar').setDescription('Mostra o avatar').addUserOption(o => o.setName('usuario').setDescription('Alvo').setRequired(false)),
  new SlashCommandBuilder().setName('serverinfo').setDescription('Informações do servidor'),
  new SlashCommandBuilder().setName('userinfo').setDescription('Informações de um usuário').addUserOption(o => o.setName('usuario').setDescription('Alvo').setRequired(false)),

  new SlashCommandBuilder().setName('ban').setDescription('Bane um membro do servidor')
    .addUserOption(o => o.setName('usuario').setDescription('Usuário').setRequired(true))
    .addIntegerOption(o => o.setName('minutos').setDescription('Tempo do ban em minutos (0 para permanente)').setRequired(false).setMinValue(0))
    .addStringOption(o => o.setName('motivo').setDescription('Motivo').setRequired(false)),

  new SlashCommandBuilder().setName('kick').setDescription('Expulsa um membro')
    .addUserOption(o => o.setName('usuario').setDescription('Usuário').setRequired(true))
    .addStringOption(o => o.setName('motivo').setDescription('Motivo').setRequired(false)),

  new SlashCommandBuilder().setName('mute').setDescription('Silencia um membro por tempo determinado')
    .addUserOption(o => o.setName('usuario').setDescription('Usuário').setRequired(true))
    .addIntegerOption(o => o.setName('minutos').setDescription('Tempo do silêncio em minutos (máx. 40320)').setRequired(true).setMinValue(1).setMaxValue(40320))
    .addStringOption(o => o.setName('motivo').setDescription('Motivo do mute').setRequired(false)),

  new SlashCommandBuilder().setName('unmute').setDescription('Remove o silenciamento de um membro').addUserOption(o => o.setName('usuario').setDescription('Usuário').setRequired(true)),
  new SlashCommandBuilder().setName('warn').setDescription('Avisa um membro').addUserOption(o => o.setName('usuario').setDescription('Usuário').setRequired(true)).addStringOption(o => o.setName('motivo').setDescription('Motivo').setRequired(true)),
  new SlashCommandBuilder().setName('warnings').setDescription('Mostra os avisos de um membro').addUserOption(o => o.setName('usuario').setDescription('Usuário').setRequired(true)),
  new SlashCommandBuilder().setName('setcargo').setDescription('Adiciona ou remove um cargo de um membro').addUserOption(o => o.setName('usuario').setDescription('Membro').setRequired(true)).addRoleOption(o => o.setName('cargo').setDescription('Cargo').setRequired(true)),
  new SlashCommandBuilder().setName('lock').setDescription('Tranca o canal atual'),
  new SlashCommandBuilder().setName('unlock').setDescription('Destranca o canal atual'),
  new SlashCommandBuilder().setName('ticket').setDescription('Envia o painel de atendimento/denúncia'),
  new SlashCommandBuilder().setName('setup').setDescription('Configura cargos, canais, logs, tickets e recursos essenciais do servidor')
    .addStringOption(o => o.setName('acao').setDescription('Etapa que deseja executar (vazio = servidor completo)').setRequired(false).addChoices(
      { name: 'Servidor completo', value: 'completo' },
      { name: 'Somente estrutura de tickets', value: 'tickets' },
      { name: 'Somente emojis dos canais', value: 'emojis' }
    )),
  new SlashCommandBuilder().setName('painel-sugestao').setDescription('Envia o painel interativo de sugestões'),
  new SlashCommandBuilder().setName('setwelcome').setDescription('Define o canal de boas-vindas').addChannelOption(canalOpt('Canal de texto')),
  new SlashCommandBuilder().setName('setautorole').setDescription('Define o cargo automático para novos membros').addRoleOption(o => o.setName('cargo').setDescription('Cargo de membro').setRequired(true)),
  new SlashCommandBuilder().setName('delautorole').setDescription('Remove o cargo automático de novos membros'),
  new SlashCommandBuilder().setName('setsuggestion').setDescription('Define o canal de sugestões').addChannelOption(canalOpt('Canal de sugestões')),
  new SlashCommandBuilder().setName('setlogs').setDescription('Define o canal de logs geral').addChannelOption(canalOpt('Canal de logs')),
  new SlashCommandBuilder().setName('setdenuncias').setDescription('Define o canal de logs de denúncias').addChannelOption(canalOpt('Canal')),
  new SlashCommandBuilder().setName('setduvidas').setDescription('Define o canal de logs de dúvidas').addChannelOption(canalOpt('Canal')),
  new SlashCommandBuilder().setName('setpunicoes').setDescription('Define o canal de logs de punições').addChannelOption(canalOpt('Canal')),
  new SlashCommandBuilder().setName('setmsgdelete').setDescription('Define o canal de logs para mensagens apagadas').addChannelOption(canalOpt('Canal')),
  new SlashCommandBuilder().setName('logs').setDescription('Liga/desliga cada tipo de log e aviso do bot (vazio = ver o que está ativo)')
    .addStringOption(o => o.setName('categoria').setDescription('Qual log').setRequired(false).addChoices(...Object.entries(LOG_NAMES).map(([value, name]) => ({ name, value })), { name: '🧪 Testar os canais de log', value: 'testar' }))
    .addBooleanOption(o => o.setName('status').setDescription('Ligado ou desligado (vazio = alterna)').setRequired(false)),
  new SlashCommandBuilder().setName('setnivel').setDescription('Define o canal dos avisos de subida de nível').addChannelOption(canalOpt('Canal')),
  new SlashCommandBuilder().setName('setverify').setDescription('Envia o painel de verificação por botão').addChannelOption(canalOpt('Canal de verificação')).addRoleOption(o => o.setName('cargo').setDescription('Cargo liberado ao verificar').setRequired(true)),
  new SlashCommandBuilder().setName('automod').setDescription('Ativa ou desativa o automod de links').addBooleanOption(o => o.setName('status').setDescription('Ligado/Desligado').setRequired(true)),
  new SlashCommandBuilder().setName('sugerir').setDescription('Envia uma sugestão').addStringOption(o => o.setName('ideia').setDescription('Sua ideia').setRequired(true).setMaxLength(1500)),
  new SlashCommandBuilder().setName('denuncia').setDescription('Envia uma denúncia anônima para a staff').addStringOption(o => o.setName('mensagem').setDescription('Detalhes da denúncia').setRequired(true).setMaxLength(1500)),
  new SlashCommandBuilder().setName('sorteio').setDescription('Cria um sorteio').addStringOption(o => o.setName('premio').setDescription('Prêmio').setRequired(true).setMaxLength(200)).addIntegerOption(o => o.setName('minutos').setDescription('Tempo em minutos').setRequired(true).setMinValue(1).setMaxValue(43200)),
  new SlashCommandBuilder().setName('embed').setDescription('Cria um embed personalizado').addStringOption(o => o.setName('titulo').setDescription('Título').setRequired(true).setMaxLength(256)).addStringOption(o => o.setName('descricao').setDescription('Descrição').setRequired(true).setMaxLength(4000)),
  new SlashCommandBuilder().setName('setadminrole').setDescription('Adiciona um cargo com permissões administrativas do bot').addRoleOption(o => o.setName('cargo').setDescription('Cargo permitida').setRequired(true)),
  new SlashCommandBuilder().setName('setadminuser').setDescription('Adiciona um usuário com permissões administrativas do bot').addUserOption(o => o.setName('usuario').setDescription('Usuário permitido').setRequired(true)),
  new SlashCommandBuilder().setName('nick').setDescription('Altera o apelido de um membro').addUserOption(o => o.setName('usuario').setDescription('Membro').setRequired(true)).addStringOption(o => o.setName('apelido').setDescription('Novo apelido').setRequired(true).setMaxLength(32)),
  new SlashCommandBuilder().setName('permnick').setDescription('Trava o apelido de um membro permanentemente').addUserOption(o => o.setName('usuario').setDescription('Membro').setRequired(true)).addStringOption(o => o.setName('apelido').setDescription('Apelido fixo').setRequired(true).setMaxLength(32)),
  new SlashCommandBuilder().setName('calado').setDescription('Deixa um membro calado (apaga todas as mensagens dele)').addUserOption(o => o.setName('usuario').setDescription('Membro').setRequired(true)),
  new SlashCommandBuilder().setName('censura').setDescription('Gerencia palavras censuradas')
    .addStringOption(o => o.setName('acao').setDescription('Ação').setRequired(true).addChoices(
      { name: 'Adicionar', value: 'add' },
      { name: 'Remover', value: 'remove' },
      { name: 'Listar', value: 'list' }
    ))
    .addStringOption(o => o.setName('palavra').setDescription('Palavra').setRequired(false).setMaxLength(60)),

  // ---- Novos comandos ----
  new SlashCommandBuilder().setName('unban').setDescription('Remove o banimento de um usuário').addStringOption(o => o.setName('usuario').setDescription('ID do usuário banido').setRequired(true)),
  new SlashCommandBuilder().setName('slowmode').setDescription('Define o modo lento do canal atual').addIntegerOption(o => o.setName('segundos').setDescription('Segundos entre mensagens (0 desativa)').setRequired(true).setMinValue(0).setMaxValue(21600)),
  new SlashCommandBuilder().setName('clearwarns').setDescription('Apaga todos os avisos de um membro').addUserOption(o => o.setName('usuario').setDescription('Usuário').setRequired(true)),
  new SlashCommandBuilder().setName('unpermnick').setDescription('Destrava o apelido de um membro').addUserOption(o => o.setName('usuario').setDescription('Membro').setRequired(true)),
  new SlashCommandBuilder().setName('deladminrole').setDescription('Remove um cargo da administração do bot').addRoleOption(o => o.setName('cargo').setDescription('Cargo').setRequired(true)),
  new SlashCommandBuilder().setName('deladminuser').setDescription('Remove um usuário da administração do bot').addUserOption(o => o.setName('usuario').setDescription('Usuário').setRequired(true))
];

/* ============================================================
 *  PAINÉIS
 * ============================================================ */
async function sendTicketPanel(channel) {
  if (!channel?.isTextBased?.() || channel.isThread?.()) throw new Error('O painel precisa ser enviado em um canal de texto.');

  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('🎫 Central de Atendimento')
    .setDescription([
      '**Como funciona?**',
      'Escolha uma das opções abaixo para abrir um canal privado com a nossa equipe.',
      '',
      '❓ **Dúvida:** suporte, perguntas e ajuda em geral.',
      '🚨 **Denúncia:** relatos sigilosos para a staff.',
      '',
      'Evite abrir tickets sem necessidade. Você pode ter apenas **um ticket aberto de cada tipo**.'
    ].join('\n'))
    .setFooter({ text: 'Atendimento privado • Transcript ao encerrar' })
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ticket:create:duvida').setLabel('Abrir dúvida').setEmoji('❓').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('ticket:create:denuncia').setLabel('Fazer denúncia').setEmoji('🚨').setStyle(ButtonStyle.Danger)
  );
  return channel.send({ embeds: [embed], components: [row], allowedMentions: MENTIONS_NONE });
}

async function sendSuggestionPanel(channel) {
  const embed = new EmbedBuilder()
    .setColor(0xF1C40F)
    .setTitle('💡 Central de Sugestões')
    .setDescription('Clique no botão abaixo para abrir a janela (Modal) e enviar sua sugestão diretamente para a equipe!');

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('btn_abrir_sugestao').setLabel('Enviar Sugestão').setStyle(ButtonStyle.Success).setEmoji('💡')
  );
  await channel.send({ embeds: [embed], components: [row] });
}

async function sendVerifyPanel(channel, role) {
  const embed = new EmbedBuilder()
    .setColor(0x2ECC71)
    .setTitle('✅ Verificação')
    .setDescription(`Clique no botão abaixo para te verificares e receberes o cargo <@&${role.id}>.`);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('verify_btn').setLabel('✅ Verificar-me').setStyle(ButtonStyle.Success)
  );
  await channel.send({ embeds: [embed], components: [row], allowedMentions: MENTIONS_NONE });
}

/* ============================================================
 *  MENSAGENS (censura, automod, calado e comandos com prefixo)
 * ============================================================ */
async function processMessage(message) {
  if (message.author.bot || !message.guild) return false;

  const guild = message.guild;
  const guildConfig = getGuildConfig(guild.id);

  if (isCalado(guild.id, message.author.id)) return silentDelete(message);

  const palavras = censuraStore.data[guild.id] || [];
  if (palavras.length === 0 && !guildConfig.automod) return false;

  const member = message.member || await guild.members.fetch(message.author.id).catch(() => null);
  if (isStaff(member, guildConfig)) return false; // moderadores não são filtrados

  // Censura
  if (palavras.length > 0) {
    const texto = normalize(message.content);
    if (palavras.some((p) => texto.includes(normalize(p)))) {
      if (await silentDelete(message)) {
        const aviso = await message.channel.send({ content: `⚠️ <@${message.author.id}>, mensagem apagada por conter censura.`, allowedMentions: { users: [message.author.id] } }).catch(() => null);
        if (aviso) setTimeout(() => aviso.delete().catch(() => {}), 4000);
        return true;
      }
    }
  }

  // Automod: flood e spam de menções
  if (guildConfig.automod) {
    const chave = `${guild.id}:${message.author.id}`;
    const agora = Date.now();
    const recentes = (floodMap.get(chave) || []).filter((t) => agora - t < 6000);
    recentes.push(agora);
    floodMap.set(chave, recentes);
    const mencoes = message.mentions.users.size + message.mentions.roles.size;

    if (recentes.length >= 7 || mencoes >= 6) {
      floodMap.delete(chave);
      await silentDelete(message);
      if (member?.moderatable) await member.timeout(mencoes >= 6 ? 5 * 60000 : 60000, 'Automod: flood/spam de menções').catch(() => {});
      const aviso = await message.channel.send({ content: `🚫 <@${message.author.id}> foi silenciado por ${mencoes >= 6 ? 'spam de menções' : 'flood de mensagens'}.`, allowedMentions: { users: [message.author.id] } }).catch(() => null);
      if (aviso) setTimeout(() => aviso.delete().catch(() => {}), 5000);
      return true;
    }
  }

  // Automod de links
  if (guildConfig.automod && !member?.permissions.has(PermissionFlagsBits.ManageMessages) && LINK_REGEX.test(message.content)) {
    if (await silentDelete(message)) {
      const aviso = await message.channel.send({ content: `🔗 <@${message.author.id}>, links não são permitidos aqui.`, allowedMentions: { users: [message.author.id] } }).catch(() => null);
      if (aviso) setTimeout(() => aviso.delete().catch(() => {}), 4000);
      return true;
    }
  }
  return false;
}

/** Devolve true se a mensagem foi removida (calado, censura ou automod). */
async function handleMessage(message) {
  try {
    return (await processMessage(message)) === true;
  } catch (err) {
    console.error('[mensagem]', err);
    return false;
  }
}

async function handleMessageDelete(message) {
  try {
    if (!message.guild) return;
    if (botDeleted.delete(message.id)) return;
    if (!logEnabled(message.guild.id, 'apagadas')) return;
    if (message.author?.bot) return;
    if (!message.author && !message.content && !message.attachments?.size) return; // sem nenhuma informação útil

    const anexos = message.attachments?.size ? `\n📎 ${[...message.attachments.values()].map((a) => a.name).join(', ')}` : '';
    const embed = new EmbedBuilder()
      .setColor(0xE74C3C)
      .setTitle('🗑️ Mensagem Apagada')
      .addFields(
        { name: '👤 Autor', value: message.author ? `<@${message.author.id}>` : 'Desconhecido', inline: true },
        { name: '📁 Canal', value: `<#${message.channelId}>`, inline: true },
        { name: '💬 Conteúdo', value: truncate((message.content || '[Anexo/Vazio]') + anexos, 1024), inline: false }
      )
      .setTimestamp();
    await sendLog(message.guild, 'apagada', embed);
  } catch (err) {
    console.error('[msgDelete]', err.message);
  }
}

async function handleMessageUpdate(oldMsg, newMsg) {
  try {
    if (!newMsg.guild || newMsg.author?.bot) return;
    if (!logEnabled(newMsg.guild.id, 'editadas')) return;
    if (oldMsg.content === newMsg.content) return; // só mudou embed/fixação
    const embed = new EmbedBuilder()
      .setColor(0x3498DB)
      .setTitle('✏️ Mensagem Editada')
      .addFields(
        { name: '👤 Autor', value: newMsg.author ? `<@${newMsg.author.id}>` : 'Desconhecido', inline: true },
        { name: '📁 Canal', value: `<#${newMsg.channelId}> • [ir para a mensagem](${newMsg.url})`, inline: true },
        { name: 'Antes', value: truncate(oldMsg.content || '*(não estava em cache)*', 1024) },
        { name: 'Depois', value: truncate(newMsg.content || '*(vazio)*', 1024) }
      )
      .setTimestamp();
    await sendLog(newMsg.guild, 'editada', embed);
  } catch (err) {
    console.error('[msgUpdate]', err.message);
  }
}

async function handleMessageDeleteBulk(messages, channel) {
  try {
    if (!channel?.guild) return;
    if (quietBulk.has(channel.id) || !logEnabled(channel.guild.id, 'apagadas')) return;
    const embed = new EmbedBuilder()
      .setColor(0xE67E22)
      .setTitle('🧹 Mensagens Apagadas em Massa')
      .addFields(
        { name: '📁 Canal', value: `<#${channel.id}>`, inline: true },
        { name: '🔢 Quantidade', value: `${messages.size}`, inline: true }
      )
      .setTimestamp();
    await sendLog(channel.guild, 'apagada', embed);
  } catch (err) {
    console.error('[msgDeleteBulk]', err.message);
  }
}

/* ============================================================
 *  TICKETS
 * ============================================================ */
const TICKET_TYPES = {
  duvida: { nome: 'Dúvida', emoji: '❓', cor: 0x3498DB },
  denuncia: { nome: 'Denúncia', emoji: '🚨', cor: 0xE74C3C }
};
const TICKET_BASE_PERMS = [
  PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles,
  PermissionFlagsBits.EmbedLinks
];

function ticketBucket(guildId, create = false) {
  if (create) return (ticketData.guilds[guildId] ??= {});
  return ticketData.guilds[guildId] || {};
}

function getTicketRecord(guildId, channelId) {
  return ticketBucket(guildId)[channelId] || null;
}

function parseTicketTopic(channel) {
  if (!channel) return null;
  const saved = channel.guild ? getTicketRecord(channel.guild.id, channel.id) : null;
  if (saved) return { ...saved, tipo: saved.tipo || saved.type, creatorId: saved.creatorId };

  const m = /^ticket:(duvida|denuncia):(\d{15,22})$/.exec(channel.topic || '');
  if (m) return { tipo: m[1], creatorId: m[2] };

  // Compatibilidade com tickets antigos, inclusive nomes que já tenham emoji.
  const nome = channel.name || '';
  if (/(?:^|・)(duvida|denuncia)(?:-|$)/.test(nome)) {
    return { tipo: nome.includes('denuncia') ? 'denuncia' : 'duvida', creatorId: null };
  }
  return null;
}

function staffRoleIds(guild, cfg = {}) {
  const ehStaff = (r) => !r.managed && r.id !== guild.id
    && ['Administrator', 'ManageMessages', 'ModerateMembers', 'ManageGuild', 'BanMembers', 'KickMembers'].some((p) => r.permissions.has(p));
  return new Set([
    ...guild.roles.cache.filter(ehStaff).keys(),
    ...(cfg.ticketStaffRoles || []).filter((id) => guild.roles.cache.has(id)),
    ...(cfg.adminRoles || []).filter((id) => guild.roles.cache.has(id))
  ]);
}

function ticketControlRows() {
  const ratingRow = new ActionRowBuilder().addComponents(
    ...[1, 2, 3, 4, 5].map((nota) => new ButtonBuilder()
      .setCustomId(`ticket:rate:${nota}`)
      .setLabel(String(nota))
      .setEmoji('⭐')
      .setStyle(ButtonStyle.Secondary))
  );
  const actionRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ticket:claim').setLabel('Assumir atendimento').setEmoji('🙋').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('ticket:close').setLabel('Fechar ticket').setEmoji('🔒').setStyle(ButtonStyle.Danger)
  );
  return [ratingRow, actionRow];
}

const SETUP_ROLES = {
  staff: {
    name: '🛡️・Staff', color: 0x5865F2, hoist: true,
    permissions: [PermissionFlagsBits.ManageMessages, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ModerateMembers]
  },
  moderador: {
    name: '🔨・Moderador', color: 0xE67E22, hoist: true,
    permissions: [PermissionFlagsBits.ManageMessages, PermissionFlagsBits.ModerateMembers, PermissionFlagsBits.BanMembers, PermissionFlagsBits.KickMembers, PermissionFlagsBits.ManageNicknames]
  },
  suporte: {
    name: '🎫・Suporte', color: 0x3498DB, hoist: true,
    permissions: [PermissionFlagsBits.ManageMessages, PermissionFlagsBits.ModerateMembers]
  },
  membro: { name: '✅・Membro', color: 0x2ECC71, hoist: false, permissions: [] },
  bots: { name: '🤖・Bots', color: 0x95A5A6, hoist: false, permissions: [] }
};

function baseChannelName(name) {
  const nome = normalize(name);
  return nome.includes('・') ? nome.slice(nome.indexOf('・') + 1).trim() : nome.trim();
}

async function setupEssentialRoles(guild) {
  const cfg = ensureGuildConfig(guild.id);
  cfg.setupRoles ??= {};
  let criados = 0;

  for (const [key, definition] of Object.entries(SETUP_ROLES)) {
    let role = guild.roles.cache.get(cfg.setupRoles[key]);
    if (!role || role.managed) role = null;
    role ||= guild.roles.cache.find((r) => !r.managed && baseChannelName(r.name) === baseChannelName(definition.name));
    if (!role) {
      role = await guild.roles.create({ ...definition, mentionable: false, reason: 'Setup completo do servidor' });
      criados++;
    }
    cfg.setupRoles[key] = role.id;
  }

  cfg.ticketStaffRoles = [...new Set([
    ...(cfg.ticketStaffRoles || []), cfg.setupRoles.staff, cfg.setupRoles.moderador, cfg.setupRoles.suporte
  ])];
  cfg.autoRole ??= cfg.setupRoles.membro;
  cfg.verifyRole ??= cfg.setupRoles.membro;
  saveConfig();
  return { criados, ids: { ...cfg.setupRoles } };
}

async function ensureSetupChannel(guild, cfg, key, options) {
  cfg.setupChannels ??= {};
  let channel = guild.channels.cache.get(cfg.setupChannels[key]);
  if (channel?.type !== options.type) channel = null;
  channel ||= guild.channels.cache.find((c) => c.type === options.type && baseChannelName(c.name) === baseChannelName(options.name));

  let criado = false;
  if (!channel) {
    channel = await guild.channels.create({ ...options, reason: 'Setup completo do servidor' });
    criado = true;
  } else {
    if (options.parent && channel.parentId !== options.parent) await channel.setParent(options.parent, { lockPermissions: false });
    if (options.permissionOverwrites) {
      await channel.permissionOverwrites.set(options.permissionOverwrites, 'Permissões do setup completo');
    }
  }
  cfg.setupChannels[key] = channel.id;
  return { channel, criado };
}

async function setupEssentialChannels(guild, client) {
  const cfg = ensureGuildConfig(guild.id);
  const botId = client.user.id;
  const botFullAccess = [
    PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.EmbedLinks,
    PermissionFlagsBits.AttachFiles, PermissionFlagsBits.ManageChannels,
    PermissionFlagsBits.ManageMessages
  ];
  const readOnly = [
    {
      id: guild.roles.everyone.id,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
      deny: [PermissionFlagsBits.SendMessages]
    },
    { id: botId, allow: botFullAccess }
  ];
  const staffOnly = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: botId, allow: botFullAccess },
    ...[...staffRoleIds(guild, cfg)].map((id) => ({ id, allow: TICKET_BASE_PERMS })),
    ...(cfg.adminUsers || []).map((id) => ({ id, allow: TICKET_BASE_PERMS }))
  ];

  let criados = 0;
  const ensure = async (key, options) => {
    const result = await ensureSetupChannel(guild, cfg, key, options);
    if (result.criado) criados++;
    return result.channel;
  };
  const category = (key, name, privateStaff = false) => ensure(key, {
    name, type: ChannelType.GuildCategory, ...(privateStaff ? { permissionOverwrites: staffOnly } : {})
  });
  const text = (key, name, parent, readonly = false, privateStaff = false) => ensure(key, {
    name, type: ChannelType.GuildText, parent: parent.id,
    ...(readonly || privateStaff ? { permissionOverwrites: privateStaff ? staffOnly : readOnly } : {})
  });

  const informacoes = await category('categoriaInformacoes', '📁・informações');
  const comunidade = await category('categoriaComunidade', '📁・comunidade');
  const staff = await category('categoriaStaff', '📁・staff', true);
  const voz = await category('categoriaVoz', '📁・canais de voz');

  const regras = await text('regras', '📖・regras', informacoes, true);
  await text('anuncios', '📢・anúncios', informacoes, true);
  const novidades = await text('novidades', '📰・novidades', informacoes, true);
  const welcome = await text('welcome', '👋・boas-vindas', informacoes, true);
  await text('chatGeral', '💬・chat-geral', comunidade);
  const sugestoes = await text('sugestoes', '💡・sugestões', comunidade, true);
  const niveis = await text('niveis', '⭐・níveis', comunidade, true);
  const logs = await text('logs', '📋・logs-gerais', staff, false, true);
  const punicoes = await text('punicoes', '🛡️・logs-punições', staff, false, true);
  const mensagens = await text('mensagens', '🗑️・logs-mensagens', staff, false, true);
  await ensure('vozGeral', { name: '🔊・Conversa geral', type: ChannelType.GuildVoice, parent: voz.id });
  await ensure('vozDois', { name: '🔊・Sala reservada', type: ChannelType.GuildVoice, parent: voz.id });

  cfg.welcomeChannel = welcome.id;
  cfg.suggestionChannel = sugestoes.id;
  cfg.logsChannel = logs.id;
  cfg.punicoesChannel = punicoes.id;
  cfg.msgDeleteChannel = mensagens.id;
  cfg.levelChannel = niveis.id;
  cfg.changelogChannelId = novidades.id;
  cfg.automod ??= true;
  cfg.setupCompletedAt = Date.now();
  saveConfig();

  const hasBotMessage = async (channel, predicate) => {
    const messages = await channel.messages.fetch({ limit: 20 }).catch(() => null);
    return !!messages?.some((m) => m.author.id === botId && predicate(m));
  };
  if (!await hasBotMessage(regras, (m) => m.embeds.some((e) => e.title?.includes('Regras do Servidor')))) {
    await regras.send({ embeds: [new EmbedBuilder().setColor(0x3498DB).setTitle('📖 Regras do Servidor').setDescription([
      '**1.** Respeite todos os membros.',
      '**2.** Não faça spam, flood ou divulgação sem autorização.',
      '**3.** Não compartilhe conteúdo ilegal, ofensivo ou inadequado.',
      '**4.** Use cada canal para o assunto correspondente.',
      '**5.** Não tente burlar punições ou sistemas do bot.',
      '**6.** Para suporte ou denúncias, abra um ticket privado.'
    ].join('\n'))], allowedMentions: MENTIONS_NONE });
  }
  if (!await hasBotMessage(sugestoes, (m) => m.components.some((row) => row.components.some((c) => c.customId === 'btn_abrir_sugestao')))) {
    await sendSuggestionPanel(sugestoes);
  }
  if (!await hasBotMessage(welcome, (m) => m.components.some((row) => row.components.some((c) => c.customId === 'verify_btn')))) {
    await sendVerifyPanel(welcome, guild.roles.cache.get(cfg.verifyRole));
  }
  const { CHANGELOG, buildPage } = require('./changelog');
  if (!await hasBotMessage(novidades, (m) => m.embeds.some((e) => e.title?.includes(`Versão ${CHANGELOG[0].version}`)))) {
    await novidades.send(buildPage(0));
  }

  return { criados, canais: { regras, novidades, welcome, sugestoes, logs } };
}

async function setupTicketSystem(guild, client) {
  const cfg = ensureGuildConfig(guild.id);
  const me = client.user;
  const botFullAccess = [
    PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.EmbedLinks,
    PermissionFlagsBits.AttachFiles, PermissionFlagsBits.ManageChannels,
    PermissionFlagsBits.ManageMessages
  ];

  let categoria = guild.channels.cache.get(cfg.ticketCategoryId);
  if (categoria?.type !== ChannelType.GuildCategory) categoria = null;
  categoria ||= guild.channels.cache.find((c) => c.type === ChannelType.GuildCategory && /^(?:🎫・)?atendimento$/i.test(c.name));
  if (!categoria) {
    categoria = await guild.channels.create({
      name: '🎫・atendimento',
      type: ChannelType.GuildCategory,
      reason: 'Configuração do sistema de tickets'
    });
  }

  const staffIds = staffRoleIds(guild, cfg);
  const staffOverwrites = [...staffIds].map((id) => ({ id, allow: TICKET_BASE_PERMS }));
  const adminUserOverwrites = (cfg.adminUsers || []).map((id) => ({ id, allow: TICKET_BASE_PERMS }));
  const privateOverwrites = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: me.id, allow: botFullAccess },
    ...staffOverwrites,
    ...adminUserOverwrites
  ];

  let painel = guild.channels.cache.get(cfg.ticketPanelChannelId);
  if (painel?.type !== ChannelType.GuildText) painel = null;
  painel ||= guild.channels.cache.find((c) => c.type === ChannelType.GuildText && /^(?:🎫・)?abrir-ticket$/i.test(c.name));
  const painelOverwrites = [
    {
      id: guild.roles.everyone.id,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
      deny: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.AddReactions]
    },
    { id: me.id, allow: botFullAccess }
  ];
  if (!painel) {
    painel = await guild.channels.create({
      name: '🎫・abrir-ticket',
      type: ChannelType.GuildText,
      parent: categoria.id,
      topic: 'Abra um ticket privado para falar com a staff.',
      permissionOverwrites: painelOverwrites,
      reason: 'Canal do painel de tickets'
    });
  } else {
    await painel.setParent(categoria.id, { lockPermissions: false });
    await painel.permissionOverwrites.set(painelOverwrites, 'Proteção do painel de tickets');
  }

  let logs = guild.channels.cache.get(cfg.ticketLogChannelId);
  if (logs?.type !== ChannelType.GuildText) logs = null;
  logs ||= guild.channels.cache.find((c) => c.type === ChannelType.GuildText && /^(?:📜・)?transcripts-tickets$/i.test(c.name));
  if (!logs) {
    logs = await guild.channels.create({
      name: '📜・transcripts-tickets',
      type: ChannelType.GuildText,
      parent: categoria.id,
      topic: 'Transcripts e histórico dos atendimentos. Acesso exclusivo da staff.',
      permissionOverwrites: privateOverwrites,
      reason: 'Canal privado de transcripts'
    });
  } else {
    await logs.setParent(categoria.id, { lockPermissions: false });
    await logs.permissionOverwrites.set(privateOverwrites, 'Privacidade dos transcripts');
  }

  cfg.ticketCategoryId = categoria.id;
  cfg.ticketPanelChannelId = painel.id;
  cfg.ticketLogChannelId = logs.id;
  cfg.duvidasChannel = logs.id;
  cfg.denunciasChannel = logs.id;
  saveConfig();

  const mensagens = await painel.messages.fetch({ limit: 20 }).catch(() => null);
  const jaTemPainel = mensagens?.some((m) => m.author.id === me.id && m.components.some((row) =>
    row.components.some((component) => ['create_ticket_duvida', 'ticket:create:duvida'].includes(component.customId))
  ));
  if (!jaTemPainel) await sendTicketPanel(painel);

  return `✅ Estrutura criada: ${categoria.name}\n🎫 Painel: <#${painel.id}>\n📜 Transcripts privados: <#${logs.id}>`;
}

const LEADING_EMOJI = /^[\p{Extended_Pictographic}\p{Regional_Indicator}]/u;
function channelEmoji(channel) {
  const nome = normalize(channel.name);
  if (nome.includes('backup')) return '💾';
  if (nome.includes('transcript')) return '📜';
  if (nome.includes('ticket') || nome.includes('atendimento')) return '🎫';
  if (nome.includes('denuncia')) return '🚨';
  if (nome.includes('sugest')) return '💡';
  if (nome.includes('welcome') || nome.includes('boas-vindas')) return '👋';
  if (nome.includes('log')) return '📋';
  if (nome.includes('regra')) return '📖';
  if (nome.includes('anuncio')) return '📢';

  switch (channel.type) {
    case ChannelType.GuildCategory: return '📁';
    case ChannelType.GuildVoice: return '🔊';
    case ChannelType.GuildAnnouncement: return '📢';
    case ChannelType.GuildForum: return '💡';
    case ChannelType.GuildStageVoice: return '🎤';
    default: return '💬';
  }
}

async function decorateGuildChannels(guild) {
  let alterados = 0;
  let falhas = 0;
  const canais = [...guild.channels.cache.values()]
    .filter((channel) => !channel.isThread?.())
    .sort((a, b) => (a.rawPosition || 0) - (b.rawPosition || 0));

  for (const channel of canais) {
    if (LEADING_EMOJI.test(channel.name)) continue;
    const novoNome = `${channelEmoji(channel)}・${channel.name}`.slice(0, 100);
    try {
      await channel.setName(novoNome, 'Setup: padronização visual dos canais');
      alterados++;
    } catch (err) {
      falhas++;
      console.error(`[setup] não consegui renomear #${channel.name}:`, err.message);
    }
  }
  return { alterados, falhas };
}

async function buildTranscript(channel) {
  const all = [];
  let before;
  for (let i = 0; i < 10; i++) {
    const batch = await channel.messages.fetch({ limit: 100, before });
    if (batch.size === 0) break;
    all.push(...batch.values());
    before = batch.last().id;
    if (batch.size < 100) break;
  }
  all.reverse();
  return all.map((m) => {
    const anexos = m.attachments.size ? ` [anexos: ${[...m.attachments.values()].map((a) => a.url).join(' ')}]` : '';
    const conteudo = m.content || (m.embeds.size ? '[embed]' : '[sem texto]');
    return `[${fmtDateTime(new Date(m.createdTimestamp))}] ${m.author.tag} (${m.author.id}): ${conteudo}${anexos}`;
  }).join('\n');
}

async function createTicket(interaction, tipo) {
  const { guild, member } = interaction;
  if (!guild || !member || !TICKET_TYPES[tipo]) return interaction.reply(eph('❌ Não consegui identificar este atendimento.'));

  const topic = `ticket:${tipo}:${member.id}`;
  const lockKey = `${guild.id}:${topic}`;
  const existing = guild.channels.cache.find((c) => c.topic === topic);
  if (existing) return interaction.reply(eph(`⚠️ Você já possui um ticket aberto em <#${existing.id}>.`));
  if (creatingTickets.has(lockKey)) return interaction.reply(eph('⏳ Seu ticket já está sendo criado. Aguarde um instante.'));
  creatingTickets.add(lockKey);

  let ticketChannel = null;
  try {
    await interaction.deferReply({ flags: EPHEMERAL });

    const salvo = Object.values(ticketBucket(guild.id)).find((t) => t.creatorId === member.id && t.tipo === tipo && t.status === 'open');
    if (salvo) {
      const canalSalvo = await guild.channels.fetch(salvo.channelId).catch(() => null);
      if (canalSalvo) return interaction.editReply({ content: `⚠️ Você já possui um ticket aberto em <#${canalSalvo.id}>.` });
      delete ticketBucket(guild.id)[salvo.channelId];
      ticketStore.save();
    }

    const cfg = getGuildConfig(guild.id);
    const info = TICKET_TYPES[tipo];
    const slug = member.user.username.toLowerCase().replace(/[^a-z0-9]/g, '') || member.id;
    const nomeCanal = `${info.emoji}・${tipo}-${slug}`.slice(0, 100);
    const overwrites = [
      { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      { id: member.id, allow: TICKET_BASE_PERMS },
      { id: interaction.client.user.id, allow: [...TICKET_BASE_PERMS, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageMessages] },
      ...[...staffRoleIds(guild, cfg)].map((id) => ({ id, allow: TICKET_BASE_PERMS }))
    ];
    for (const userId of cfg.adminUsers || []) {
      if (userId !== member.id) overwrites.push({ id: userId, allow: TICKET_BASE_PERMS });
    }

    const categoria = guild.channels.cache.get(cfg.ticketCategoryId);
    ticketChannel = await guild.channels.create({
      name: nomeCanal,
      type: ChannelType.GuildText,
      parent: categoria?.type === ChannelType.GuildCategory ? categoria.id : null,
      topic,
      permissionOverwrites: overwrites,
      reason: `${info.nome} aberta por ${member.user.tag}`
    });

    const record = {
      channelId: ticketChannel.id,
      guildId: guild.id,
      creatorId: member.id,
      tipo,
      status: 'open',
      claimedBy: null,
      rating: null,
      createdAt: Date.now()
    };
    ticketBucket(guild.id, true)[ticketChannel.id] = record;
    ticketStore.save();

    const controlEmbed = new EmbedBuilder()
      .setColor(info.cor)
      .setTitle(`${info.emoji} Ticket de ${info.nome}`)
      .setDescription(`Olá <@${member.id}>, seu atendimento foi aberto. Descreva o que aconteceu e aguarde um membro da staff.\n\n**Não divulgue senhas, tokens ou outros dados sensíveis.**`)
      .addFields(
        { name: '👤 Autor', value: `<@${member.id}>`, inline: true },
        { name: '🕒 Aberto', value: `<t:${unix(record.createdAt)}:R>`, inline: true },
        { name: '📌 Situação', value: 'Aguardando atendimento', inline: true }
      )
      .setFooter({ text: 'O autor precisa avaliar o atendimento antes do fechamento.' })
      .setTimestamp();

    const staffRoles = [...staffRoleIds(guild, cfg)].slice(0, 10);
    await ticketChannel.send({
      content: [`<@${member.id}>`, ...staffRoles.map((id) => `<@&${id}>`)].join(' '),
      embeds: [controlEmbed],
      components: ticketControlRows(),
      allowedMentions: { users: [member.id], roles: staffRoles }
    });
    await interaction.editReply({ content: `✅ Seu ticket foi criado: <#${ticketChannel.id}>` });
  } catch (err) {
    console.error('[ticket] criar:', err);
    if (ticketChannel) {
      delete ticketBucket(guild.id)[ticketChannel.id];
      ticketStore.save();
      await ticketChannel.delete('Falha ao inicializar o ticket').catch(() => {});
    }
    const aviso = describeError(err) || '❌ Erro ao criar o ticket. Verifique minhas permissões de **Gerenciar Canais**.';
    await interaction.editReply({ content: aviso }).catch(() => {});
  } finally {
    creatingTickets.delete(lockKey);
  }
}

async function closeTicket(interaction) {
  const channel = interaction.channel;
  const meta = parseTicketTopic(channel);
  if (!meta) return interaction.reply(eph('❌ Este não é um canal de ticket.'));

  const staff = isStaff(interaction.member, getGuildConfig(interaction.guild.id));
  if (interaction.user.id !== meta.creatorId && !staff) {
    return interaction.reply(eph('❌ Somente o autor do ticket ou a staff pode fechá-lo.'));
  }
  const record = getTicketRecord(interaction.guild.id, channel.id);
  const notaFinal = record?.rating || state.ratings[channel.id] || null;
  if (!notaFinal) {
    return interaction.reply(eph('⭐ **A avaliação é obrigatória.** O autor do ticket precisa escolher de 1 a 5 estrelas antes que ele possa ser fechado.'));
  }
  if (closingTickets.has(channel.id) || meta.status === 'closed') return interaction.reply(eph('⚠️ Este ticket já está sendo fechado.'));
  closingTickets.add(channel.id);

  await interaction.reply({ content: '🔒 Ticket fechado. Gerando o transcript e removendo o canal em alguns segundos...' });
  await interaction.message.edit({ components: [] }).catch(() => {});

  try {
    const transcriptText = await buildTranscript(channel);
    const fileName = `transcript-${channel.id}.txt`;
    const transcriptEmbed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle('📜 Atendimento encerrado')
      .setDescription(`**Canal:** #${channel.name}\n**Tipo:** ${TICKET_TYPES[meta.tipo]?.nome || meta.tipo}`)
      .addFields(
        { name: '👤 Autor', value: meta.creatorId ? `<@${meta.creatorId}>` : 'Desconhecido', inline: true },
        { name: '🔒 Fechado por', value: `<@${interaction.user.id}>`, inline: true },
        { name: '⭐ Avaliação', value: notaFinal ? `${notaFinal}/5` : 'Não avaliado', inline: true },
        { name: '🙋 Atendente', value: record?.claimedBy ? `<@${record.claimedBy}>` : 'Não assumido', inline: true }
      )
      .setTimestamp();

    const makeFile = () => new AttachmentBuilder(Buffer.from(transcriptText || 'Nenhuma mensagem registrada.', 'utf8'), { name: fileName });
    const enviado = await sendLog(channel.guild, meta.tipo, transcriptEmbed, makeFile(), 'tickets');
    if (!enviado && meta.creatorId && logEnabled(channel.guild.id, 'tickets')) {
      const autor = await interaction.client.users.fetch(meta.creatorId).catch(() => null);
      if (autor) await autor.send({ embeds: [transcriptEmbed], files: [makeFile()] }).catch(() => {});
    }
  } catch (err) {
    console.error('[ticket] transcript:', err);
    await channel.send('⚠️ Não consegui gerar o transcript, mas o ticket será encerrado.').catch(() => {});
  }

  if (record) {
    record.status = 'closed';
    record.closedBy = interaction.user.id;
    record.closedAt = Date.now();
  }
  delete state.ratings[channel.id];
  ticketStore.save();
  stateStore.save();

  setTimeout(async () => {
    await channel.delete(`Ticket fechado por ${interaction.user.tag}`).catch((err) => console.error('[ticket] apagar:', err.message));
    delete ticketBucket(interaction.guild.id)[channel.id];
    ticketStore.save();
    closingTickets.delete(channel.id);
  }, 5000);
}

/* ============================================================
 *  COMANDOS SLASH
 * ============================================================ */
const GIVEAWAY_EMOJI = '🎉';

function giveawayEmbed(premio, endsAt, hostId, winnerId = null, ended = false) {
  const embed = new EmbedBuilder()
    .setColor(ended ? 0x95A5A6 : 0xE91E63)
    .setTitle(ended ? '🎉 SORTEIO ENCERRADO' : '🎉 SORTEIO')
    .setDescription(`Prêmio: **${premio}**`)
    .setTimestamp(endsAt);
  if (ended) {
    embed.addFields({ name: '🏆 Vencedor', value: winnerId ? `<@${winnerId}>` : 'Ninguém participou', inline: true });
  } else {
    embed.addFields(
      { name: '⏰ Termina', value: `<t:${unix(endsAt)}:R>`, inline: true },
      { name: '👤 Organizador', value: `<@${hostId}>`, inline: true }
    ).setFooter({ text: `Reage com ${GIVEAWAY_EMOJI} para participar!` });
  }
  return embed;
}

const CHANNEL_KEYS = {
  setwelcome: 'welcomeChannel',
  setsuggestion: 'suggestionChannel',
  setlogs: 'logsChannel',
  setdenuncias: 'denunciasChannel',
  setduvidas: 'duvidasChannel',
  setpunicoes: 'punicoesChannel',
  setmsgdelete: 'msgDeleteChannel',
  setnivel: 'levelChannel'
};

const setChannelCommand = (commandName) => async (ctx) => {
  const { interaction, options, guild } = ctx;
  if (await deny(ctx, null, '❌ Apenas administradores.')) return;
  const chan = options.getChannel('canal');
  ensureGuildConfig(guild.id)[CHANNEL_KEYS[commandName]] = chan.id;
  saveConfig();
  await interaction.reply(eph(`✅ Canal <#${chan.id}> configurado com sucesso!`));
};

const COMMANDS = {
  async ping({ interaction }) {
    await interaction.reply(eph(`🏓 Pong! ${Date.now() - interaction.createdTimestamp}ms (API: ${Math.round(interaction.client.ws.ping)}ms)`));
  },

  async lock(ctx) {
    const { interaction, channel, guild } = ctx;
    if (await deny(ctx, PermissionFlagsBits.ManageChannels)) return;
    try {
      await channel.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: false });
      await interaction.reply({ content: '🔒 Canal trancado!' });
    } catch (_) {
      await interaction.reply(eph('❌ Não consegui trancar este canal.'));
    }
  },

  async unlock(ctx) {
    const { interaction, channel, guild } = ctx;
    if (await deny(ctx, PermissionFlagsBits.ManageChannels)) return;
    try {
      await channel.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: null });
      await interaction.reply({ content: '🔓 Canal destrancado!' });
    } catch (_) {
      await interaction.reply(eph('❌ Não consegui destrancar este canal.'));
    }
  },

  async slowmode(ctx) {
    const { interaction, channel, options } = ctx;
    if (await deny(ctx, PermissionFlagsBits.ManageChannels)) return;
    const segundos = options.getInteger('segundos');
    try {
      await channel.setRateLimitPerUser(segundos);
      await interaction.reply({ content: segundos === 0 ? '⏱️ Modo lento desativado.' : `⏱️ Modo lento definido para **${segundos}s**.` });
    } catch (_) {
      await interaction.reply(eph('❌ Não consegui alterar o modo lento deste canal.'));
    }
  },

  async say(ctx) {
    const { interaction, channel, options, member, guildConfig } = ctx;
    const staff = isStaff(member, guildConfig);
    await channel.send({ content: options.getString('texto'), allowedMentions: { parse: staff ? ['users', 'roles'] : [] } });
    if (interaction.isPrefix) return silentDelete(interaction.message);
    await interaction.reply(eph('✅ Enviado!'));
  },

  async clear(ctx) {
    const { interaction, channel, options } = ctx;
    if (await deny(ctx)) return;
    const qtd = options.getInteger('qtd');
    const alvo = options.getUser('usuario');
    await interaction.deferReply({ flags: EPHEMERAL });
    try {
      quietChannel(channel.id); // a limpeza da staff não entra no log de mensagens apagadas
      let total;
      if (alvo) {
        // Só as mensagens da pessoa escolhida (dentro das últimas 100 do canal)
        const lote = await channel.messages.fetch({ limit: 100 });
        const dela = [...lote.filter((m) => m.author.id === alvo.id).values()].slice(0, qtd);
        total = dela.length ? (await channel.bulkDelete(dela, true)).size : 0;
      } else {
        // No prefixo, a mensagem do comando também está no canal: apaga uma a mais
        const apagadas = await channel.bulkDelete(Math.min(100, qtd + (interaction.isPrefix ? 1 : 0)), true);
        total = Math.max(0, apagadas.size - (interaction.isPrefix ? 1 : 0));
      }
      await interaction.editReply({ content: `✅ ${total} mensagens limpas${alvo ? ` de ${alvo.tag}` : ''}!` });
    } catch (_) {
      await interaction.editReply({ content: '❌ Erro ao limpar mensagens.' });
    }
  },

  async avatar({ interaction, options }) {
    const alvo = options.getUser('usuario') || interaction.user;
    const embed = new EmbedBuilder().setColor(0x00AE86).setTitle(`Avatar de ${alvo.tag}`).setImage(alvo.displayAvatarURL({ size: 1024 }));
    await interaction.reply({ embeds: [embed] });
  },

  async serverinfo({ interaction, guild }) {
    const embed = new EmbedBuilder()
      .setColor(0x00AE86)
      .setTitle(guild.name)
      .setThumbnail(guild.iconURL({ size: 256 }))
      .addFields(
        { name: 'Membros', value: `${guild.memberCount}`, inline: true },
        { name: 'Canais', value: `${guild.channels.cache.size}`, inline: true },
        { name: 'Cargos', value: `${guild.roles.cache.size}`, inline: true },
        { name: 'Dono', value: `<@${guild.ownerId}>`, inline: true },
        { name: 'Criado', value: `<t:${unix(guild.createdTimestamp)}:D>`, inline: true },
        { name: 'Boosts', value: `${guild.premiumSubscriptionCount || 0}`, inline: true }
      );
    await interaction.reply({ embeds: [embed] });
  },

  async userinfo({ interaction, options, member }) {
    const user = options.getUser('usuario') || interaction.user;
    const m = options.getMember('usuario') ?? (user.id === interaction.user.id ? member : null);
    const embed = new EmbedBuilder()
      .setColor(0x00AE86)
      .setTitle(user.tag)
      .setThumbnail(user.displayAvatarURL({ size: 256 }))
      .addFields(
        { name: 'ID', value: user.id, inline: true },
        { name: 'Conta criada', value: `<t:${unix(user.createdTimestamp)}:R>`, inline: true }
      );
    if (m) {
      embed.addFields(
        { name: 'Entrou no servidor', value: m.joinedTimestamp ? `<t:${unix(m.joinedTimestamp)}:R>` : 'Desconhecido', inline: true },
        { name: 'Cargos', value: `${Math.max(0, m.roles.cache.size - 1)}`, inline: true }
      );
    }
    await interaction.reply({ embeds: [embed] });
  },

  async ban(ctx) {
    const { interaction, options, guild } = ctx;
    if (await deny(ctx, PermissionFlagsBits.BanMembers)) return;
    const alvo = options.getUser('usuario');
    const alvoMembro = options.getMember('usuario');
    const minutos = options.getInteger('minutos') ?? 0;
    const motivo = options.getString('motivo') || 'Sem motivo';

    const problema = checkTarget(ctx, alvo, alvoMembro, 'bannable');
    if (problema) return interaction.reply(eph(problema));

    await interaction.deferReply();
    try {
      markBotAction('ban', guild.id, alvo.id);
      await guild.members.ban(alvo, { reason: `${motivo} (por ${interaction.user.tag})` });
    } catch (_) {
      return interaction.editReply({ content: '❌ Erro ao banir o usuário.' });
    }

    state.tempBans = state.tempBans.filter((t) => !(t.guildId === guild.id && t.userId === alvo.id));
    if (minutos > 0) state.tempBans.push({ guildId: guild.id, userId: alvo.id, expiresAt: Date.now() + minutos * 60000 });
    stateStore.save();

    await interaction.editReply({ content: `✅ <@${alvo.id}> foi banido${minutos > 0 ? ` por **${minutos} minuto(s)**` : ' **permanentemente**'}. Motivo: *${motivo}*`, allowedMentions: MENTIONS_NONE });
    await sendLog(guild, 'punicao', punishEmbed('🔨 Ban', 0xC0392B, alvo, interaction.user, motivo, [
      { name: '⏳ Duração', value: minutos > 0 ? `${minutos} minuto(s)` : 'Permanente', inline: true }
    ]));
  },

  async unban(ctx) {
    const { interaction, options, guild } = ctx;
    if (await deny(ctx, PermissionFlagsBits.BanMembers)) return;
    const id = options.getString('usuario').trim().replace(/[<@>]/g, '');
    if (!/^\d{15,22}$/.test(id)) return interaction.reply(eph('❌ Indica o ID numérico do usuário banido.'));
    try {
      markBotAction('unban', guild.id, id);
      await guild.members.unban(id, `Unban por ${interaction.user.tag}`);
    } catch (_) {
      return interaction.reply(eph('❌ Não encontrei esse banimento (ou não tenho permissão).'));
    }
    state.tempBans = state.tempBans.filter((t) => !(t.guildId === guild.id && t.userId === id));
    stateStore.save();
    await interaction.reply({ content: `✅ <@${id}> foi desbanido.`, allowedMentions: MENTIONS_NONE });
  },

  async kick(ctx) {
    const { interaction, options, guild } = ctx;
    if (await deny(ctx, PermissionFlagsBits.KickMembers)) return;
    const alvoMembro = options.getMember('usuario');
    const alvo = options.getUser('usuario');
    const motivo = options.getString('motivo') || 'Sem motivo';
    if (!alvoMembro) return interaction.reply(eph('❌ Esse usuário não está no servidor.'));

    const problema = checkTarget(ctx, alvo, alvoMembro, 'kickable');
    if (problema) return interaction.reply(eph(problema));

    try {
      await alvoMembro.kick(`${motivo} (por ${interaction.user.tag})`);
    } catch (_) {
      return interaction.reply(eph('❌ Erro ao expulsar o membro.'));
    }
    await interaction.reply({ content: `✅ <@${alvo.id}> foi expulso. Motivo: *${motivo}*`, allowedMentions: MENTIONS_NONE });
    await sendLog(guild, 'punicao', punishEmbed('👢 Kick', 0xE67E22, alvo, interaction.user, motivo));
  },

  async mute(ctx) {
    const { interaction, options, guild } = ctx;
    if (await deny(ctx)) return;
    const alvo = options.getUser('usuario');
    const alvoMembro = options.getMember('usuario');
    const minutos = options.getInteger('minutos');
    const motivo = options.getString('motivo') || 'Sem motivo especificado';
    if (!alvoMembro) return interaction.reply(eph('❌ Esse usuário não está no servidor.'));

    const problema = checkTarget(ctx, alvo, alvoMembro, 'moderatable');
    if (problema) return interaction.reply(eph(problema));

    try {
      markBotAction('timeout', guild.id, alvo.id);
      await alvoMembro.timeout(minutos * 60 * 1000, motivo);
    } catch (_) {
      return interaction.reply(eph('❌ Erro ao silenciar o membro.'));
    }
    await interaction.reply({ content: `✅ <@${alvo.id}> foi silenciado por **${minutos} minuto(s)**. Motivo: *${motivo}*`, allowedMentions: MENTIONS_NONE });
    await sendLog(guild, 'punicao', punishEmbed('🔇 Mute', 0xF1C40F, alvo, interaction.user, motivo, [
      { name: '⏳ Duração', value: `${minutos} minuto(s)`, inline: true }
    ]));
  },

  async unmute(ctx) {
    const { interaction, options, guild } = ctx;
    if (await deny(ctx)) return;
    const alvo = options.getUser('usuario');
    const alvoMembro = options.getMember('usuario');
    if (!alvoMembro) return interaction.reply(eph('❌ Esse usuário não está no servidor.'));
    try {
      markBotAction('untimeout', guild.id, alvo.id);
      await alvoMembro.timeout(null, 'Unmute');
    } catch (_) {
      return interaction.reply(eph('❌ Não consegui remover o silêncio desse membro.'));
    }
    const lista = state.calados[guild.id] || [];
    if (lista.includes(alvo.id)) {
      state.calados[guild.id] = lista.filter((id) => id !== alvo.id);
      stateStore.save();
    }
    await interaction.reply({ content: `✅ Silêncio e restrições removidos de ${alvo.tag}.` });
  },

  async calado(ctx) {
    const { interaction, options, guild } = ctx;
    if (await deny(ctx)) return;
    const alvo = options.getUser('usuario');
    const lista = state.calados[guild.id] || [];

    if (lista.includes(alvo.id)) {
      state.calados[guild.id] = lista.filter((id) => id !== alvo.id);
      stateStore.save();
      return interaction.reply({ content: `🔊 <@${alvo.id}> não está mais calado (as mensagens voltaram a aparecer).`, allowedMentions: MENTIONS_NONE });
    }
    state.calados[guild.id] = [...lista, alvo.id];
    stateStore.save();
    await interaction.reply({ content: `🔇 <@${alvo.id}> foi deixado **calado**! A partir de agora, todas as mensagens dele serão apagadas automaticamente.`, allowedMentions: MENTIONS_NONE });
  },

  async setcargo(ctx) {
    const { interaction, options, member, guild } = ctx;
    if (await deny(ctx, PermissionFlagsBits.ManageRoles)) return;
    const alvo = options.getMember('usuario');
    const cargo = options.getRole('cargo');
    if (!alvo) return interaction.reply(eph('❌ Esse usuário não está no servidor.'));
    if (cargo.id === guild.id || cargo.managed) return interaction.reply(eph('❌ Esse cargo não pode ser atribuído manualmente.'));
    if (!cargo.editable) return interaction.reply(eph('❌ Esse cargo está acima do meu cargo mais alto.'));
    if (member.id !== guild.ownerId && cargo.position >= member.roles.highest.position) {
      return interaction.reply(eph('❌ Esse cargo é igual ou superior ao teu.'));
    }
    if (!canModerate(member, alvo) && alvo.id !== member.id) return interaction.reply(eph('❌ Esse membro tem um cargo igual ou superior ao teu.'));
    try {
      if (alvo.roles.cache.has(cargo.id)) {
        await alvo.roles.remove(cargo);
        await interaction.reply({ content: `✅ Cargo <@&${cargo.id}> removido de ${alvo.user.tag}.`, allowedMentions: MENTIONS_NONE });
      } else {
        await alvo.roles.add(cargo);
        await interaction.reply({ content: `✅ Cargo <@&${cargo.id}> adicionado a ${alvo.user.tag}.`, allowedMentions: MENTIONS_NONE });
      }
    } catch (_) {
      await interaction.reply(eph('❌ Erro ao gerenciar cargo.'));
    }
  },

  async warn(ctx) {
    const { interaction, options, guild } = ctx;
    if (await deny(ctx)) return;
    const alvo = options.getUser('usuario');
    const motivo = options.getString('motivo');
    const warnings = warningsStore.data;
    ((warnings[guild.id] ??= {})[alvo.id] ??= []).push({ motivo, data: fmtDate(), por: interaction.user.id });
    warningsStore.save();
    const total = warnings[guild.id][alvo.id].length;
    await interaction.reply({ content: `✅ Aviso registado para ${alvo.tag}. (Total: **${total}**)` });
    await sendLog(guild, 'punicao', punishEmbed('⚠️ Aviso', 0xF39C12, alvo, interaction.user, motivo, [
      { name: '🔢 Total de avisos', value: `${total}`, inline: true }
    ]));
  },

  async warnings({ interaction, options, guild }) {
    const alvo = options.getUser('usuario');
    const lista = warningsStore.data[guild.id]?.[alvo.id] || [];
    if (lista.length === 0) return interaction.reply(eph(`ℹ️ ${alvo.tag} não tem avisos.`));
    const desc = lista.slice(-15).map((w, i) => `${lista.length - Math.min(15, lista.length) + i + 1}. ${w.motivo} (${w.data})`).join('\n');
    await interaction.reply(eph(truncate(`⚠️ Avisos de ${alvo.tag} (${lista.length}):\n${desc}`, 1990)));
  },

  async clearwarns(ctx) {
    const { interaction, options, guild } = ctx;
    if (await deny(ctx)) return;
    const alvo = options.getUser('usuario');
    const warnings = warningsStore.data;
    if (!warnings[guild.id]?.[alvo.id]?.length) return interaction.reply(eph(`ℹ️ ${alvo.tag} não tem avisos.`));
    delete warnings[guild.id][alvo.id];
    warningsStore.save();
    await interaction.reply({ content: `🧹 Avisos de ${alvo.tag} apagados.` });
  },

  async ticket(ctx) {
    const { interaction, channel } = ctx;
    if (await deny(ctx)) return;
    try {
      await sendTicketPanel(channel);
      await interaction.reply(eph('✅ Painel de tickets enviado!'));
    } catch (err) {
      await interaction.reply(eph(describeError(err) || '❌ Não consegui enviar o painel neste canal.'));
    }
  },

  async setup(ctx) {
    const { interaction, guild, member } = ctx;
    if (await deny(ctx)) return;
    if (!hasFullAccess(member, getGuildConfig(guild.id))
      && (!member.permissions.has(PermissionFlagsBits.ManageChannels) || !member.permissions.has(PermissionFlagsBits.ManageRoles))) {
      return interaction.reply(eph('❌ O setup completo também exige as permissões **Gerenciar Canais** e **Gerenciar Cargos**.'));
    }
    const acao = interaction.options.getString('acao') || 'completo';
    await interaction.deferReply({ flags: EPHEMERAL });

    try {
      const resposta = [];
      if (acao === 'completo') {
        const cargos = await setupEssentialRoles(guild);
        resposta.push(`👥 Cargos essenciais configurados: **${cargos.criados} criado(s)** e os demais reutilizados.`);
        const estrutura = await setupEssentialChannels(guild, interaction.client);
        resposta.push(`🏗️ Estrutura do servidor: **${estrutura.criados} canal(is) criado(s)**, logs e comandos de configuração conectados.`);
      }
      if (acao === 'completo' || acao === 'tickets') {
        resposta.push(await setupTicketSystem(guild, interaction.client));
      }
      if (acao === 'completo' || acao === 'emojis') {
        const r = await decorateGuildChannels(guild);
        resposta.push(`✨ Emojis: **${r.alterados}** canal(is) atualizado(s)${r.falhas ? ` • **${r.falhas}** falha(s)` : ''}.`);
      }
      resposta.push('', `Painéis extras: \`${PREFIX}ticket\` e \`${PREFIX}painel-sugestao\`. Veja tudo com \`${PREFIX}help\`.`);
      await interaction.editReply({ content: truncate(resposta.join('\n'), 1990) });
    } catch (err) {
      console.error('[setup]', err);
      await interaction.editReply({ content: describeError(err) || '❌ Não consegui concluir o setup. Verifique minhas permissões de **Gerenciar Canais** e **Gerenciar Cargos** e tente novamente.' });
    }
  },

  async 'painel-sugestao'(ctx) {
    const { interaction, channel } = ctx;
    if (await deny(ctx)) return;
    await sendSuggestionPanel(channel);
    await interaction.reply(eph('✅ Painel de sugestões enviado!'));
  },

  async sugerir({ interaction, options, guild }) {
    const ideia = options.getString('ideia');
    const embed = new EmbedBuilder().setColor(0xFFA500).setTitle('💡 Sugestão').setDescription(ideia).setFooter({ text: interaction.user.tag });
    const msg = await sendLog(guild, 'sugestao', embed);
    if (msg) {
      await msg.react('👍').catch(() => {});
      await msg.react('👎').catch(() => {});
    }
    await interaction.reply(eph('✅ Sugestão enviada!'));
  },

  async denuncia({ interaction, options, guild }) {
    const texto = options.getString('mensagem');
    const embed = new EmbedBuilder().setColor(0xFF0000).setTitle('🚨 Denúncia Anônima').setDescription(texto).setTimestamp();
    await sendLog(guild, 'denuncia', embed);
    await interaction.reply(eph('✅ Denúncia enviada à staff.'));
  },

  async sorteio(ctx) {
    const { interaction, options, channel, guild } = ctx;
    if (await deny(ctx)) return;
    const premio = options.getString('premio');
    const minutos = options.getInteger('minutos');
    const endsAt = Date.now() + minutos * 60000;

    const msg = await channel.send({ embeds: [giveawayEmbed(premio, endsAt, interaction.user.id)] });
    await msg.react(GIVEAWAY_EMOJI).catch(() => {});
    state.giveaways.push({ guildId: guild.id, channelId: channel.id, messageId: msg.id, premio, endsAt, hostId: interaction.user.id });
    stateStore.save();
    await interaction.reply(eph(`✅ Sorteio iniciado! Termina em ${minutos} minuto(s).`));
  },

  async embed(ctx) {
    const { interaction, options, channel } = ctx;
    if (await deny(ctx)) return;
    await channel.send({ embeds: [new EmbedBuilder().setTitle(options.getString('titulo')).setDescription(options.getString('descricao')).setColor(0x3498DB)] });
    await interaction.reply(eph('✅ Embed criado!'));
  },

  async automod(ctx) {
    const { interaction, options, guild } = ctx;
    if (await deny(ctx)) return;
    const ligado = options.getBoolean('status');
    ensureGuildConfig(guild.id).automod = ligado;
    saveConfig();
    await interaction.reply(eph(`✅ Automod de links ${ligado ? '**ativado**' : '**desativado**'}!`));
  },

  async logs(ctx) {
    const { interaction, options, guild } = ctx;
    if (await deny(ctx)) return;
    const categoria = options.getString('categoria');
    const status = options.getBoolean('status');

    if (categoria === 'testar') {
      await interaction.deferReply({ flags: EPHEMERAL });
      const resultados = [];
      for (const [key, nome] of Object.entries(LOG_NAMES)) {
        const destino = destinationOf(guild, key);
        if (!destino) { resultados.push(`⚠️ **${nome}** — sem canal configurado`); continue; }
        const canal = guild.channels.cache.get(destino);
        try {
          await canal.send({ embeds: [new EmbedBuilder().setColor(0x95A5A6).setTitle('🧪 Teste de log').setDescription(`Categoria: **${nome}**\nSe você está vendo isto, esse log funciona aqui.`).setTimestamp()] });
          resultados.push(`✅ **${nome}** → <#${destino}>`);
        } catch (_) {
          resultados.push(`❌ **${nome}** → <#${destino}> (não consigo enviar mensagens/embeds lá)`);
        }
      }
      return interaction.editReply({ content: truncate(resultados.join('\n'), 1990) });
    }
    if (categoria) {
      const cfg = ensureGuildConfig(guild.id);
      cfg.logToggles ??= {};
      cfg.logToggles[categoria] = status ?? !logEnabled(guild.id, categoria);
      saveConfig();
    }
    const me = guild.members.me;
    const linhas = Object.entries(LOG_NAMES).map(([k, nome]) => {
      const destino = destinationOf(guild, k);
      let onde;
      if (k === 'nivel' && !destino) onde = 'no canal onde a pessoa conversou';
      else if (!destino) onde = '⚠️ **sem canal** — configure com `setlogs`' + (k === 'apagadas' || k === 'editadas' ? ' ou `setmsgdelete`' : k === 'punicoes' ? ' ou `setpunicoes`' : '');
      else if (!guild.channels.cache.get(destino)?.permissionsFor(me)?.has(['ViewChannel', 'SendMessages', 'EmbedLinks'])) onde = `⚠️ <#${destino}> (sem permissão para eu enviar lá)`;
      else onde = `<#${destino}>`;
      return `${logEnabled(guild.id, k) ? '🟢' : '🔴'} **${nome}** → ${onde}`;
    }).join('\n');
    const embed = new EmbedBuilder().setColor(0x3498DB).setTitle('🔔 Logs e avisos do bot').setDescription(`${linhas}\n\n🟢 ligado • 🔴 desligado\nMude com \`${PREFIX}logs apagadas nao\` (ou \`/logs\`) e confira tudo com \`${PREFIX}logs testar\`.`);
    return interaction.reply({ embeds: [embed], flags: EPHEMERAL });
  },

  async setadminrole(ctx) {
    const { interaction, options, member, guild } = ctx;
    if (!member.permissions.has(PermissionFlagsBits.Administrator)) return interaction.reply(eph('❌ Apenas Administradores.'));
    const cargo = options.getRole('cargo');
    const cfg = ensureGuildConfig(guild.id);
    cfg.adminRoles ??= [];
    if (!cfg.adminRoles.includes(cargo.id)) cfg.adminRoles.push(cargo.id);
    saveConfig();
    await interaction.reply({ content: `✅ Cargo <@&${cargo.id}> adicionado como admin do bot.`, flags: EPHEMERAL, allowedMentions: MENTIONS_NONE });
  },

  async setadminuser(ctx) {
    const { interaction, options, member, guild } = ctx;
    if (!member.permissions.has(PermissionFlagsBits.Administrator)) return interaction.reply(eph('❌ Apenas Administradores.'));
    const usuario = options.getUser('usuario');
    const cfg = ensureGuildConfig(guild.id);
    cfg.adminUsers ??= [];
    if (!cfg.adminUsers.includes(usuario.id)) cfg.adminUsers.push(usuario.id);
    saveConfig();
    await interaction.reply({ content: `✅ Utilizador <@${usuario.id}> adicionado como admin do bot.`, flags: EPHEMERAL, allowedMentions: MENTIONS_NONE });
  },

  async deladminrole(ctx) {
    const { interaction, options, member, guild } = ctx;
    if (!member.permissions.has(PermissionFlagsBits.Administrator)) return interaction.reply(eph('❌ Apenas Administradores.'));
    const cargo = options.getRole('cargo');
    const cfg = ensureGuildConfig(guild.id);
    cfg.adminRoles = (cfg.adminRoles || []).filter((id) => id !== cargo.id);
    saveConfig();
    await interaction.reply({ content: `✅ Cargo <@&${cargo.id}> removido da administração do bot.`, flags: EPHEMERAL, allowedMentions: MENTIONS_NONE });
  },

  async deladminuser(ctx) {
    const { interaction, options, member, guild } = ctx;
    if (!member.permissions.has(PermissionFlagsBits.Administrator)) return interaction.reply(eph('❌ Apenas Administradores.'));
    const usuario = options.getUser('usuario');
    const cfg = ensureGuildConfig(guild.id);
    cfg.adminUsers = (cfg.adminUsers || []).filter((id) => id !== usuario.id);
    saveConfig();
    await interaction.reply({ content: `✅ Utilizador <@${usuario.id}> removido da administração do bot.`, flags: EPHEMERAL, allowedMentions: MENTIONS_NONE });
  },

  async nick(ctx) {
    const { interaction, options, guild } = ctx;
    if (await deny(ctx)) return;
    const alvo = options.getMember('usuario');
    const apelido = options.getString('apelido');
    if (!alvo) return interaction.reply(eph('❌ Esse usuário não está no servidor.'));
    if (state.permNicks[guild.id]?.[alvo.id]) return interaction.reply(eph('🔒 O apelido desse membro está travado. Usa `/unpermnick` primeiro.'));
    if (!alvo.manageable) return interaction.reply(eph('❌ Não consigo alterar o apelido desse membro.'));
    try {
      await alvo.setNickname(apelido);
    } catch (_) {
      return interaction.reply(eph('❌ Erro ao alterar o apelido.'));
    }
    await interaction.reply({ content: `✅ Apelido de ${alvo.user.tag} alterado.` });
  },

  async permnick(ctx) {
    const { interaction, options, guild } = ctx;
    if (await deny(ctx)) return;
    const alvo = options.getMember('usuario');
    const apelido = options.getString('apelido');
    if (!alvo) return interaction.reply(eph('❌ Esse usuário não está no servidor.'));
    if (!alvo.manageable) return interaction.reply(eph('❌ Não consigo alterar o apelido desse membro.'));
    try {
      await alvo.setNickname(apelido);
    } catch (_) {
      return interaction.reply(eph('❌ Erro ao alterar o apelido.'));
    }
    (state.permNicks[guild.id] ??= {})[alvo.id] = apelido;
    stateStore.save();
    await interaction.reply({ content: `🔒 Apelido de ${alvo.user.tag} travado como **${apelido}**.`, allowedMentions: MENTIONS_NONE });
  },

  async unpermnick(ctx) {
    const { interaction, options, guild } = ctx;
    if (await deny(ctx)) return;
    const alvo = options.getUser('usuario');
    if (!state.permNicks[guild.id]?.[alvo.id]) return interaction.reply(eph('ℹ️ O apelido desse membro não está travado.'));
    delete state.permNicks[guild.id][alvo.id];
    stateStore.save();
    await interaction.reply({ content: `🔓 Apelido de ${alvo.tag} destravado.` });
  },

  async censura(ctx) {
    const { interaction, options, guild } = ctx;
    if (await deny(ctx)) return;
    const acao = options.getString('acao');
    const palavra = options.getString('palavra')?.trim();
    const data = censuraStore.data;
    const lista = (data[guild.id] ??= []);

    if (acao === 'list') {
      if (lista.length === 0) return interaction.reply(eph('🛡️ Nenhuma palavra censurada.'));
      return interaction.reply(eph(truncate(`🛡️ **Censuradas:**\n${lista.join(', ')}`, 1990)));
    }
    if (!palavra) return interaction.reply(eph('❌ Indica a palavra.'));

    if (acao === 'add') {
      if (!lista.some((p) => normalize(p) === normalize(palavra))) lista.push(palavra);
      censuraStore.save();
      return interaction.reply(eph(`✅ Palavra \`${palavra}\` censurada.`));
    }
    if (acao === 'remove') {
      data[guild.id] = lista.filter((p) => normalize(p) !== normalize(palavra));
      censuraStore.save();
      return interaction.reply(eph(`✅ Palavra \`${palavra}\` removida da censura.`));
    }
  },

  async setverify(ctx) {
    const { interaction, options, guild } = ctx;
    if (await deny(ctx, null, '❌ Apenas administradores.')) return;
    const canal = options.getChannel('canal');
    const cargo = options.getRole('cargo');
    if (cargo.id === guild.id || cargo.managed || !cargo.editable) {
      return interaction.reply(eph('❌ Não consigo atribuir esse cargo (está acima do meu cargo ou é gerido por uma integração).'));
    }
    try {
      await sendVerifyPanel(canal, cargo);
    } catch (_) {
      return interaction.reply(eph('❌ Não consegui enviar o painel nesse canal. Verifica as minhas permissões.'));
    }
    ensureGuildConfig(guild.id).verifyRole = cargo.id;
    saveConfig();
    await interaction.reply(eph(`✅ Painel de verificação enviado em <#${canal.id}>.`));
  },

  async setautorole(ctx) {
    const { interaction, options, guild } = ctx;
    if (await deny(ctx, null, '❌ Apenas administradores.')) return;
    const cargo = options.getRole('cargo');
    if (cargo.id === guild.id || cargo.managed || !cargo.editable) {
      return interaction.reply(eph('❌ Não consigo atribuir esse cargo (está acima do meu cargo ou é gerido por uma integração).'));
    }
    ensureGuildConfig(guild.id).autoRole = cargo.id;
    saveConfig();
    await interaction.reply({ content: `✅ Novos membros vão receber o cargo <@&${cargo.id}>.`, flags: EPHEMERAL, allowedMentions: MENTIONS_NONE });
  },

  async delautorole(ctx) {
    const { interaction, guild } = ctx;
    if (await deny(ctx, null, '❌ Apenas administradores.')) return;
    const cfg = ensureGuildConfig(guild.id);
    if (!cfg.autoRole) return interaction.reply(eph('ℹ️ Não há cargo automático configurado.'));
    delete cfg.autoRole;
    saveConfig();
    await interaction.reply(eph('✅ Cargo automático removido.'));
  }
};

for (const name of Object.keys(CHANNEL_KEYS)) COMMANDS[name] = setChannelCommand(name);

const handledCommands = Object.keys(COMMANDS);

async function handleCommand(interaction) {
  if (!Object.hasOwn(COMMANDS, interaction.commandName)) return;
  if (!interaction.guild) return interaction.reply(eph(GUILD_ONLY));

  const guild = interaction.guild;
  const channel = interaction.channel ?? await guild.channels.fetch(interaction.channelId).catch(() => null);
  await COMMANDS[interaction.commandName]({
    interaction,
    options: interaction.options,
    member: interaction.member,
    guild,
    channel,
    guildConfig: getGuildConfig(guild.id)
  });
}

/* ============================================================
 *  BOTÕES / MODAIS
 * ============================================================ */
async function handleButton(interaction) {
  const id = interaction.customId;

  const ownIds = ['verify_btn', 'btn_abrir_sugestao', 'create_ticket_duvida', 'create_ticket_denuncia', 'claim_ticket', 'close_ticket'];
  if (!ownIds.includes(id) && !id.startsWith('rate_') && !id.startsWith('ticket:')) return;
  if (!interaction.guild) return interaction.reply(eph(GUILD_ONLY));

  if (id === 'verify_btn') {
    const roleId = getGuildConfig(interaction.guild.id).verifyRole;
    if (!roleId) return interaction.reply(eph('❌ Cargo de verificação não configurado.'));
    if (interaction.member.roles.cache.has(roleId)) return interaction.reply(eph('✅ Já estás verificado!'));
    try {
      await interaction.member.roles.add(roleId);
      return interaction.reply(eph('✅ Verificado com sucesso!'));
    } catch (_) {
      return interaction.reply(eph('❌ Erro ao atribuir cargo.'));
    }
  }

  if (id === 'btn_abrir_sugestao') {
    const modal = new ModalBuilder().setCustomId('modal_sugestao').setTitle('Enviar Sugestão');
    const input = new TextInputBuilder()
      .setCustomId('input_sugestao')
      .setLabel('O que deseja sugerir?')
      .setStyle(TextInputStyle.Paragraph)
      .setPlaceholder('Escreve a tua ideia aqui...')
      .setRequired(true)
      .setMinLength(5)
      .setMaxLength(1500);
    modal.addComponents(new ActionRowBuilder().addComponents(input));
    return interaction.showModal(modal);
  }

  if (id === 'create_ticket_duvida' || id === 'ticket:create:duvida') return createTicket(interaction, 'duvida');
  if (id === 'create_ticket_denuncia' || id === 'ticket:create:denuncia') return createTicket(interaction, 'denuncia');

  if (id === 'claim_ticket' || id === 'ticket:claim') {
    const meta = parseTicketTopic(interaction.channel);
    if (!meta) return interaction.reply(eph('❌ Este não é um canal de ticket.'));
    if (!isStaff(interaction.member, getGuildConfig(interaction.guild.id))) {
      return interaction.reply(eph('❌ Apenas a staff pode assumir tickets.'));
    }
    if (meta.status === 'closed') return interaction.reply(eph('⚠️ Este ticket já foi fechado.'));

    const record = getTicketRecord(interaction.guild.id, interaction.channel.id);
    if (record?.claimedBy && record.claimedBy !== interaction.user.id) {
      return interaction.reply(eph(`ℹ️ Este atendimento já foi assumido por <@${record.claimedBy}>.`));
    }
    if (record) {
      record.claimedBy = interaction.user.id;
      ticketStore.save();
    }

    const rows = interaction.message.components.map((row) => ActionRowBuilder.from(row));
    for (const row of rows) {
      for (const comp of row.components) {
        if (['claim_ticket', 'ticket:claim'].includes(comp.data.custom_id)) {
          comp.setDisabled(true).setLabel(truncate(`Assumido por ${interaction.user.username}`, 80));
        }
      }
    }
    await interaction.update({ components: rows });
    return interaction.followUp({ content: `✅ Atendimento assumido por <@${interaction.user.id}>.`, allowedMentions: { users: [interaction.user.id] } });
  }

  if (id === 'close_ticket' || id === 'ticket:close') return closeTicket(interaction);

  if (id.startsWith('rate_') || id.startsWith('ticket:rate:')) {
    const meta = parseTicketTopic(interaction.channel);
    if (!meta) return interaction.reply(eph('❌ Este não é um canal de ticket.'));
    if (!meta.creatorId || meta.creatorId !== interaction.user.id) {
      return interaction.reply(eph('❌ Somente quem abriu o ticket pode avaliar o atendimento.'));
    }
    const nota = id.startsWith('ticket:rate:') ? id.split(':')[2] : id.split('_')[1];
    if (!/^[1-5]$/.test(nota)) return interaction.reply(eph('❌ Avaliação inválida.'));

    const record = getTicketRecord(interaction.guild.id, interaction.channel.id);
    if (record) record.rating = Number(nota);
    state.ratings[interaction.channel.id] = nota;
    ticketStore.save();
    stateStore.save();
    return interaction.reply(eph(`✅ Atendimento avaliado com **${nota} estrela(s)**.`));
  }
}

async function handleModal(interaction) {
  if (interaction.customId !== 'modal_sugestao') return;
  if (!interaction.guild) return interaction.reply(eph(GUILD_ONLY));
  const texto = interaction.fields.getTextInputValue('input_sugestao');
  const embed = new EmbedBuilder().setColor(0xFFA500).setTitle('💡 Nova Sugestão').setDescription(texto).setFooter({ text: interaction.user.tag }).setTimestamp();
  const msg = await sendLog(interaction.guild, 'sugestao', embed);
  if (msg) {
    await msg.react('👍').catch(() => {});
    await msg.react('👎').catch(() => {});
  }
  return interaction.reply(eph('✅ Sugestão enviada com sucesso!'));
}

async function handleInteraction(interaction) {
  try {
    if (interaction.isButton()) return await handleButton(interaction);
    if (interaction.isModalSubmit()) return await handleModal(interaction);
    if (interaction.isChatInputCommand()) return await handleCommand(interaction);
  } catch (err) {
    console.error('[interação/ticket]', err);
    try { const aviso = describeError(err); if (aviso) await respond(interaction, eph(aviso)); } catch (_) { /* ignora */ }
  }
}

/* ============================================================
 *  ENTRADA / SAÍDA / APELIDO TRAVADO
 * ============================================================ */
async function handleGuildMemberAdd(member) {
  try {
    const conf = getGuildConfig(member.guild.id);

    if (conf.autoRole) {
      await member.roles.add(conf.autoRole).catch((err) => console.error('[autorole]', err.message));
    }
    const fixo = state.permNicks[member.guild.id]?.[member.id];
    if (fixo) await member.setNickname(fixo, 'PermNick Active').catch(() => {});

    if (!conf.welcomeChannel || !logEnabled(member.guild.id, 'entradas')) return;
    const channel = member.guild.channels.cache.get(conf.welcomeChannel);
    if (!channel) return;
    const embed = new EmbedBuilder()
      .setColor(0x00FF00)
      .setTitle('👋 Novo Membro!')
      .setDescription(`Bem-vindo(a), <@${member.id}>!\nAgora somos **${member.guild.memberCount}** membros.`)
      .setThumbnail(member.user.displayAvatarURL({ size: 256 }))
      .setTimestamp();
    await channel.send({ embeds: [embed], allowedMentions: { users: [member.id] } });
  } catch (err) {
    console.error('[memberAdd]', err.message);
  }
}

async function handleGuildMemberRemove(member) {
  try {
    const conf = getGuildConfig(member.guild.id);
    if (!conf.welcomeChannel || !logEnabled(member.guild.id, 'saidas')) return;
    const channel = member.guild.channels.cache.get(conf.welcomeChannel);
    if (!channel) return;
    const nome = member.user?.tag || 'Um membro';
    const embed = new EmbedBuilder().setColor(0xFF0000).setTitle('🚪 Membro Saiu').setDescription(`**${nome}** saiu.`).setTimestamp();
    await channel.send({ embeds: [embed] });
  } catch (err) {
    console.error('[memberRemove]', err.message);
  }
}

/** Procura no registro de auditoria quem executou a ação (precisa da permissão "Ver Registro de Auditoria"). */
async function findExecutor(guild, tipo, alvoId) {
  try {
    const logs = await guild.fetchAuditLogs({ type: tipo, limit: 6 });
    const e = logs.entries.find((x) => x.target?.id === alvoId && Date.now() - x.createdTimestamp < 20000);
    return e ? { executor: e.executor, motivo: e.reason } : null;
  } catch (_) { return null; }
}

async function handleGuildBanAdd(ban) {
  try {
    const guild = ban.guild;
    if (!logEnabled(guild.id, 'punicoes') || wasBotAction('ban', guild.id, ban.user.id)) return;
    const info = await findExecutor(guild, AuditLogEvent.MemberBanAdd, ban.user.id);
    await sendLog(guild, 'punicao', punishEmbed('🔨 Ban (feito direto no Discord)', 0xC0392B, ban.user, info?.executor, ban.reason || info?.motivo || 'Sem motivo informado'));
  } catch (err) { console.error('[banAdd]', err.message); }
}

async function handleGuildBanRemove(ban) {
  try {
    const guild = ban.guild;
    if (!logEnabled(guild.id, 'punicoes') || wasBotAction('unban', guild.id, ban.user.id)) return;
    const info = await findExecutor(guild, AuditLogEvent.MemberBanRemove, ban.user.id);
    await sendLog(guild, 'punicao', punishEmbed('♻️ Unban (feito direto no Discord)', 0x2ECC71, ban.user, info?.executor, info?.motivo || 'Sem motivo informado'));
  } catch (err) { console.error('[banRemove]', err.message); }
}

async function logTimeoutChange(oldMember, newMember) {
  if (oldMember.partial) return;
  const antes = oldMember.communicationDisabledUntilTimestamp || 0;
  const depois = newMember.communicationDisabledUntilTimestamp || 0;
  if (antes === depois) return;
  const guild = newMember.guild;
  const agora = Date.now();
  const silenciou = depois > agora;
  const tirou = !depois && antes > agora;
  if (!silenciou && !tirou) return;
  if (!logEnabled(guild.id, 'punicoes') || wasBotAction(silenciou ? 'timeout' : 'untimeout', guild.id, newMember.id)) return;

  const info = await findExecutor(guild, AuditLogEvent.MemberUpdate, newMember.id);
  const embed = silenciou
    ? punishEmbed('🔇 Silenciado (feito direto no Discord)', 0xF1C40F, newMember.user, info?.executor, info?.motivo || 'Sem motivo informado', [{ name: '⏳ Até', value: `<t:${unix(depois)}:f>`, inline: true }])
    : punishEmbed('🔊 Silêncio removido (feito direto no Discord)', 0x2ECC71, newMember.user, info?.executor, info?.motivo || 'Sem motivo informado');
  await sendLog(guild, 'punicao', embed);
}

async function handleGuildMemberUpdate(oldMember, newMember) {
  try {
    await logTimeoutChange(oldMember, newMember).catch((err) => console.error('[timeoutLog]', err.message));
    const fixo = state.permNicks[newMember.guild.id]?.[newMember.id];
    if (fixo && newMember.nickname !== fixo) {
      await newMember.setNickname(fixo, 'PermNick Active');
    }
  } catch (_) { /* sem permissão / hierarquia */ }
}

/* ============================================================
 *  AGENDADOR (ban temporário e sorteios) — sobrevive a reinícios
 * ============================================================ */
async function finishGiveaway(client, g) {
  const channel = await client.channels.fetch(g.channelId).catch(() => null);
  if (!channel?.isTextBased()) return;
  const msg = await channel.messages.fetch(g.messageId).catch(() => null);
  if (!msg) return;

  const reaction = msg.reactions.cache.get(GIVEAWAY_EMOJI);
  const users = reaction ? await reaction.users.fetch().catch(() => null) : null;
  const participantes = users ? [...users.values()].filter((u) => !u.bot) : [];
  const vencedor = participantes.length ? participantes[Math.floor(Math.random() * participantes.length)] : null;

  await msg.edit({ embeds: [giveawayEmbed(g.premio, g.endsAt, g.hostId, vencedor?.id ?? null, true)] }).catch(() => {});
  await channel.send({
    content: vencedor ? `🎉 Parabéns <@${vencedor.id}>! Ganhaste **${g.premio}**!` : `😕 Ninguém participou do sorteio de **${g.premio}**.`,
    allowedMentions: { users: vencedor ? [vencedor.id] : [] }
  }).catch(() => {});
}

let schedulerTimer = null;
let tickRunning = false;

async function schedulerTick(client) {
  if (tickRunning) return;
  tickRunning = true;
  try {
    const now = Date.now();

    const bansVencidos = state.tempBans.filter((t) => t.expiresAt <= now);
    if (bansVencidos.length) {
      for (const t of bansVencidos) {
        const guild = client.guilds.cache.get(t.guildId);
        if (guild) await guild.members.unban(t.userId, 'Fim do ban temporário').catch(() => {});
      }
      state.tempBans = state.tempBans.filter((t) => t.expiresAt > now);
      stateStore.save();
    }

    for (const [chave, horarios] of floodMap) {
      if (!horarios.length || now - horarios[horarios.length - 1] > 10000) floodMap.delete(chave);
    }

    const sorteiosVencidos = state.giveaways.filter((g) => g.endsAt <= now);
    if (sorteiosVencidos.length) {
      state.giveaways = state.giveaways.filter((g) => g.endsAt > now);
      stateStore.save();
      for (const g of sorteiosVencidos) await finishGiveaway(client, g).catch((err) => console.error('[sorteio]', err.message));
    }
  } catch (err) {
    console.error('[agendador]', err);
  } finally {
    tickRunning = false;
  }
}

function startScheduler(client) {
  if (schedulerTimer) return;
  schedulerTimer = setInterval(() => schedulerTick(client), 15000);
  schedulerTick(client);
}

module.exports = {
  allSlashCommands,
  handledCommands,
  handleInteraction,
  handleMessage,
  handleMessageDelete,
  handleMessageDeleteBulk,
  handleGuildMemberAdd,
  handleGuildMemberRemove,
  handleGuildMemberUpdate,
  sendTicketPanel,
  startScheduler,
  getConfig,
  getGuildConfig,
  ensureGuildConfig,
  saveConfig,
  hasAdminPermission,
  isStaff,
  logEnabled,
  handleMessageUpdate,
  handleGuildBanAdd,
  handleGuildBanRemove
};
