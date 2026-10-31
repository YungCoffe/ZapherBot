'use strict';

/**
 * BACKUP AUTOMÁTICO NO DISCORD
 *
 * Problema: no Render o disco é apagado a cada atualização/reinício (e o plano gratuito reinicia
 * quando o serviço dorme). Sem backup, saldo, níveis, configurações, cargos e logs "somem".
 *
 * Solução: o bot guarda uma cópia compactada (.gz) dos dados num canal PRIVADO do Discord:
 *   • a cada alteração (no máximo de 10 em 10 minutos) e ao receber o aviso de desligamento;
 *   • ao ligar com os dados vazios, ele baixa o último backup e restaura tudo sozinho.
 *
 * Configuração (uma vez só, pelo dono do bot):  ?backup  (ou ?backup configurar)
 *   → cria o canal privado #💾・zapher-backup. Nas próximas vezes ele é encontrado sozinho pelo
 *     nome/tópico (não precisa de variável de ambiente). Opcional: BACKUP_CHANNEL_ID no Render.
 *
 * Comando só com prefixo (não ocupa vaga de slash command):
 *   ?backup  → cria/configura o canal
 *   ?backup status|configurar|agora|recuperar|exportar|restaurar
 */

const zlib = require('zlib');
const crypto = require('crypto');
const fs = require('fs');
const { SlashCommandBuilder, AttachmentBuilder, ChannelType, PermissionFlagsBits } = require('discord.js');
const { listStores, getStore, flushAll, DATA_DIR } = require('./storage');
const { eph, truncate, respond, unix, describeError } = require('./utils');
const { checkAccess } = require('./perms');

const MARKER = 'ZAPHER-BACKUP';
const CHANNEL_NAME = '💾・zapher-backup';
const KEEP = 5;                    // quantos backups manter no canal
const MIN_INTERVAL = 10 * 60_000;  // no máximo 1 backup a cada 10 min (se algo mudou)
const CHECK_EVERY = 2 * 60_000;
const VERSION = (() => { try { return require('./package.json').version; } catch (_) { return '?'; } })();

const backupSlashCommands = [
  new SlashCommandBuilder().setName('backup').setDescription('Backup e restauração dos dados do bot (só o dono)')
    .addStringOption(o => o.setName('acao').setDescription('O que fazer (vazio = criar/configurar o canal)').setRequired(false).addChoices(
      { name: 'Ver o estado do backup', value: 'status' },
      { name: 'Configurar o canal de backup', value: 'configurar' },
      { name: 'Fazer backup agora', value: 'agora' },
      { name: 'Recuperar o último backup do canal', value: 'recuperar' },
      { name: 'Baixar os arquivos', value: 'exportar' },
      { name: 'Restaurar de um arquivo anexado', value: 'restaurar' }
    ))
    .addAttachmentOption(o => o.setName('arquivo').setDescription('Arquivo .json ou .json.gz para restaurar').setRequired(false))
    .addChannelOption(o => o.setName('canal').setDescription('Canal privado para os backups (vazio = criar automaticamente)').setRequired(false).addChannelTypes(ChannelType.GuildText))
];
/** Comandos que existem só com prefixo (não são enviados ao Discord como slash). */
const prefixOnlyNames = ['backup'];

/* ============================================================
 *  ESTADO
 * ============================================================ */
let channelCache = null;
let lastHash = null;
let lastPushAt = 0;
let lastPushOk = null;
let pushing = false;

/* ============================================================
 *  SNAPSHOT (arquivos .gz + impressão digital dos dados)
 * ============================================================ */
function snapshot() {
  flushAll();
  const hash = crypto.createHash('sha1');
  const files = [];
  for (const store of listStores()) {
    const json = JSON.stringify(store.data);
    hash.update(store.fileName).update(json);
    files.push({ name: `${store.fileName}.gz`, buffer: zlib.gzipSync(Buffer.from(json, 'utf8'), { level: 9 }), raw: json.length });
  }
  return { files, hash: hash.digest('hex') };
}

const storesLookEmpty = () => ['economy_data.json', 'levels.json', 'welcome_config.json']
  .map(getStore).filter(Boolean).every((s) => Object.keys(s.data).length === 0);

/* ============================================================
 *  CANAL DE BACKUP
 * ============================================================ */
function usable(channel, me) {
  if (!channel?.isTextBased?.() || channel.isThread?.()) return false;
  const p = channel.permissionsFor?.(me);
  return !!p?.has(['ViewChannel', 'SendMessages', 'ReadMessageHistory', 'AttachFiles']);
}

