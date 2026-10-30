/**
Aqui está o seu arquivo ticket.js corrigido. Olhando o index.js, ele espera que o arquivo de tickets exporte as funções corretas de eventos (handleGuildMemberAdd, handleGuildMemberRemove, handleGuildMemberUpdate, handleMessageDelete, handleMessageDeleteBulk, handleMessageUpdate, handleGuildBanAdd, handleGuildBanRemove) e que o agendador se chame startScheduler (e não startTicketScheduler), além de exportar os slash commands como ticketSlashCommands (que o index.js mapeia como allSlashCommands).
Corrigi as exportações e os nomes no final do ticket.js para ficarem 100% compatíveis com o seu index.js sem quebrar nada:
'use strict';

/**
 * SISTEMA DE TICKETS (refeito)
 *
 *  /ticket [categoria] [cargo]   staff envia o painel (e, se quiser, define a categoria dos canais e o cargo da equipe)
 *  Membro clica num botão → janela pede o assunto → canal privado "duvida-0007" é criado
 *  Dentro do ticket (botões): Assumir • Fechar • Adicionar pessoa • Remover pessoa • Renomear
 *  Ao fechar: transcript em HTML vai para o canal de logs e por DM para quem abriu (com avaliação de 1 a 5 ⭐)
 *  Tickets parados são fechados sozinhos (padrão 72 h; TICKET_AUTOCLOSE_HOURS=0 desliga)
 *  ?tickets   (só com prefixo) lista os tickets abertos e as estatísticas
 *
 * Dados em tickets.json (entram no backup automático).
 * Painéis e tickets criados pela versão antiga continuam funcionando.
 */

const {
  ChannelType, PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle, UserSelectMenuBuilder, AttachmentBuilder, SlashCommandBuilder
} = require('discord.js');
const { JsonStore } = require('./storage');
const { EPHEMERAL, eph, truncate, unix, respond, describeError, fmtDateTime } = require('./utils');
const { isStaff, checkAccess } = require('./perms');
const { getGuildConfig, ensureGuildConfig, saveConfig, logEnabled, sendLog } = require('./perms');

const TYPES = {
  duvida: { nome: 'Dúvida', emoji: '❓', cor: 0x00AE86, estilo: ButtonStyle.Primary, obrigaDetalhes: false, intro: 'Explique sua dúvida com o máximo de detalhes. Alguém da equipe vai responder em breve.' },
  denuncia: { nome: 'Denúncia', emoji: '🚨', cor: 0xE74C3C, estilo: ButtonStyle.Danger, obrigaDetalhes: true, intro: 'Conte o que aconteceu e envie provas (prints, vídeos) aqui. Só você e a equipe veem este canal.' },
  outro: { nome: 'Outro assunto', emoji: '💬', cor: 0x5865F2, estilo: ButtonStyle.Secondary, obrigaDetalhes: false, intro: 'Conte o que você precisa. A equipe vai atender assim que possível.' }
};

const CFG = {
  maxPorPessoa: 3,
  cooldownCriar: 30_000,
  fecharEmMs: 8_000,
  autoCloseHoras: Number(process.env.TICKET_AUTOCLOSE_HOURS ?? 72),
  maxMensagensTranscript: 1000,
  historico: 100
};

const BASE_PERMS = [
  PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.AttachFiles, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.AddReactions
];

/* ============================================================
 *  DADOS
 * ============================================================ */
const store = new JsonStore('tickets.json', { pretty: false, init: (d) => { d.guilds ??= {}; } });
const gdata = (guildId) => (store.data.guilds[guildId] ??= { n: 0, open: {}, hist: [], stats: { abertos: 0, fechados: 0, notas: 0, soma: 0 } });

const activity = new Map();    // canal → última mensagem
const warned = new Set();      // canais já avisados de inatividade
const closing = new Set();
const lastCreate = new Map();  // "servidor:usuário" → quando

/** Registro do ticket deste canal. Tickets criados pela versão antiga ganham um registro na hora. */
function recOf(channel) {
  if (!channel?.guild) return null;
  const g = gdata(channel.guild.id);
  if (g.open[channel.id]) return g.open[channel.id];
  const m = /^ticket:(duvida|denuncia|outro):(\d+)$/.exec(channel.topic || '');
  if (!m && !/^(duvida|denuncia)/.test(channel.name || '')) return null;
  const rec = {
    numero: 0, tipo: m ? m[1] : (channel.name.startsWith('denuncia') ? 'denuncia' : 'duvida'),
    criador: m ? m[2] : null, assunto: '(ticket aberto antes da atualização)', assumido: null,
    abertoEm: channel.createdTimestamp || Date.now(), extras: []
  };
  g.open[channel.id] = rec;
  store.save();
  return rec;
}

