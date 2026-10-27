'use strict';

/**
 * Permissões AUTOMÁTICAS: cada comando exige a permissão do Discord que faz sentido para ele.
 *   • Administrador  → usa tudo.
 *   • Só "Banir Membros" + "Silenciar Membros" → usa apenas /ban, /unban, /mute, /unmute, /warn...
 *   • Sem permissão especial → só os comandos livres (economia, diversão, níveis...).
 * Ninguém precisa cadastrar cargo nenhum. (/setadminrole e /setadminuser continuam existindo
 * como um atalho opcional de "acesso total", mas não são mais necessários.)
 *
 * Comandos que não aparecem em RULES são livres para todos.
 */

const { PermissionFlagsBits, PermissionsBitField } = require('discord.js');
const { eph } = require('./utils');

const OWNER_ID = process.env.CREATOR_ID || '';
const OWNER = 'OWNER';

const LABELS = {
  Administrator: 'Administrador',
  BanMembers: 'Banir Membros',
  KickMembers: 'Expulsar Membros',
  ModerateMembers: 'Silenciar Membros',
  ManageMessages: 'Gerenciar Mensagens',
  ManageChannels: 'Gerenciar Canais',
  ManageRoles: 'Gerenciar Cargos',
  ManageNicknames: 'Gerenciar Apelidos',
  ManageGuild: 'Gerenciar Servidor',
  ManageGuildExpressions: 'Gerenciar Expressões',
  [OWNER]: 'dono do bot'
};

const RULES = {
  // Punições
  ban: 'BanMembers', unban: 'BanMembers',
  kick: 'KickMembers',
  mute: 'ModerateMembers', unmute: 'ModerateMembers', warn: 'ModerateMembers', clearwarns: 'ModerateMembers', calado: 'ModerateMembers',
  // Mensagens
  clear: 'ManageMessages', censura: 'ManageMessages', say: 'ManageMessages', embed: 'ManageMessages', sorteio: 'ManageMessages',
  // Canais
  lock: 'ManageChannels', unlock: 'ManageChannels', slowmode: 'ManageChannels',
  // Cargos e apelidos
  setcargo: 'ManageRoles', 'painel-cargos': 'ManageRoles', cargosnivel: 'ManageRoles',
  nick: 'ManageNicknames', permnick: 'ManageNicknames', unpermnick: 'ManageNicknames',
  // Configuração do servidor
  automod: 'ManageGuild', ticket: 'ManageGuild', 'painel-sugestao': 'ManageGuild', ia: 'ManageGuild', logs: 'ManageGuild',
  setwelcome: 'ManageGuild', setlogs: 'ManageGuild', setdenuncias: 'ManageGuild', setduvidas: 'ManageGuild', setpunicoes: 'ManageGuild',
  setmsgdelete: 'ManageGuild', setsuggestion: 'ManageGuild', setnivel: 'ManageGuild', setverify: 'ManageGuild',
  setautorole: 'ManageGuild', delautorole: 'ManageGuild',
  // Dar "acesso total" a outros é coisa só de Administrador
  setadminrole: 'Administrator', setadminuser: 'Administrator', deladminrole: 'Administrator', deladminuser: 'Administrator',
  // Emojis e figurinhas
  criaremoji: 'ManageGuildExpressions', criarfigurinha: 'ManageGuildExpressions',
  // Só o dono do bot (a economia é global entre servidores, então ninguém mais pode criar dinheiro)
  addmoney: OWNER, removemoney: OWNER, backup: OWNER
};

/* ============================================================
 *  CHECAGENS
 * ============================================================ */
const guildConfigOf = (guildId) => {
  try { return require('./ticket').getGuildConfig(guildId); } catch (_) { return {}; } // require tardio: evita ciclo
};

/** member.permissions.has() que não quebra se o nome da permissão não existir nesta versão do discord.js. */
function has(member, flag) {
  try {
    return !!member?.permissions?.has(flag);
  } catch (_) {
    if (flag === 'ManageGuildExpressions') {
      try { return !!member.permissions.has('ManageEmojisAndStickers'); } catch (_e) { return false; }
    }
    return false;
  }
}

const isOwner = (userId) => !!OWNER_ID && userId === OWNER_ID;

/** Cargo/usuário cadastrado com /setadminrole /setadminuser (atalho opcional de acesso total). */
function isBotAdmin(member, cfg = {}) {
  if (!member) return false;
  if (cfg.adminUsers?.includes(member.id)) return true;
  return !!cfg.adminRoles?.some((roleId) => member.roles?.cache?.has(roleId));
}

