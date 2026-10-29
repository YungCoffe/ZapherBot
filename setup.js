'use strict';

/**
 * ?setup  (só com prefixo, só Administrador)
 * Monta o servidor inteiro de uma vez e configura o bot:
 *   • Cargo "Staff Zapher" com as permissões de moderação (e já vira a equipe dos tickets)
 *   • Categorias e canais: logs, punições, mensagens apagadas, denúncias, dúvidas (privados);
 *     sugestões, boas-vindas, níveis, abrir-ticket, cargo-personalizado (públicos, só leitura); tickets; backup
 *   • Configura todos os canais de log/boas-vindas/níveis/tickets no bot
 *   • Cria os cargos de nível coloridos
 *   • Envia os painéis (tickets, sugestões, cargo personalizado)
 *   • Cria o canal de backup e já envia a primeira cópia
 *
 * Pode ser executado quantas vezes quiser: tudo que já existe é REAPROVEITADO (nada é duplicado).
 */

const { ChannelType, PermissionFlagsBits: P, EmbedBuilder, SlashCommandBuilder } = require('discord.js');
const { eph, truncate, respond, describeError } = require('./utils');
const { checkAccess } = require('./perms');
const { getGuildConfig, ensureGuildConfig, saveConfig, sendSuggestionPanel } = require('./ticket');
const tickets = require('./tickets');
const rolesModule = require('./roles');
const levels = require('./levels');
const backup = require('./backup');

const MARK = 'ZAPHER-SETUP';
const STAFF_ROLE_NAME = 'Staff Zapher';

const setupSlashCommands = [
  new SlashCommandBuilder().setName('setup').setDescription('Cria canais, cargos, logs e painéis e configura tudo de uma vez (admin)')
];
const prefixOnlyNames = ['setup'];

const STAFF_PERMS = [
  P.ViewChannel, P.SendMessages, P.EmbedLinks, P.AttachFiles, P.ReadMessageHistory, P.AddReactions, P.UseExternalEmojis,
  P.Connect, P.Speak, P.CreateInstantInvite, P.KickMembers, P.BanMembers, P.ModerateMembers, P.ManageMessages,
  P.ManageNicknames, P.ViewAuditLog, P.MuteMembers, P.DeafenMembers, P.MoveMembers, P.ManageThreads
];
const BOT_PERMS = [P.ViewChannel, P.SendMessages, P.EmbedLinks, P.AttachFiles, P.ReadMessageHistory, P.AddReactions, P.ManageMessages];

/** key = identificação interna; cfg = chave de configuração do bot; grupo = categoria; tipo = quem pode ver */
const CHANNELS = [
  { key: 'logs', nome: 'logs-gerais', cfg: 'logsChannel', grupo: 'staff', tipo: 'privado', desc: 'Logs gerais do bot' },
  { key: 'punicoes', nome: 'punicoes', cfg: 'punicoesChannel', grupo: 'staff', tipo: 'privado', desc: 'Bans, kicks, silenciamentos e avisos' },
  { key: 'apagadas', nome: 'mensagens-apagadas', cfg: 'msgDeleteChannel', grupo: 'staff', tipo: 'privado', desc: 'Mensagens apagadas e editadas' },
  { key: 'denuncias', nome: 'denuncias', cfg: 'denunciasChannel', grupo: 'staff', tipo: 'privado', desc: 'Denúncias e transcripts de tickets de denúncia' },
  { key: 'duvidas', nome: 'duvidas', cfg: 'duvidasChannel', grupo: 'staff', tipo: 'privado', desc: 'Transcripts de tickets de dúvida' },
  { key: 'sugestoes', nome: 'sugestoes', cfg: 'suggestionChannel', grupo: 'publico', tipo: 'leitura', painel: 'sugestao', desc: 'Sugestões da comunidade' },
  { key: 'boasvindas', nome: 'boas-vindas', cfg: 'welcomeChannel', grupo: 'publico', tipo: 'leitura', desc: 'Boas-vindas aos novos membros' },
  { key: 'niveis', nome: 'niveis', cfg: 'levelChannel', grupo: 'publico', tipo: 'leitura', desc: 'Avisos de subida de nível' },
  { key: 'ticket', nome: 'abrir-ticket', cfg: null, grupo: 'publico', tipo: 'leitura', painel: 'ticket', desc: 'Abra um ticket de suporte aqui' },
  { key: 'cargos', nome: 'cargo-personalizado', cfg: null, grupo: 'publico', tipo: 'leitura', painel: 'cargos', desc: 'Crie o seu cargo personalizado' }
];
const CATEGORIES = {
  staff: { nome: '🛡️ STAFF ZAPHER', privado: true },
  publico: { nome: '🤖 ZAPHER', privado: false },
  tickets: { nome: '🎫 TICKETS', privado: true }
};