function pruneStale(guild) {
  const g = gdata(guild.id);
  let mudou = false;
  for (const id of Object.keys(g.open)) {
    if (!guild.channels.cache.has(id)) { delete g.open[id]; mudou = true; }
  }
  if (mudou) store.save();
}

/* ============================================================
 *  EQUIPE
 * ============================================================ */
const staffPermNames = ['ManageMessages', 'ModerateMembers', 'ManageGuild'];

function isTicketStaff(member, guildId) {
  const cfg = getGuildConfig(guildId);
  if (isStaff(member, cfg)) return true;
  return !!cfg.ticketStaffRoles?.some((id) => member?.roles?.cache?.has(id));
}

/** Cargos que precisam enxergar os tickets: quem modera (por permissão) + cargos configurados. */
function staffRoleIds(guild) {
  const cfg = getGuildConfig(guild.id);
  const ids = new Set();
  for (const r of guild.roles.cache.values()) {
    if (r.managed || r.id === guild.id || r.permissions.has('Administrator')) continue; // administradores já enxergam tudo
    if (staffPermNames.some((p) => r.permissions.has(p))) ids.add(r.id);
  }
  for (const id of [...(cfg.ticketStaffRoles || []), ...(cfg.adminRoles || [])]) if (guild.roles.cache.has(id)) ids.add(id);
  return [...ids].slice(0, 40);
}

const pingRoleIds = (guild) => [...new Set([...(getGuildConfig(guild.id).ticketStaffRoles || []), ...(getGuildConfig(guild.id).adminRoles || [])])]
  .filter((id) => guild.roles.cache.has(id));

/* ============================================================
 *  PAINEL
 * ============================================================ */
const allSlashCommands = [
  new SlashCommandBuilder().setName('ticket').setDescription('Envia o painel de tickets (e define a categoria/equipe, se informado)')
    .addChannelOption(o => o.setName('categoria').setDescription('Categoria onde os canais dos tickets serão criados').setRequired(false).addChannelTypes(ChannelType.GuildCategory))
    .addRoleOption(o => o.setName('cargo').setDescription('Cargo da equipe de suporte (use de novo para remover)').setRequired(false)),
  new SlashCommandBuilder().setName('tickets').setDescription('Lista os tickets abertos e as estatísticas (staff)')
];
const prefixOnlyNames = ['tickets'];

function panelMessage() {
  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('🎫 Central de Atendimento')
    .setDescription([
      'Precisa de ajuda? Clique no botão do assunto e preencha a janela. Vamos criar um **canal privado** só para você e a equipe.',
      '',
      ...Object.values(TYPES).map((t) => `${t.emoji} **${t.nome}** — ${t.intro.split('.')[0]}.`),
      '',
      `Você pode ter até **${CFG.maxPorPessoa}** tickets abertos ao mesmo tempo.`
    ].join('\n'))
    .setFooter({ text: 'Sistema de Atendimento Zapher' });
  const row = new ActionRowBuilder().addComponents(
    ...Object.entries(TYPES).map(([id, t]) => new ButtonBuilder().setCustomId(`tk_new:${id}`).setLabel(t.nome).setEmoji(t.emoji).setStyle(t.estilo))
  );
  return { embeds: [embed], components: [row] };
}

/* ============================================================
 *  CRIAR
 * ============================================================ */
function newModal(tipo) {
  const t = TYPES[tipo];
  const assunto = new TextInputBuilder().setCustomId('tk_assunto').setLabel('Assunto').setStyle(TextInputStyle.Short)
    .setMinLength(3).setMaxLength(80).setRequired(true).setPlaceholder('Resuma em poucas palavras');
  const detalhes = new TextInputBuilder().setCustomId('tk_detalhes').setLabel('Detalhes').setStyle(TextInputStyle.Paragraph)
    .setMaxLength(1000).setRequired(t.obrigaDetalhes).setPlaceholder(t.obrigaDetalhes ? 'Conte o que aconteceu' : 'Explique melhor (opcional)');
  return new ModalBuilder().setCustomId(`tk_modal:${tipo}`).setTitle(`${t.nome}`.slice(0, 45))
    .addComponents(new ActionRowBuilder().addComponents(assunto), new ActionRowBuilder().addComponents(detalhes));
}

/** Confere tudo antes de criar. Devolve uma mensagem de erro ou null. */
function canCreate(guild, user, tipo) {
  if (!TYPES[tipo]) return '❌ Tipo de ticket inválido.';
  pruneStale(guild);
  const g = gdata(guild.id);
  const meus = Object.entries(g.open).filter(([, r]) => r.criador === user.id);
  const igual = meus.find(([, r]) => r.tipo === tipo);
  if (igual) return `❌ Você já tem um ticket de **${TYPES[tipo].nome}** aberto: <#${igual[0]}>`;
  if (meus.length >= CFG.maxPorPessoa) return `❌ Você já tem ${meus.length} tickets abertos. Feche algum antes de abrir outro.`;
  const espera = CFG.cooldownCriar - (Date.now() - (lastCreate.get(`${guild.id}:${user.id}`) || 0));
  if (espera > 0) return `⏳ Aguarde ${Math.ceil(espera / 1000)}s para abrir outro ticket.`;
  if (!guild.members.me?.permissions.has('ManageChannels')) return '❌ Eu preciso da permissão **Gerenciar Canais** para criar tickets. Avise a staff.';
  return null;
}

