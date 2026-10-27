'use strict';

/**
 * Sistema de níveis: ganha XP conversando; ao subir de nível recebe bónus em ZapherCoin
 * e (se configurado) um cargo colorido que o PRÓPRIO BOT cria com /cargosnivel criar.
 */

const { EmbedBuilder, SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { JsonStore } = require('./storage');
const { eph, truncate, randInt, respond, placeRoleBelow, describeError } = require('./utils');
const { giveMoney, fmt } = require('./economy');
const { getGuildConfig, ensureGuildConfig, saveConfig, logEnabled } = require('./ticket');
const { checkAccess } = require('./perms');

/* ============================================================
 *  AJUSTES
 * ============================================================ */
const XP_COOLDOWN = 60 * 1000;   // só 1 mensagem por minuto conta para XP (evita spam)
const XP_MIN = 15;
const XP_MAX = 25;
const LEVEL_REWARD = 5000;       // bónus por nível (nível 3 = 15.000 ZapherCoin)
const MAX_SYNC_MEMBERS = 500;

/** Escada de cargos que o bot cria, com as cores que ele escolheu. */
const LEVEL_TIERS = [
  { level: 1, emoji: '🌱', nome: 'Novato', cor: 0x95A5A6 },
  { level: 5, emoji: '🔰', nome: 'Aprendiz', cor: 0x2ECC71 },
  { level: 10, emoji: '⚔️', nome: 'Veterano', cor: 0x3498DB },
  { level: 20, emoji: '🛡️', nome: 'Elite', cor: 0x9B59B6 },
  { level: 30, emoji: '🔥', nome: 'Mestre', cor: 0xE67E22 },
  { level: 50, emoji: '💎', nome: 'Lenda', cor: 0xE91E63 },
  { level: 75, emoji: '👑', nome: 'Mito', cor: 0xF1C40F },
  { level: 100, emoji: '🌌', nome: 'Imortal', cor: 0x1ABC9C }
];
const tierName = (t) => `${t.emoji} ${t.nome} · Nv ${t.level}`;

/* ============================================================
 *  DADOS
 * ============================================================ */
const levelsStore = new JsonStore('levels.json', { delay: 5000, pretty: false });
const xpLast = new Map();
const xpNeeded = (level) => 5 * level * level + 50 * level + 100;

function sortedLevels(guildId) {
  return Object.entries(levelsStore.data[guildId] || {})
    .map(([id, u]) => ({ id, level: u.level, xp: u.xp }))
    .sort((a, b) => b.level - a.level || b.xp - a.xp);
}

/* ============================================================
 *  CARGOS DE NÍVEL
 * ============================================================ */
const tiersOf = (guild) => (getGuildConfig(guild.id).levelRoles || [])
  .filter((t) => guild.roles.cache.has(t.roleId))
  .sort((a, b) => a.level - b.level);

/** Dá ao membro o cargo do maior degrau que já alcançou e tira os outros. Devolve o degrau novo (ou null). */
async function applyLevelRole(member, level) {
  const tiers = tiersOf(member.guild);
  if (!tiers.length) return null;
  const alvo = [...tiers].reverse().find((t) => t.level <= level) || null;

  const remover = tiers.filter((t) => t !== alvo && member.roles.cache.has(t.roleId)).map((t) => t.roleId);
  if (remover.length) await member.roles.remove(remover, 'Cargo de nível atualizado');
  if (alvo && !member.roles.cache.has(alvo.roleId)) {
    await member.roles.add(alvo.roleId, `Chegou ao nível ${level}`);
    return alvo;
  }
  return null;
}

/** Cria (ou reaproveita) os cargos da escada. Devolve { criados, existentes }. */
async function ensureLevelRoles(guild, anchor) {
  const cfg = ensureGuildConfig(guild.id);
  const atuais = new Map((cfg.levelRoles || []).map((t) => [t.level, t.roleId]));
  const resultado = [];
  let criados = 0;

  for (const tier of LEVEL_TIERS) {
    let role = guild.roles.cache.get(atuais.get(tier.level)) || guild.roles.cache.find((r) => r.name === tierName(tier));
    if (!role) {
      role = await guild.roles.create({
        name: tierName(tier),
        color: tier.cor,
        hoist: false,
        mentionable: false,
        reason: 'Cargos de nível (criados pelo bot)'
      });
      if (anchor) await placeRoleBelow(guild, role, anchor);
      criados++;
    }
    resultado.push({ level: tier.level, roleId: role.id });
  }
  cfg.levelRoles = resultado;
  saveConfig();
  return { criados, existentes: LEVEL_TIERS.length - criados };
}

/* ============================================================
 *  XP POR MENSAGEM
 * ============================================================ */
async function handleXp(message) {
  try {
    if (message.author.bot || !message.guild) return;
    if (message.content.trim().length < 3) return;

    const now = Date.now();
    const key = `${message.guild.id}:${message.author.id}`;
    if (now - (xpLast.get(key) || 0) < XP_COOLDOWN) return;
    xpLast.set(key, now);
    if (xpLast.size > 2000) {
      for (const [k, t] of xpLast) if (now - t > XP_COOLDOWN) xpLast.delete(k);
    }

    const guildData = (levelsStore.data[message.guild.id] ??= {});
    const user = (guildData[message.author.id] ??= { xp: 0, level: 0 });
    user.xp += randInt(XP_MIN, XP_MAX);

    let subiu = false;
    while (user.xp >= xpNeeded(user.level)) {
      user.xp -= xpNeeded(user.level);
      user.level += 1;
      subiu = true;
    }
    levelsStore.save();
    if (!subiu) return;

    const bonus = user.level * LEVEL_REWARD;
    giveMoney(message.author.id, bonus, `Bónus por subir para o nível ${user.level}`);

    let cargoNovo = null;
    try {
      const membro = message.member || await message.guild.members.fetch(message.author.id);
      cargoNovo = await applyLevelRole(membro, user.level);
    } catch (err) {
      console.error('[nível] cargo:', err.message);
    }

    // Sem barulho: sem canal próprio de níveis, só avisa nos marcos (nível 1, múltiplos de 5 ou cargo novo).
    // Desligue de vez com /logs categoria:nivel status:não
    const cfg = getGuildConfig(message.guild.id);
    if (!logEnabled(message.guild.id, 'nivel')) return;
    if (!cfg.levelChannel && !(user.level === 1 || user.level % 5 === 0 || cargoNovo)) return;
    const canal = (cfg.levelChannel && message.guild.channels.cache.get(cfg.levelChannel)) || message.channel;
    await canal.send({
      content: `🎉 <@${message.author.id}> subiu para o **nível ${user.level}**! Ganhou um bónus de **${fmt(bonus)}** ZapherCoin.${cargoNovo ? `\n🎖️ Novo cargo: <@&${cargoNovo.roleId}>` : ''}`,
      allowedMentions: { users: [message.author.id] }
    }).catch(() => {});
  } catch (err) {
    console.error('[xp]', err.message);
  }
}

/* ============================================================
 *  COMANDOS
 * ============================================================ */
const levelsSlashCommands = [
  new SlashCommandBuilder().setName('nivel').setDescription('Mostra o teu nível e XP no servidor').addUserOption(o => o.setName('usuario').setDescription('Membro').setRequired(false)),
  new SlashCommandBuilder().setName('ranknivel').setDescription('Mostra o top 10 de níveis do servidor'),
  new SlashCommandBuilder().setName('cargosnivel').setDescription('Cargos coloridos de nível: o bot cria e entrega sozinho (staff)')
    .addStringOption(o => o.setName('acao').setDescription('O que fazer').setRequired(true).addChoices(
      { name: 'Criar cargos', value: 'criar' },
      { name: 'Listar', value: 'listar' },
      { name: 'Sincronizar membros', value: 'sincronizar' },
      { name: 'Remover cargos', value: 'remover' }
    ))
    .addRoleOption(o => o.setName('abaixo_de').setDescription('Criar os cargos logo abaixo deste cargo (para a cor aparecer)').setRequired(false))
];

const guildOnly = (interaction) => (interaction.guild ? false : interaction.reply(eph('❌ Este comando só funciona dentro de um servidor.')));

const COMMANDS = {
  async nivel(interaction) {
    if (guildOnly(interaction)) return;
    const alvo = interaction.options.getUser('usuario') || interaction.user;
    const u = levelsStore.data[interaction.guild.id]?.[alvo.id] || { xp: 0, level: 0 };
    const precisa = xpNeeded(u.level);
    const cheios = Math.min(10, Math.round((u.xp / precisa) * 10));
    const barra = '🟩'.repeat(cheios) + '⬜'.repeat(10 - cheios);
    const posicao = sortedLevels(interaction.guild.id).findIndex((x) => x.id === alvo.id) + 1;

    const embed = new EmbedBuilder()
      .setColor(0x2ECC71)
      .setTitle(`⭐ Nível de ${alvo.tag}`)
      .setThumbnail(alvo.displayAvatarURL({ size: 256 }))
      .addFields(
        { name: '📈 Nível', value: `${u.level}`, inline: true },
        { name: '🏅 Posição', value: posicao ? `#${posicao}` : 'Sem ranking', inline: true },
        { name: `✨ XP (${u.xp}/${precisa})`, value: barra }
      );

    const proximo = tiersOf(interaction.guild).find((t) => t.level > u.level);
    if (proximo) embed.addFields({ name: '🎖️ Próximo cargo', value: `<@&${proximo.roleId}> no nível **${proximo.level}** (faltam ${proximo.level - u.level})` });
    return interaction.reply({ embeds: [embed], allowedMentions: { parse: [] } });
  },

  async ranknivel(interaction) {
    if (guildOnly(interaction)) return;
    const top = sortedLevels(interaction.guild.id).slice(0, 10);
    if (!top.length) return interaction.reply(eph('📊 Ninguém ganhou XP ainda. Conversem no chat!'));
    const desc = top.map((u, i) => {
      const med = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `**#${i + 1}**`;
      return `${med} <@${u.id}> — Nível **${u.level}** (${u.xp} XP)`;
    }).join('\n');
    return interaction.reply({ embeds: [new EmbedBuilder().setColor(0xF1C40F).setTitle('🏆 Top 10 Níveis').setDescription(desc)], allowedMentions: { parse: [] } });
  },

  async cargosnivel(interaction) {
    if (guildOnly(interaction)) return;
    const { guild, member, options } = interaction;
    const acao = options.getString('acao');

    if (acao === 'listar') {
      const tiers = tiersOf(guild);
      if (!tiers.length) return interaction.reply(eph('ℹ️ Ainda não há cargos de nível. Um admin pode criá-los com `cargosnivel criar`.'));
      const linhas = tiers.map((t) => `Nível **${t.level}** → <@&${t.roleId}>`).join('\n');
      return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x9B59B6).setTitle('🎖️ Cargos de nível').setDescription(linhas)], allowedMentions: { parse: [] } });
    }

    const negado = checkAccess(interaction, { strict: true });
    if (negado) return interaction.reply(eph(negado));
    if (!guild.members.me?.permissions.has(PermissionFlagsBits.ManageRoles)) {
      return interaction.reply(eph('❌ Eu preciso da permissão **Gerir Cargos** para fazer isso.'));
    }

    if (acao === 'criar') {
      await interaction.deferReply();
      try {
        const anchor = options.getRole('abaixo_de');
        const { criados, existentes } = await ensureLevelRoles(guild, anchor);
        const lista = tiersOf(guild).map((t) => `Nível **${t.level}** → <@&${t.roleId}>`).join('\n');
        return interaction.editReply({
          content: `✅ Cargos de nível prontos! (${criados} criados, ${existentes} já existiam)\n${lista}\n\n💡 Use \`cargosnivel sincronizar\` para entregar os cargos a quem já tem nível.${anchor ? '' : '\n🎨 Dica: arraste os cargos para cima na lista do servidor (ou use a opção `abaixo_de`) para as cores aparecerem.'}`,
          allowedMentions: { parse: [] }
        });
      } catch (err) {
        console.error('[cargosnivel]', err);
        return interaction.editReply({ content: '❌ Não consegui criar os cargos. Verifique se tenho **Gerir Cargos** e se o servidor não está no limite de cargos.' });
      }
    }

    if (acao === 'sincronizar') {
      if (!tiersOf(guild).length) return interaction.reply(eph('❌ Crie os cargos primeiro com `cargosnivel criar`.'));
      await interaction.deferReply();
      const ids = sortedLevels(guild.id).slice(0, MAX_SYNC_MEMBERS);
      let atualizados = 0;
      for (const u of ids) {
        try {
          const m = await guild.members.fetch(u.id);
          if (await applyLevelRole(m, u.level)) atualizados++;
        } catch (_) { /* saiu do servidor ou sem permissão */ }
      }
      return interaction.editReply({ content: `✅ Sincronização concluída: **${atualizados}** membros receberam um novo cargo (de ${ids.length} com nível).` });
    }

    if (acao === 'remover') {
      const cfg = ensureGuildConfig(guild.id);
      const tiers = tiersOf(guild);
      if (!tiers.length) return interaction.reply(eph('ℹ️ Não há cargos de nível para remover.'));
      await interaction.deferReply();
      for (const t of tiers) await guild.roles.cache.get(t.roleId)?.delete('Cargos de nível removidos').catch(() => {});
      delete cfg.levelRoles;
      saveConfig();
      return interaction.editReply({ content: '🗑️ Cargos de nível removidos.' });
    }
  }
};

const handledCommands = Object.keys(COMMANDS);

async function handleLevelsInteraction(interaction) {
  try {
    if (!interaction.isChatInputCommand()) return;
    if (!Object.hasOwn(COMMANDS, interaction.commandName)) return;
    await COMMANDS[interaction.commandName](interaction);
  } catch (err) {
    console.error('[interação/níveis]', err);
    try { const aviso = describeError(err); if (aviso) await respond(interaction, eph(aviso)); } catch (_) { /* ignora */ }
  }
}

module.exports = { levelsSlashCommands, handledCommands, handleLevelsInteraction, handleXp, applyLevelRole, LEVEL_TIERS };