const PANELS = {
  sugestao: { titulo: '💡 Central de Sugestões', enviar: (c) => sendSuggestionPanel(c) },
  ticket: { titulo: '🎫 Central de Atendimento', enviar: (c) => c.send(tickets.panelMessage()) },
  cargos: { titulo: '🎨 Cargo Personalizado', enviar: (c) => c.send(rolesModule.panelMessage()) }
};

/* ============================================================
 *  PEÇAS (cada uma reaproveita o que já existe)
 * ============================================================ */
async function ensureStaffRole(guild, cfg, rel) {
  let role = cfg.setupStaffRole && guild.roles.cache.get(cfg.setupStaffRole);
  role ||= guild.roles.cache.find((r) => r.name === STAFF_ROLE_NAME);
  if (role) { rel.reaproveitados.push(`Cargo <@&${role.id}>`); }
  else {
    role = await guild.roles.create({
      name: STAFF_ROLE_NAME, color: 0x3498DB, hoist: true, mentionable: true, permissions: STAFF_PERMS,
      reason: 'Setup do bot: cargo da equipe'
    });
    rel.criados.push(`Cargo <@&${role.id}> (permissões de moderação, sem Administrador)`);
  }
  cfg.setupStaffRole = role.id;
  cfg.ticketStaffRoles ??= [];
  if (!cfg.ticketStaffRoles.includes(role.id)) cfg.ticketStaffRoles.push(role.id);
  return role;
}

async function ensureCategory(guild, cfg, key, staffRole, me, rel) {
  const spec = CATEGORIES[key];
  cfg.setupCats ??= {};
  let cat = cfg.setupCats[key] && guild.channels.cache.get(cfg.setupCats[key]);
  cat ||= guild.channels.cache.find((c) => c.type === ChannelType.GuildCategory && c.name === spec.nome);
  if (cat) { rel.reaproveitados.push(`Categoria **${cat.name}**`); }
  else {
    const overwrites = spec.privado
      ? [
        { id: guild.roles.everyone.id, deny: [P.ViewChannel] },
        { id: me.id, allow: BOT_PERMS },
        { id: staffRole.id, allow: [P.ViewChannel, P.ReadMessageHistory] }
      ]
      : [];
    cat = await guild.channels.create({ name: spec.nome, type: ChannelType.GuildCategory, permissionOverwrites: overwrites, reason: 'Setup do bot' });
    rel.criados.push(`Categoria **${cat.name}**`);
  }
  cfg.setupCats[key] = cat.id;
  return cat;
}

function overwritesFor(spec, guild, staffRole, me) {
  if (spec.tipo === 'privado') {
    return [
      { id: guild.roles.everyone.id, deny: [P.ViewChannel] },
      { id: me.id, allow: BOT_PERMS },
      { id: staffRole.id, allow: [P.ViewChannel, P.ReadMessageHistory] }
    ];
  }
  // público e somente leitura (pode reagir, não pode escrever; os botões dos painéis funcionam normalmente)
  return [
    { id: guild.roles.everyone.id, allow: [P.ViewChannel, P.ReadMessageHistory, P.AddReactions], deny: [P.SendMessages, P.CreatePublicThreads, P.CreatePrivateThreads] },
    { id: me.id, allow: BOT_PERMS },
    { id: staffRole.id, allow: [P.SendMessages] }
  ];
}