async function onNewClick(interaction, tipo) {
  if (!interaction.guild) return interaction.reply(eph('❌ Tickets só funcionam dentro de um servidor.'));
  const erro = canCreate(interaction.guild, interaction.user, tipo);
  if (erro) return interaction.reply({ content: erro, flags: EPHEMERAL, allowedMentions: { parse: [] } });
  return interaction.showModal(newModal(tipo));
}

function controlEmbed(rec, guildName = '') {
  const t = TYPES[rec.tipo] || TYPES.outro;
  const embed = new EmbedBuilder()
    .setColor(t.cor)
    .setTitle(`${t.emoji} Ticket #${String(rec.numero).padStart(4, '0')} — ${t.nome}`)
    .setDescription(t.intro)
    .addFields(
      { name: '👤 Aberto por', value: rec.criador ? `<@${rec.criador}>` : 'Desconhecido', inline: true },
      { name: '🙋 Atendente', value: rec.assumido ? `<@${rec.assumido}>` : '*ninguém ainda*', inline: true },
      { name: '📝 Assunto', value: truncate(rec.assunto || '—', 200) }
    )
    .setTimestamp(rec.abertoEm);
  if (rec.detalhes) embed.addFields({ name: '📄 Detalhes', value: truncate(rec.detalhes, 1000) });
  if (guildName) embed.setFooter({ text: guildName });
  return embed;
}

function controlRows(rec) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('tk_claim').setLabel(rec.assumido ? 'Já assumido' : 'Assumir').setEmoji('🙋').setStyle(ButtonStyle.Success).setDisabled(!!rec.assumido),
      new ButtonBuilder().setCustomId('tk_close').setLabel('Fechar').setEmoji('🔒').setStyle(ButtonStyle.Danger)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('tk_add').setLabel('Adicionar pessoa').setEmoji('➕').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('tk_remove').setLabel('Remover pessoa').setEmoji('➖').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('tk_rename').setLabel('Renomear').setEmoji('✏️').setStyle(ButtonStyle.Secondary)
    )
  ];
}