async function findChannel(client) {
  if (channelCache && client.channels.cache.has(channelCache.id)) return channelCache;
  channelCache = null;

  const envId = process.env.BACKUP_CHANNEL_ID;
  if (envId) {
    const ch = await client.channels.fetch(envId).catch(() => null);
    if (ch && usable(ch, ch.guild?.members.me)) return (channelCache = ch);
    console.warn('[backup] BACKUP_CHANNEL_ID definido, mas não consigo usar esse canal (confira o ID e as permissões do bot).');
  }
  for (const guild of client.guilds.cache.values()) {
    const me = guild.members.me;
    const ch = guild.channels.cache.find((c) => c.isTextBased?.() && !c.isThread?.()
      && (c.name === CHANNEL_NAME || c.name === 'zapher-backup' || c.topic?.includes(MARKER)) && usable(c, me));
    if (ch) return (channelCache = ch);
  }
  return null;
}

/* ============================================================
 *  ENVIAR / RECUPERAR
 * ============================================================ */
async function pushBackup(client, { force = false } = {}) {
  if (pushing) return { ok: false, reason: 'já está fazendo um backup' };
  pushing = true;
  try {
    const canal = await findChannel(client);
    if (!canal) return { ok: false, reason: 'nenhum canal de backup configurado' };

    const { files, hash } = snapshot();
    if (!force && hash === lastHash) return { ok: true, skipped: true };
    if (files.reduce((n, f) => n + f.buffer.length, 0) > 9 * 1024 * 1024) return { ok: false, reason: 'os dados ficaram grandes demais para um único envio' };

    await canal.send({
      content: `💾 ${MARKER} • ${new Date().toISOString()} • v${VERSION}`,
      files: files.map((f) => new AttachmentBuilder(f.buffer, { name: f.name })),
      allowedMentions: { parse: [] }
    });
    lastHash = hash;
    lastPushAt = Date.now();
    lastPushOk = true;

    // Mantém só os últimos backups
    const msgs = await canal.messages.fetch({ limit: 50 }).catch(() => null);
    if (msgs) {
      const meus = [...msgs.values()].filter((m) => m.author.id === client.user.id && m.content.includes(MARKER)).sort((a, b) => b.createdTimestamp - a.createdTimestamp);
      for (const velho of meus.slice(KEEP)) await velho.delete().catch(() => {});
    }
    return { ok: true, canal, arquivos: files.length };
  } catch (err) {
    lastPushOk = false;
    console.error('[backup] falha ao enviar:', err.message);
    return { ok: false, reason: err.message };
  } finally {
    pushing = false;
  }
}

async function readAttachment(att) {
  const res = await fetch(att.url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`download falhou (${res.status})`);
  let buf = Buffer.from(await res.arrayBuffer());
  if (att.name.endsWith('.gz')) buf = zlib.gunzipSync(buf);
  return JSON.parse(buf.toString('utf8'));
}

/** Aplica um arquivo (.json/.json.gz) ao store correspondente. Devolve o nome do store ou null. */
async function applyAttachment(att) {
  const base = att.name.replace(/ \(\d+\)/, '').replace(/\.gz$/, '');
  const store = getStore(base);
  if (!store) return null;
  const dados = await readAttachment(att);
  if (!dados || typeof dados !== 'object' || Array.isArray(dados)) throw new Error(`${att.name} não tem o formato esperado`);
  try { store.flush(); if (fs.existsSync(store.file)) fs.copyFileSync(store.file, `${store.file}.antes-restaurar-${Date.now()}`); } catch (_) { /* sem cópia local */ }
  store.replace(dados);
  return store.fileName;
}

async function restoreFromChannel(client) {
  const canal = await findChannel(client);
  if (!canal) return { ok: false, reason: 'nenhum canal de backup configurado' };
  const msgs = await canal.messages.fetch({ limit: 25 });
  const ultimo = [...msgs.values()]
    .filter((m) => m.author.id === client.user.id && m.content.includes(MARKER) && m.attachments.size > 0)
    .sort((a, b) => b.createdTimestamp - a.createdTimestamp)[0];
  if (!ultimo) return { ok: false, reason: 'não encontrei nenhum backup no canal' };

  const restaurados = [];
  for (const att of ultimo.attachments.values()) {
    try {
      const nome = await applyAttachment(att);
      if (nome) restaurados.push(nome);
    } catch (err) {
      console.error(`[backup] falha ao restaurar ${att.name}:`, err.message);
    }
  }
  flushAll();
  lastHash = null; // força um novo backup depois
  return { ok: restaurados.length > 0, restaurados, data: ultimo.createdTimestamp };
}