/** Administrador do Discord ou "admin do bot": pode tudo (menos o que é exclusivo do dono). */
const hasFullAccess = (member, cfg = {}) => has(member, 'Administrator') || isBotAdmin(member, cfg);

/** "Staff": quem tem alguma permissão de moderação (usado em tickets, automod, etc.). */
function isStaff(member, cfg = {}) {
  if (!member) return false;
  return hasFullAccess(member, cfg)
    || ['ManageMessages', 'ModerateMembers', 'ManageGuild', 'BanMembers', 'KickMembers'].some((p) => has(member, p));
}

/** Qual permissão este comando exige? undefined = não está em RULES; null = livre neste caso. */
function requirementFor(interaction) {
  const name = interaction.commandName;
  const o = interaction.options;
  if (name === 'warnings') return o?.getUser?.('usuario')?.id === interaction.user.id ? null : 'ModerateMembers'; // ver os próprios avisos é livre
  if (name === 'cargosnivel') return o?.getString?.('acao') === 'listar' ? null : 'ManageRoles';
  return RULES[name];
}

/**
 * Devolve a mensagem de erro (string) se o usuário NÃO pode usar o comando, ou null se pode.
 * strict=true: comando que não está em RULES vira "só administrador" (usado dentro dos handlers,
 * assim um comando esquecido nunca fica aberto por engano).
 */
function checkAccess(interaction, { strict = false } = {}) {
  let need = requirementFor(interaction);
  if (need === undefined) need = strict ? 'Administrator' : null;
  if (need === null) return null;

  if (need === OWNER) {
    if (isOwner(interaction.user.id)) return null;
    return OWNER_ID
      ? '❌ Este comando é exclusivo do dono do bot.'
      : '❌ Este comando é exclusivo do dono do bot (defina a variável `CREATOR_ID` no Render).';
  }

  if (!interaction.guild) return null; // em DM o próprio comando avisa que só funciona em servidor
  const member = interaction.member;
  const negado = `❌ Você precisa da permissão **${LABELS[need] || need}** para usar este comando.`;

  if (need === 'Administrator') return has(member, 'Administrator') ? null : negado; // nem o "admin do bot" pode dar acesso total a outros
  if (hasFullAccess(member, guildConfigOf(interaction.guild.id))) return null;
  return has(member, need) ? null : negado;
}

/** Responde com o erro e devolve true se foi bloqueado. */
async function denyIfNotAllowed(interaction, opts) {
  const erro = checkAccess(interaction, opts);
  if (!erro) return false;
  try { await interaction.reply(eph(erro)); } catch (_) { /* já respondida */ }
  return true;
}

/** Texto curto para a ajuda: "🔒 Banir Membros" (ou '' se livre). */
function lockLabel(commandName) {
  const need = RULES[commandName];
  return need ? `🔒 ${LABELS[need] || need}` : '';
}

/* ============================================================
 *  LINK DE CONVITE (para qualquer um adicionar o bot no seu servidor)
 * ============================================================ */
const INVITE_PERMISSIONS = [
  'ViewChannel', 'SendMessages', 'SendMessagesInThreads', 'EmbedLinks', 'AttachFiles', 'ReadMessageHistory',
  'AddReactions', 'UseExternalEmojis', 'UseExternalStickers', 'ManageMessages', 'ManageChannels', 'ManageRoles',
  'ManageNicknames', 'KickMembers', 'BanMembers', 'ModerateMembers', 'ManageGuildExpressions'
];

function inviteUrl(client) {
  const id = client?.application?.id || client?.user?.id;
  if (!id) return null;
  const bits = new PermissionsBitField();
  for (const p of INVITE_PERMISSIONS) {
    try { bits.add(p); } catch (_) { if (p === 'ManageGuildExpressions') { try { bits.add('ManageEmojisAndStickers'); } catch (_e) { /* ignora */ } } }
  }
  return `https://discord.com/oauth2/authorize?client_id=${id}&permissions=${bits.bitfield.toString()}&scope=bot%20applications.commands`;
}

module.exports = {
  RULES, LABELS, OWNER_ID, isOwner, has, isBotAdmin, hasFullAccess, isStaff,
  checkAccess, denyIfNotAllowed, lockLabel, inviteUrl, PermissionFlagsBits
};