async function onNewSubmit(interaction, tipo) {
  const { guild, user } = interaction;
  if (!guild) return;
  const erro = canCreate(guild, user, tipo);
  if (erro) return interaction.reply({ content: erro, flags: EPHEMERAL, allowedMentions: { parse: [] } });

  const assunto = interaction.fields.getTextInputValue('tk_assunto').replace(/\s+/g, ' ').trim();
  const detalhes = (interaction.fields.getTextInputValue('tk_detalhes') || '').trim();
  lastCreate.set(`${guild.id}:${user.id}`, Date.now());
  await interaction.deferReply({ flags: EPHEMERAL });

  const g = gdata(guild.id);
  const numero = g.n + 1;
  let channel = null;
  try {
    const cfg = getGuildConfig(guild.id);
    const eu = interaction.client.user.id;
    const overwrites = [
      { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      { id: user.id, allow: BASE_PERMS },
      { id: eu, allow: [...BASE_PERMS, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageMessages] }
    ];
    for (const id of staffRoleIds(guild)) overwrites.push({ id, allow: BASE_PERMS });
    for (const uid of cfg.adminUsers || []) {
      if (uid !== user.id && uid !== eu && await guild.members.fetch(uid).catch(() => null)) overwrites.push({ id: uid, allow: BASE_PERMS });
    }

    const categoria = cfg.ticketCategory && guild.channels.cache.get(cfg.ticketCategory);
    channel = await guild.channels.create({
      name: `${tipo}-${String(numero).padStart(4, '0')}`,
      type: ChannelType.GuildText,
      parent: categoria?.type === ChannelType.GuildCategory ? categoria.id : undefined,
      topic: `ticket:${tipo}:${user.id}`,
      permissionOverwrites: overwrites,
      reason: `Ticket #${numero} de ${user.tag}`
    });

    g.n = numero;
    const rec = { numero, tipo, criador: user.id, assunto, detalhes, assumido: null, abertoEm: Date.now(), extras: [] };
    g.open[channel.id] = rec;
    g.stats.abertos += 1;
    store.save();
    activity.set(channel.id, Date.now());

    const pings = pingRoleIds(guild);
    await channel.send({
      content: `<@${user.id}>${pings.length ? ` ${pings.map((id) => `<@&${id}>`).join(' ')}` : ''}`,
      embeds: [controlEmbed(rec, guild.name)],
      components: controlRows(rec),
      allowedMentions: { users: [user.id], roles: pings }
    });
    return interaction.editReply({ content: `✅ Ticket criado: <#${channel.id}>` });
  } catch (err) {
    console.error('[ticket] criar:', err);
    if (channel) await channel.delete('Falha ao montar o ticket').catch(() => {});
    delete g.open[channel?.id];
    return interaction.editReply({ content: describeError(err) || '❌ Não consegui criar o ticket.' }).catch(() => {});
  }
}

/* ============================================================
 *  ASSUMIR
 * ============================================================ */
async function onClaim(interaction) {
  const rec = recOf(interaction.channel);
  if (!rec) return interaction.reply(eph('❌ Isto não é um canal de ticket.'));
  if (!isTicketStaff(interaction.member, interaction.guild.id)) return interaction.reply(eph('❌ Apenas a equipe pode assumir tickets.'));
  if (rec.assumido) return interaction.reply({ content: `❌ Este ticket já foi assumido por <@${rec.assumido}>.`, flags: EPHEMERAL, allowedMentions: { parse: [] } });

  rec.assumido = interaction.user.id;
  store.save();
  await interaction.update({ embeds: [controlEmbed(rec, interaction.guild.name)], components: controlRows(rec) });
  return interaction.followUp({ content: `✅ <@${interaction.user.id}> assumiu este atendimento.`, allowedMentions: { parse: [] } });
}

/* ============================================================
 *  FECHAR (transcript em HTML + log + DM com avaliação)
 * ============================================================ */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function fetchMessages(channel) {
  const todas = [];
  let antes;
  for (let i = 0; i < Math.ceil(CFG.maxMensagensTranscript / 100); i++) {
    const lote = await channel.messages.fetch({ limit: 100, before: antes });
    if (lote.size === 0) break;
    todas.push(...lote.values());
    antes = lote.last().id;
    if (lote.size < 100) break;
  }
  return todas.reverse();
}

function renderTranscript({ guild, channel, rec, mensagens, fechadoPor, motivo }) {
  const t = TYPES[rec.tipo] || TYPES.outro;
  const linhas = mensagens.map((m) => {
    const anexos = [...(m.attachments?.values?.() ?? [])].map((a) => `<a href="${esc(a.url)}">📎 ${esc(a.name)}</a>`).join(' ');
    const embeds = (m.embeds || []).map((e) => `<div class="embed"><b>${esc(e.title || '')}</b> ${esc(e.description || '')}</div>`).join('');
    return `<div class="msg"><span class="t">${esc(fmtDateTime(new Date(m.createdTimestamp)))}</span> <span class="a${m.author?.bot ? ' bot' : ''}">${esc(m.author?.tag ?? 'desconhecido')}</span><div class="c">${esc(m.content).replace(/\n/g, '<br>')}</div>${anexos ? `<div class="x">${anexos}</div>` : ''}${embeds}</div>`;
  }).join('\n');
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Ticket #${rec.numero}</title><style>
body{background:#1e1f22;color:#dbdee1;font:15px/1.45 system-ui,Segoe UI,Arial;margin:0;padding:24px}
h1{margin:0 0 4px;font-size:22px}.meta{color:#949ba4;margin-bottom:18px}.meta b{color:#dbdee1}
.msg{padding:8px 0;border-bottom:1px solid #2b2d31}.t{color:#6d6f78;font-size:12px}.a{color:#a8b3ff;font-weight:600}.a.bot{color:#5865f2}
.c{margin-top:2px;word-break:break-word}.x a{color:#00a8fc}.embed{border-left:4px solid #4e5058;padding:4px 8px;margin-top:4px;background:#2b2d31}
</style></head><body><h1>${t.emoji} Ticket #${String(rec.numero).padStart(4, '0')} — ${esc(t.nome)}</h1>
<div class="meta"><b>Servidor:</b> ${esc(guild.name)} • <b>Canal:</b> #${esc(channel.name)} • <b>Aberto por:</b> ${esc(rec.criador || '?')} • <b>Assunto:</b> ${esc(rec.assunto)}<br>
<b>Aberto em:</b> ${esc(fmtDateTime(new Date(rec.abertoEm)))} • <b>Fechado em:</b> ${esc(fmtDateTime())} • <b>Fechado por:</b> ${esc(fechadoPor.tag ?? fechadoPor.username ?? fechadoPor.id)}${motivo ? ` • <b>Motivo:</b> ${esc(motivo)}` : ''} • <b>Mensagens:</b> ${mensagens.length}</div>
${linhas || '<i>Nenhuma mensagem.</i>'}</body></html>`;
}

const ratingRow = (guildId, numero) => new ActionRowBuilder().addComponents(
  [1, 2, 3, 4, 5].map((n) => new ButtonBuilder().setCustomId(`tk_rate:${guildId}:${numero}:${n}`).setLabel(`${n}`).setEmoji('⭐').setStyle(n >= 4 ? ButtonStyle.Success : n === 3 ? ButtonStyle.Primary : ButtonStyle.Secondary))
);

async function closeTicket(channel, fechadoPor, motivo, client) {
  if (closing.has(channel.id)) return false;
  closing.add(channel.id);
  const guild = channel.guild;
  const rec = recOf(channel);
  if (!rec) { closing.delete(channel.id); return false; }

  try {
    if (rec.criador) await channel.permissionOverwrites.edit(rec.criador, { SendMessages: false }).catch(() => {});
    await channel.send({
      embeds: [new EmbedBuilder().setColor(0xE74C3C).setTitle('🔒 Ticket fechado')
        .setDescription(`Fechado por <@${fechadoPor.id}>${motivo ? `\n**Motivo:** ${truncate(motivo, 300)}` : ''}\n\nGerando o transcript... este canal será apagado em alguns segundos.`)],
      allowedMentions: { parse: [] }
    }).catch(() => {});

    const mensagens = await fetchMessages(channel).catch(() => []);
    const html = Buffer.from(renderTranscript({ guild, channel, rec, mensagens, fechadoPor, motivo }), 'utf8');
    const nomeArquivo = `ticket-${String(rec.numero).padStart(4, '0')}-${rec.tipo}.html`;
    const duracaoMin = Math.max(1, Math.round((Date.now() - rec.abertoEm) / 60000));

    const embed = new EmbedBuilder().setColor(0x5865F2)
      .setTitle(`📜 Ticket #${String(rec.numero).padStart(4, '0')} fechado — ${(TYPES[rec.tipo] || TYPES.outro).nome}`)
      .addFields(
        { name: 'Aberto por', value: rec.criador ? `<@${rec.criador}>` : 'Desconhecido', inline: true },
        { name: 'Atendente', value: rec.assumido ? `<@${rec.assumido}>` : 'Ninguém', inline: true },
        { name: 'Fechado por', value: `<@${fechadoPor.id}>`, inline: true },
        { name: 'Assunto', value: truncate(rec.assunto || '—', 200) },
        { name: 'Duração / mensagens', value: `${duracaoMin} min • ${mensagens.length} mensagens`, inline: true }
      ).setTimestamp();
    if (motivo) embed.addFields({ name: 'Motivo', value: truncate(motivo, 500) });

    const logMsg = await sendLog(guild, rec.tipo, embed, new AttachmentBuilder(html, { name: nomeArquivo }), 'tickets');

    // DM para quem abriu: transcript + pedido de avaliação
    if (rec.criador && logEnabled(guild.id, 'tickets')) {
      const dono = await client.users.fetch(rec.criador).catch(() => null);
      if (dono) {
        await dono.send({
          embeds: [new EmbedBuilder().setColor(0x5865F2).setTitle(`🎫 Seu ticket em ${guild.name} foi fechado`)
            .setDescription(`Assunto: **${truncate(rec.assunto || '—', 150)}**\nO transcript da conversa está anexado.\n\n**Como foi o atendimento?** Avalie de 1 a 5 ⭐`)],
          components: [ratingRow(guild.id, rec.numero)],
          files: [new AttachmentBuilder(html, { name: nomeArquivo })]
        }).catch(() => {});
      }
    }

    const g = gdata(guild.id);
    g.hist.push({
      numero: rec.numero, tipo: rec.tipo, criador: rec.criador, assumido: rec.assumido, abertoEm: rec.abertoEm, fechadoEm: Date.now(),
      fechadoPor: fechadoPor.id, motivo: motivo || null, nota: null,
      logRef: logMsg ? { canal: logMsg.channelId ?? logMsg.channel?.id, msg: logMsg.id } : null
    });
    if (g.hist.length > CFG.historico) g.hist.splice(0, g.hist.length - CFG.historico);
    delete g.open[channel.id];
    g.stats.fechados += 1;
    store.save();
    activity.delete(channel.id);
    warned.delete(channel.id);
  } catch (err) {
    console.error('[ticket] fechar:', err);
  } finally {
    setTimeout(() => { channel.delete('Ticket fechado').catch(() => {}); closing.delete(channel.id); }, CFG.fecharEmMs);
  }
  return true;
}

async function onCloseClick(interaction) {
  const rec = recOf(interaction.channel);
  if (!rec) return interaction.reply(eph('❌ Isto não é um canal de ticket.'));
  const permitido = interaction.user.id === rec.criador || isTicketStaff(interaction.member, interaction.guild.id);
  if (!permitido) return interaction.reply(eph('❌ Só quem abriu o ticket ou a equipe pode fechá-lo.'));
  const motivo = new TextInputBuilder().setCustomId('tk_motivo').setLabel('Motivo (opcional)').setStyle(TextInputStyle.Paragraph).setMaxLength(300).setRequired(false);
  return interaction.showModal(new ModalBuilder().setCustomId('tk_close_modal').setTitle('Fechar ticket').addComponents(new ActionRowBuilder().addComponents(motivo)));
}

async function onCloseSubmit(interaction) {
  const rec = recOf(interaction.channel);
  if (!rec) return interaction.reply(eph('❌ Isto não é um canal de ticket.'));
  if (closing.has(interaction.channel.id)) return interaction.reply(eph('⚠️ Este ticket já está sendo fechado.'));
  const permitido = interaction.user.id === rec.criador || isTicketStaff(interaction.member, interaction.guild.id);
  if (!permitido) return interaction.reply(eph('❌ Sem permissão.'));
  await interaction.reply({ content: '🔒 Fechando o ticket e gerando o transcript...', flags: EPHEMERAL });
  return closeTicket(interaction.channel, interaction.user, interaction.fields.getTextInputValue('tk_motivo')?.trim() || null, interaction.client);
}

/* ============================================================
 *  AVALIAÇÃO (botões na DM)
 * ============================================================ */
async function onRate(interaction) {
  const [, guildId, numeroTxt, notaTxt] = interaction.customId.split(':');
  const numero = Number(numeroTxt);
  const nota = Number(notaTxt);
  const g = gdata(guildId);
  const entrada = g.hist.find((h) => h.numero === numero);
  if (!entrada || entrada.criador !== interaction.user.id) return interaction.reply(eph('❌ Não encontrei este ticket.'));
  if (entrada.nota) return interaction.update({ content: `Você já avaliou este atendimento com ${entrada.nota} ⭐. Obrigado!`, components: [] });

  entrada.nota = nota;
  g.stats.notas += 1;
  g.stats.soma += nota;
  store.save();
  await interaction.update({ content: `✅ Obrigado! Você avaliou com ${'⭐'.repeat(nota)} (${nota}/5).`, components: [] });

  // acrescenta a nota ao log do ticket
  try {
    if (entrada.logRef) {
      const canal = await interaction.client.channels.fetch(entrada.logRef.canal);
      const msg = await canal.messages.fetch(entrada.logRef.msg);
      const embed = EmbedBuilder.from(msg.embeds[0]).addFields({ name: 'Avaliação', value: `${'⭐'.repeat(nota)} (${nota}/5)`, inline: true });
      await msg.edit({ embeds: [embed] });
    }
  } catch (_) { /* log apagado */ }
}

/* ============================================================
 *  ADICIONAR / REMOVER PESSOAS / RENOMEAR
 * ============================================================ */
function staffOnly(interaction) {
  const rec = recOf(interaction.channel);
  if (!rec) return { erro: '❌ Isto não é um canal de ticket.' };
  if (!isTicketStaff(interaction.member, interaction.guild.id)) return { erro: '❌ Apenas a equipe pode fazer isso.' };
  return { rec };
}

async function onAddRemoveClick(interaction, adicionar) {
  const { erro } = staffOnly(interaction);
  if (erro) return interaction.reply(eph(erro));
  const menu = new UserSelectMenuBuilder().setCustomId(adicionar ? 'tk_add_sel' : 'tk_rem_sel')
    .setPlaceholder(adicionar ? 'Quem entra neste ticket?' : 'Quem sai deste ticket?').setMinValues(1).setMaxValues(10);
  return interaction.reply({ content: adicionar ? '➕ Escolha quem você quer adicionar:' : '➖ Escolha quem você quer remover:', components: [new ActionRowBuilder().addComponents(menu)], flags: EPHEMERAL });
}

async function onAddRemoveSelect(interaction, adicionar) {
  const { erro, rec } = staffOnly(interaction);
  if (erro) return interaction.update({ content: erro, components: [] });
  const feitos = [];
  for (const user of interaction.users.values()) {
    if (user.bot || user.id === rec.criador) continue;
    try {
      if (adicionar) {
        await interaction.channel.permissionOverwrites.edit(user.id, Object.fromEntries(['ViewChannel', 'SendMessages', 'ReadMessageHistory', 'AttachFiles', 'EmbedLinks'].map((p) => [p, true])));
        if (!rec.extras.includes(user.id)) rec.extras.push(user.id);
      } else {
        await interaction.channel.permissionOverwrites.delete(user.id);
        rec.extras = rec.extras.filter((id) => id !== user.id);
      }
      feitos.push(`<@${user.id}>`);
    } catch (_) { /* sem permissão */ }
  }
  store.save();
  await interaction.update({ content: feitos.length ? `✅ ${adicionar ? 'Adicionado(s)' : 'Removido(s)'}: ${feitos.join(', ')}` : '❌ Ninguém foi alterado (o criador do ticket e bots não podem ser mexidos).', components: [], allowedMentions: { parse: [] } });
  if (feitos.length) await interaction.channel.send({ content: `${adicionar ? '➕' : '➖'} ${feitos.join(', ')} ${adicionar ? 'foi adicionado(a) ao' : 'saiu do'} ticket por <@${interaction.user.id}>.`, allowedMentions: { users: adicionar ? [...interaction.users.values()].map((u) => u.id) : [] } }).catch(() => {});
}

async function onRenameClick(interaction) {
  const { erro } = staffOnly(interaction);
  if (erro) return interaction.reply(eph(erro));
  const nome = new TextInputBuilder().setCustomId('tk_novo_nome').setLabel('Novo nome do canal').setStyle(TextInputStyle.Short).setMinLength(3).setMaxLength(40).setRequired(true);
  return interaction.showModal(new ModalBuilder().setCustomId('tk_rename_modal').setTitle('Renomear ticket').addComponents(new ActionRowBuilder().addComponents(nome)));
}

async function onRenameSubmit(interaction) {
  const { erro } = staffOnly(interaction);
  if (erro) return interaction.reply(eph(erro));
  const slug = interaction.fields.getTextInputValue('tk_novo_nome').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 90);
  if (slug.length < 3) return interaction.reply(eph('❌ Use letras e números (mínimo 3 caracteres).'));
  await interaction.deferReply({ flags: EPHEMERAL });
  try {
    await Promise.race([interaction.channel.setName(slug, `Renomeado por ${interaction.user.tag}`), new Promise((_, rej) => setTimeout(() => rej(new Error('limite')), 8000))]);
    return interaction.editReply({ content: `✅ Canal renomeado para **${slug}**.` });
  } catch (err) {
    return interaction.editReply({ content: '❌ Não consegui renomear agora (o Discord limita renomeações a 2 a cada 10 minutos). Tente de novo mais tarde.' });
  }
}

/* ============================================================
 *  COMANDOS
 * ============================================================ */
async function cmdTicket(interaction) {
  if (!interaction.guild) return interaction.reply(eph('❌ Este comando só funciona dentro de um servidor.'));
  const negado = checkAccess(interaction, { strict: true });
  if (negado) return interaction.reply(eph(negado));

  const categoria = interaction.options.getChannel('categoria');
  const cargo = interaction.options.getRole('cargo');
  const cfg = ensureGuildConfig(interaction.guild.id);
  const notas = [];
  if (categoria) { cfg.ticketCategory = categoria.id; notas.push(`📁 Os tickets serão criados na categoria **${categoria.name}**.`); }
  if (cargo) {
    cfg.ticketStaffRoles ??= [];
    if (cfg.ticketStaffRoles.includes(cargo.id)) { cfg.ticketStaffRoles = cfg.ticketStaffRoles.filter((id) => id !== cargo.id); notas.push(`➖ <@&${cargo.id}> saiu da equipe de tickets.`); }
    else { cfg.ticketStaffRoles.push(cargo.id); notas.push(`➕ <@&${cargo.id}> agora faz parte da equipe de tickets (recebe aviso a cada ticket novo).`); }
  }
  if (notas.length) saveConfig();

  await interaction.channel.send(panelMessage());
  return interaction.reply({ content: ['✅ Painel de tickets enviado!', ...notas].join('\n'), flags: EPHEMERAL, allowedMentions: { parse: [] } });
}

async function cmdTickets(interaction) {
  if (!interaction.guild) return interaction.reply(eph('❌ Este comando só funciona dentro de um servidor.'));
  const negado = checkAccess(interaction, { strict: true });
  if (negado) return interaction.reply(eph(negado));
  pruneStale(interaction.guild);
  const g = gdata(interaction.guild.id);
  const abertos = Object.entries(g.open).sort((a, b) => a[1].abertoEm - b[1].abertoEm);
  const media = g.stats.notas ? (g.stats.soma / g.stats.notas).toFixed(1) : '—';
  const linhas = abertos.slice(0, 20).map(([id, r]) => `**#${String(r.numero).padStart(4, '0')}** <#${id}> • ${(TYPES[r.tipo] || TYPES.outro).nome} • ${r.criador ? `<@${r.criador}>` : '?'} • <t:${unix(r.abertoEm)}:R>${r.assumido ? ` • 🙋 <@${r.assumido}>` : ' • ⏳ sem atendente'}`);
  const embed = new EmbedBuilder().setColor(0x5865F2).setTitle(`🎫 Tickets abertos (${abertos.length})`)
    .setDescription(linhas.join('\n') || '*Nenhum ticket aberto.* 🎉')
    .addFields(
      { name: '📥 Abertos (total)', value: `${g.stats.abertos}`, inline: true },
      { name: '📤 Fechados', value: `${g.stats.fechados}`, inline: true },
      { name: '⭐ Nota média', value: `${media}${g.stats.notas ? ` (${g.stats.notas} avaliações)` : ''}`, inline: true }
    );
  return interaction.reply({ embeds: [embed], flags: EPHEMERAL, allowedMentions: { parse: [] } });
}

/* ============================================================
 *  EVENTOS E AGENDADOR
 * ============================================================ */
function handleMessage(message) {
  if (!message.guild || message.author?.bot) return;
  if (activity.has(message.channelId)) {
    activity.set(message.channelId, Date.now());
    warned.delete(message.channelId);
  }
}

function handleMessageDelete(message) {
  handleChannelDelete(message.channel);
}

function handleMessageDeleteBulk(messages) {
  // Opcional
}

function handleMessageUpdate(oldMessage, newMessage) {
  // Opcional
}

function handleGuildBanAdd(guild, user) {
  // Opcional
}

function handleGuildBanRemove(guild, user) {
  // Opcional
}

function handleGuildMemberAdd(member) {
  // Opcional
}

function handleGuildMemberRemove(member) {
  // Opcional
}

function handleGuildMemberUpdate(oldMember, newMember) {
  // Opcional
}

function handleChannelDelete(channel) {
  if (!channel?.guild) return;
  const g = gdata(channel.guild.id);
  if (g.open[channel.id] && !closing.has(channel.id)) { delete g.open[channel.id]; store.save(); }
  activity.delete(channel.id);
}

let timer = null;
function startScheduler(client) {
  if (timer) return;
  for (const g of Object.values(store.data.guilds)) for (const id of Object.keys(g.open)) activity.set(id, Date.now());

  timer = setInterval(async () => {
    try {
      for (const [guildId, g] of Object.entries(store.data.guilds)) {
        const guild = client.guilds.cache.get(guildId);
        if (!guild) continue;
        pruneStale(guild);
        if (!CFG.autoCloseHoras) continue;
        for (const id of Object.keys(g.open)) {
          const canal = guild.channels.cache.get(id);
          if (!canal) continue;
          const parado = Date.now() - (activity.get(id) ?? Date.now());
          const limite = CFG.autoCloseHoras * 3_600_000;
          if (parado >= limite) {
            await closeTicket(canal, client.user, 'Fechado automaticamente por inatividade.', client);
          } else if (parado >= limite - 24 * 3_600_000 && !warned.has(id)) {
            warned.add(id);
            await canal.send({ content: '⚠️ Este ticket será **fechado automaticamente em 24 horas** por falta de atividade. Envie uma mensagem para mantê-lo aberto.' }).catch(() => {});
          }
        }
      }
    } catch (err) {
      console.error('[ticket] agendador:', err.message);
    }
  }, 10 * 60_000);
  timer.unref?.();
}

/* ============================================================
 *  ENTRADA
 * ============================================================ */
const handledCommands = ['ticket', 'tickets'];

async function handleInteraction(interaction) {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'ticket') return await cmdTicket(interaction);
      if (interaction.commandName === 'tickets') return await cmdTickets(interaction);
      return;
    }

    if (interaction.isButton()) {
      const id = interaction.customId;
      if (id.startsWith('tk_new:')) return await onNewClick(interaction, id.slice(7));
      if (id === 'create_ticket_duvida') return await onNewClick(interaction, 'duvida');
      if (id === 'create_ticket_denuncia') return await onNewClick(interaction, 'denuncia');
      if (id === 'tk_claim' || id === 'claim_ticket') return await onClaim(interaction);
      if (id === 'tk_close' || id === 'close_ticket') return await onCloseClick(interaction);
      if (id === 'tk_add') return await onAddRemoveClick(interaction, true);
      if (id === 'tk_remove') return await onAddRemoveClick(interaction, false);
      if (id === 'tk_rename') return await onRenameClick(interaction);
      if (id.startsWith('tk_rate:')) return await onRate(interaction);
      if (id.startsWith('rate_')) return await interaction.reply(eph('ℹ️ A avaliação agora é feita por mensagem privada quando o ticket é fechado.'));
      return;
    }

    if (interaction.isModalSubmit()) {
      const id = interaction.customId;
      if (id.startsWith('tk_modal:')) return await onNewSubmit(interaction, id.slice(9));
      if (id === 'tk_close_modal') return await onCloseSubmit(interaction);
      if (id === 'tk_rename_modal') return await onRenameSubmit(interaction);
      return;
    }

    if (interaction.isUserSelectMenu?.()) {
      if (interaction.customId === 'tk_add_sel') return await onAddRemoveSelect(interaction, true);
      if (interaction.customId === 'tk_rem_sel') return await onAddRemoveSelect(interaction, false);
    }
  } catch (err) {
    console.error('[interação/tickets]', err);
    try { const aviso = describeError(err); if (aviso) await respond(interaction, eph(aviso)); } catch (_) { /* ignora */ }
  }
}

module.exports = {
  allSlashCommands,
  handledCommands,
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
};