async function ensureChannel(guild, cfg, spec, categoria, staffRole, me, rel) {
  let canal = spec.cfg && cfg[spec.cfg] && guild.channels.cache.get(cfg[spec.cfg]);
  canal ||= guild.channels.cache.find((c) => c.type === ChannelType.GuildText && c.topic?.includes(`${MARK}:${spec.key}`));
  canal ||= guild.channels.cache.find((c) => c.type === ChannelType.GuildText && c.name === spec.nome && c.parentId === categoria.id);
  if (canal) { rel.reaproveitados.push(`Canal <#${canal.id}>`); }
  else {
    canal = await guild.channels.create({
      name: spec.nome, type: ChannelType.GuildText, parent: categoria.id,
      topic: `${spec.desc} • ${MARK}:${spec.key}`, permissionOverwrites: overwritesFor(spec, guild, staffRole, me), reason: 'Setup do bot'
    });
    rel.criados.push(`Canal <#${canal.id}>`);
  }
  if (spec.cfg) cfg[spec.cfg] = canal.id;
  return canal;
}

/** Envia o painel só se ainda não houver um (olha as últimas mensagens do canal). */
async function ensurePanel(canal, kind, botId, rel) {
  const p = PANELS[kind];
  const msgs = await canal.messages.fetch({ limit: 30 }).catch(() => null);
  const jaTem = msgs && [...msgs.values()].some((m) => m.author.id === botId && m.embeds?.[0]?.title === p.titulo);
  if (jaTem) { rel.reaproveitados.push(`Painel em <#${canal.id}>`); return; }
  await p.enviar(canal);
  rel.criados.push(`Painel em <#${canal.id}>`);
}

/* ============================================================
 *  COMANDO
 * ============================================================ */
const field = (nome, linhas) => ({ name: nome, value: truncate(linhas.join('\n') || '—', 1000) });