/* ============================================================
 *  AUTOMÁTICO
 * ============================================================ */
/** Chamado ao ligar: se os dados estão vazios (disco apagado), restaura do canal de backup. */
async function autoRestoreOnStart(client) {
  const canal = await findChannel(client).catch(() => null);
  if (!canal) {
    console.warn('⚠️ Backup automático NÃO configurado: ao reiniciar/atualizar no Render, os dados (saldo, níveis, configurações) podem sumir.\n   Peça ao dono do bot para usar  ?backup configurar  (cria um canal privado para guardar as cópias).');
    return;
  }
  if (!storesLookEmpty()) {
    console.log(`💾 Backup automático ativo em #${canal.name} (${canal.guild?.name}).`);
    return;
  }
  console.log('💾 Dados vazios (disco apagado?). Procurando o último backup...');
  const r = await restoreFromChannel(client).catch((err) => ({ ok: false, reason: err.message }));
  if (r.ok) console.log(`✅ Backup restaurado (${r.restaurados.length} arquivos, de ${new Date(r.data).toLocaleString('pt-BR')}).`);
  else console.warn(`⚠️ Não consegui restaurar: ${r.reason}`);
}

let timer = null;
function startBackupScheduler(client) {
  if (timer) return;
  timer = setInterval(() => {
    if (Date.now() - lastPushAt < MIN_INTERVAL) return;
    pushBackup(client).catch(() => {});
  }, CHECK_EVERY);
  setTimeout(() => pushBackup(client).catch(() => {}), 45_000); // primeiro backup logo depois de ligar
}

/* ============================================================
 *  COMANDO ?backup
 * ============================================================ */
const handledCommands = ['backup'];

/** Somente o dono do bot e o próprio bot recebem acesso explícito ao canal. */
function backupOverwrites(guild, ownerId, botId) {
  return [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    {
      id: botId,
      allow: [
        PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.AttachFiles, PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ManageMessages
      ]
    },
    {
      id: ownerId,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
      deny: [PermissionFlagsBits.SendMessages]
    }
  ];
}

async function configurar(interaction) {
  const { guild, user, options } = interaction;
  if (!guild) return interaction.reply(eph('❌ Use este comando dentro do servidor onde quer guardar os backups.'));
  let canal = options.getChannel('canal');

  try {
    if (!canal) {
      canal = await guild.channels.create({
        name: CHANNEL_NAME,
        type: ChannelType.GuildText,
        topic: `${MARKER} — cópias de segurança do bot. NÃO apague este canal. Mantenha-o privado.`,
        permissionOverwrites: backupOverwrites(guild, user.id, interaction.client.user.id),
        reason: 'Canal de backup do bot'
      });
    } else {
      // Reutilizar um canal não pode deixar permissões antigas expondo os backups.
      await canal.permissionOverwrites.set(
        backupOverwrites(guild, user.id, interaction.client.user.id),
        'Canal de backup restrito ao dono do bot'
      );
      await canal.setTopic(`${MARKER} — cópias de segurança do bot. NÃO apague este canal. Mantenha-o privado.`);
    }
  } catch (err) {
    return interaction.reply(eph(describeError(err) || '❌ Não consegui criar o canal.'));
  }

  channelCache = canal;
  await interaction.deferReply({ flags: 64 });
  const r = await pushBackup(interaction.client, { force: true });
  return interaction.editReply({
    content: r.ok
      ? `✅ Backup configurado em <#${canal.id}> e a primeira cópia já foi enviada!\nA partir de agora o bot salva sozinho e **restaura tudo ao reiniciar/atualizar**. Mantenha o canal privado e não o apague.`
      : `⚠️ O canal <#${canal.id}> está pronto, mas a primeira cópia falhou: ${r.reason}. Confira se o bot pode enviar arquivos lá.`
  });
}

async function status(interaction) {
  const canal = await findChannel(interaction.client);
  const lista = listStores().map((s) => `• \`${s.fileName}\` — ${Object.keys(s.data).length} registros`).join('\n');
  const linhas = [
    canal ? `📦 **Canal de backup:** <#${canal.id}> (${canal.guild.name})` : '❌ **Nenhum canal de backup.** Use `?backup configurar` — sem isso os dados somem quando o Render reinicia.',
    `🕒 **Último envio:** ${lastPushAt ? `<t:${unix(lastPushAt)}:R>${lastPushOk === false ? ' (falhou)' : ''}` : 'ainda não enviou nesta sessão'}`,
    `💽 **Disco persistente:** ${process.env.DATA_DIR ? `sim (\`${DATA_DIR}\`)` : 'não configurado (os arquivos são apagados a cada atualização; o backup cobre isso)'}`,
    '',
    '**Dados guardados:**',
    lista
  ];
  return interaction.reply({ content: truncate(linhas.join('\n'), 1990), flags: 64, allowedMentions: { parse: [] } });
}

const COMMANDS = {
  async backup(interaction) {
    const negado = checkAccess(interaction, { strict: true });
    if (negado) return interaction.reply(eph(negado));
    const acao = interaction.options.getString('acao') || 'configurar';

    if (acao === 'status') return status(interaction);
    if (acao === 'configurar') return configurar(interaction);

    if (acao === 'agora') {
      await interaction.deferReply({ flags: 64 });
      const r = await pushBackup(interaction.client, { force: true });
      return interaction.editReply({ content: r.ok ? `✅ Backup enviado para <#${r.canal.id}> (${r.arquivos} arquivos).` : `❌ Não foi possível: ${r.reason}.` });
    }

    if (acao === 'recuperar') {
      await interaction.deferReply({ flags: 64 });
      const r = await restoreFromChannel(interaction.client).catch((err) => ({ ok: false, reason: err.message }));
      return interaction.editReply({ content: r.ok ? `✅ Restaurado o backup de ${new Date(r.data).toLocaleString('pt-BR')} (${r.restaurados.length} arquivos).` : `❌ Não foi possível: ${r.reason}.` });
    }

    if (acao === 'exportar') {
      const { files } = snapshot();
      return interaction.reply({ content: '📦 Aqui estão os arquivos (`.gz`). Para restaurar, use `?backup restaurar` anexando os arquivos.', files: files.map((f) => new AttachmentBuilder(f.buffer, { name: f.name })), flags: 64 });
    }

    if (acao === 'restaurar') {
      const att = interaction.options.getAttachment('arquivo');
      if (!att) return interaction.reply(eph('❌ Anexe o arquivo `.json` ou `.json.gz` na mensagem (ex.: `?backup restaurar` com o arquivo).'));
      await interaction.deferReply({ flags: 64 });
      try {
        const nome = await applyAttachment(att);
        flushAll();
        return interaction.editReply({ content: nome ? `✅ \`${nome}\` restaurado. (Uma cópia do arquivo anterior foi guardada no disco.)` : '❌ O nome do arquivo não corresponde a nenhum dado do bot (ex.: `economy_data.json.gz`).' });
      } catch (err) {
        return interaction.editReply({ content: `❌ Não consegui restaurar: ${err.message}` });
      }
    }
  }
};

async function handleBackupInteraction(interaction) {
  try {
    if (!interaction.isChatInputCommand?.() || interaction.commandName !== 'backup') return;
    await COMMANDS.backup(interaction);
  } catch (err) {
    console.error('[interação/backup]', err);
    try { const aviso = describeError(err); if (aviso) await respond(interaction, eph(aviso)); } catch (_) { /* ignora */ }
  }
}

/**
 * Usado pelo /setup: garante o canal de backup e envia uma cópia agora, já com a configuração nova.
 * Só cria o canal se quem pediu o setup é o dono do bot (o backup guarda dados de todo mundo).
 */
async function backupAfterSetup(guild, client, user) {
  let canal = await findChannel(client);
  let criado = false;
  if (!canal && require('./perms').isOwner(user.id)) {
    canal = await guild.channels.create({
      name: CHANNEL_NAME,
      type: ChannelType.GuildText,
      topic: `${MARKER} — cópias de segurança do bot. NÃO apague este canal. Mantenha-o privado.`,
      permissionOverwrites: backupOverwrites(guild, user.id, client.user.id),
      reason: 'Setup: canal de backup do bot'
    }).catch(() => null);
    if (canal) { channelCache = canal; criado = true; }
  }
  if (!canal) return { ok: false, reason: 'ainda não existe canal de backup (o dono do bot precisa rodar `?backup` uma vez)' };
  const r = await pushBackup(client, { force: true });
  return { ...r, canal, criado };
}

/** É o canal privado de backup do bot? (o setup completo nunca o apaga) */
function isBackupChannel(channel) {
  return !!channel?.isTextBased?.() && !channel.isThread?.()
    && (channel.name === CHANNEL_NAME || channel.name === 'zapher-backup' || !!channel.topic?.includes(MARKER));
}

module.exports = {
  backupAfterSetup, isBackupChannel, backupSlashCommands, prefixOnlyNames, handledCommands, handleBackupInteraction,
  autoRestoreOnStart, startBackupScheduler, pushBackup
};