async function runSetup(interaction) {
  const negado = checkAccess(interaction, { strict: true });
  if (negado) return interaction.reply(eph(negado));
  if (!interaction.guild) return interaction.reply(eph('❌ Este comando só funciona dentro de um servidor.'));

  const { guild, client } = interaction;
  const me = guild.members.me;
  const faltando = ['ManageChannels', 'ManageRoles', 'ViewChannel', 'SendMessages', 'EmbedLinks'].filter((p) => !me?.permissions.has(p));
  if (faltando.length) return interaction.reply(eph(`❌ Eu preciso destas permissões para montar o servidor: **${faltando.join(', ')}**. Dê ao meu cargo (ou Administrador) e rode de novo.`));

  await interaction.deferReply();
  const cfg = ensureGuildConfig(guild.id);
  const rel = { criados: [], reaproveitados: [], falhas: [], config: [] };
  const passo = async (nome, fn) => { try { return await fn(); } catch (err) { console.error(`[setup] ${nome}:`, err); rel.falhas.push(`${nome}: ${describeError(err)?.replace(/^❌ /, '') || err.message}`); return null; } };

  const staffRole = await passo('Cargo da equipe', () => ensureStaffRole(guild, cfg, rel));
  if (!staffRole) return interaction.editReply({ content: `❌ Não consegui criar o cargo da equipe, então parei por aqui.\n${rel.falhas.join('\n')}` });

  const cats = {};
  for (const key of Object.keys(CATEGORIES)) cats[key] = await passo(`Categoria ${CATEGORIES[key].nome}`, () => ensureCategory(guild, cfg, key, staffRole, me, rel));

  const canais = {};
  for (const spec of CHANNELS) {
    if (!cats[spec.grupo]) continue;
    canais[spec.key] = await passo(`Canal #${spec.nome}`, () => ensureChannel(guild, cfg, spec, cats[spec.grupo], staffRole, me, rel));
  }

  if (cats.tickets) { cfg.ticketCategory = cats.tickets.id; rel.config.push('Tickets serão criados na categoria 🎫 TICKETS'); }
  for (const spec of CHANNELS) if (spec.cfg && canais[spec.key]) rel.config.push(`${spec.cfg} → <#${canais[spec.key].id}>`);
  cfg.logToggles ??= {};
  saveConfig();

  // painéis
  for (const spec of CHANNELS) {
    if (spec.painel && canais[spec.key]) await passo(`Painel ${spec.painel}`, () => ensurePanel(canais[spec.key], spec.painel, client.user.id, rel));
  }

  // cargos de nível coloridos
  await passo('Cargos de nível', async () => {
    const r = await levels.ensureLevelRoles(guild, staffRole);
    (r.criados ? rel.criados : rel.reaproveitados).push(`Cargos de nível (${r.criados} criados, ${r.existentes} já existiam)`);
  });

  // mensagem de teste nos logs
  for (const spec of CHANNELS.filter((c) => c.tipo === 'privado')) {
    const canal = canais[spec.key];
    if (canal && !rel.reaproveitados.includes(`Canal <#${canal.id}>`)) {
      await canal.send({ embeds: [new EmbedBuilder().setColor(0x2ECC71).setTitle('✅ Canal configurado').setDescription(`${spec.desc}.\nOs avisos do bot vão aparecer aqui.`)] }).catch(() => {});
    }
  }

  // backup: UM canal só (reaproveita se já existir) + primeira cópia
  let backupTxt = '❌ não configurado';
  await passo('Backup', async () => {
    const { canal, criado } = await backup.ensureBackupChannel(guild, client, interaction.user.id);
    (criado ? rel.criados : rel.reaproveitados).push(`Canal de backup <#${canal.id}>`);
    const r = await backup.pushBackup(client, { force: true });
    backupTxt = r.ok ? `✅ cópia enviada para <#${canal.id}>` : `⚠️ canal pronto (<#${canal.id}>), mas a cópia falhou: ${r.reason}`;
  });

  const embed = new EmbedBuilder().setColor(rel.falhas.length ? 0xF39C12 : 0x2ECC71)
    .setTitle(rel.falhas.length ? '⚠️ Setup concluído com avisos' : '✅ Servidor configurado!')
    .setDescription(`Pode rodar \`?setup\` de novo quando quiser: o que já existe é **reaproveitado** e nada é duplicado.`)
    .addFields(
      field(`🆕 Criado (${rel.criados.length})`, rel.criados),
      field(`♻️ Já existia (${rel.reaproveitados.length})`, rel.reaproveitados),
      field('⚙️ Configurado no bot', rel.config.slice(0, 14)),
      field('💾 Backup', [backupTxt])
    );
  if (rel.falhas.length) embed.addFields(field('⚠️ Avisos', rel.falhas));
  embed.addFields(field('👉 Próximos passos', [
    `• Dê o cargo <@&${staffRole.id}> à sua equipe (ele tem as permissões de moderação).`,
    '• Mova o meu cargo **para cima** dos cargos que eu preciso gerenciar.',
    '• `?logs` mostra e testa os logs • `?automod sim` liga o filtro de links e flood • `?help` lista tudo.'
  ]));
  return interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
}

const handledCommands = ['setup'];

async function handleSetupInteraction(interaction) {
  try {
    if (!interaction.isChatInputCommand?.() || interaction.commandName !== 'setup') return;
    await runSetup(interaction);
  } catch (err) {
    console.error('[interação/setup]', err);
    try { const aviso = describeError(err); if (aviso) await respond(interaction, eph(aviso)); } catch (_) { /* ignora */ }
  }
}

module.exports = { setupSlashCommands, prefixOnlyNames, handledCommands, handleSetupInteraction, CHANNELS, CATEGORIES };
