'use strict';

/**
 * ZOEIRA AUTOMÁTICA: o bot age sozinho no papo, sem ninguém digitar comando.
 *
 * De vez em quando (sorteio + intervalo mínimo), ele lê as últimas mensagens do canal, pede à IA para decidir se vale
 * UMA brincadeira e executa. O que ele pode fazer:
 *   responder  uma zoeira curta na conversa
 *   reagir     com um emoji numa mensagem
 *   apelido    trocar o apelido de alguém por alguns minutos (volta sozinho)
 *   cargo      dar um cargo temporário de enfeite (sem permissão nenhuma; some sozinho)
 *   mutar      silenciar por 5 a 60 SEGUNDOS
 *
 * Controle da equipe:  ?zoeira ligar | desligar | nivel leve/medio/maluco | canal | desfazer | status
 * Qualquer pessoa:     ?zoeira sair  (não ser alvo)  |  ?zoeira entrar
 *
 * Travas que NÃO dependem da IA (o código valida tudo antes de executar):
 *   - só funciona onde a equipe ligou (desligada por padrão) e só nos canais escolhidos
 *   - só mexe em quem está na conversa; nunca em bots, no dono do servidor nem em quem saiu da zoeira
 *   - a equipe (quem modera) nunca é silenciada
 *   - mute: no máximo 60 s; apelido e cargo voltam sozinhos; cargo nunca tem permissão
 *   - limites: intervalo mínimo entre decisões, teto por hora, por pessoa e por dia (poupa token também)
 *   - para sozinho por 30 min no canal quando o papo fica sério (tristeza, luto, ajuda...)
 *   - bloqueia xingamento pesado, preconceito e nomes que se passam por staff
 *   - tudo é registrado no canal de logs e `?zoeira desfazer` reverte na hora
 */

const { SlashCommandBuilder, EmbedBuilder, ChannelType } = require('discord.js');
const { JsonStore } = require('./storage');
const { eph, truncate, normalize, describeError, PREFIX, placeRoleBelow } = require('./utils');
const { getGuildConfig, ensureGuildConfig, saveConfig } = require('./ticket');
const { isStaff } = require('./perms');
const ai = require('./ai');

/* ============================================================
 *  AJUSTES
 * ============================================================ */
const NIVEIS = {
  leve: { chance: 0.03, acoes: ['responder', 'reagir'] },
  medio: { chance: 0.04, acoes: ['responder', 'reagir', 'apelido', 'cargo'] },
  maluco: { chance: 0.06, acoes: ['responder', 'reagir', 'apelido', 'cargo', 'mutar'] }
};
const GAP_MS = 2 * 60_000;                                   // intervalo mínimo entre decisões da IA, por servidor
const DAILY_CALLS = Number(process.env.AI_ZOEIRA_DAILY) || 40; // decisões da IA por servidor por dia
const NICK_MS = 15 * 60_000;
const ROLE_MS = 20 * 60_000;
const MUTE_MIN = 5;
const MUTE_MAX = 60;
const USER_GAP_MS = 20 * 60_000;                             // a mesma pessoa só é alvo de novo depois disso
const USER_DAILY = 4;
const HOUR_CAPS = { mutar: 3, apelido: 6, cargo: 3 };
const MAX_ROLES_ATIVOS = 3;
const CANAIS_PADRAO = ['chatGeral', 'memes', 'midia', 'chatGames', 'lfg', 'clipes'];

// Papo sério: a zoeira para por 30 minutos naquele canal
const SENSIVEL = /(suicid|me matar|automutil|depress|ansiedade|\bluto\b|faleceu|morreu|velorio|estupr|abuso|violencia domestica|socorro|emergencia|hospital|internad|cancer)/;
// Nunca vira apelido, cargo nem fala do bot
const PROIBIDO = /(n[i1]gg|crioul[oa]|macac[oa]|viad[oa]|bicha|sapat[aã]o|retardad|mongol|nazi|hitler|estupr|pedofil|suicid|se mata|morra\b|vai morrer)/i;
// Apelido/cargo que se passa por autoridade
const FAZ_SE_PASSAR = /(admin|moderador|\bmod\b|staff|suporte|\bdono\b|owner|\bceo\b|\bbot\b|oficial)/i;
const CORES = [0xE91E63, 0x9B59B6, 0xF1C40F, 0x1ABC9C, 0xE67E22, 0x3498DB, 0xFF69B4, 0x2ECC71];

const efeitosStore = new JsonStore('zoeira-efeitos.json', { fallback: { efeitos: [] } });
efeitosStore.data.efeitos ??= [];

/* ============================================================
 *  ESTADO (só em memória: nada de conversa é gravado em disco)
 * ============================================================ */
const buffers = new Map();       // canal -> últimas mensagens
const silencio = new Map();      // canal -> até quando fica quieto
const ultimaDecisao = new Map(); // servidor -> última vez que consultou a IA
const chamadasDia = new Map();   // servidor -> { dia, n }
const acoesUsuario = new Map();  // "servidor:usuario" -> { ult, dia, n }
const acoesHora = new Map();     // servidor -> { tipo: [timestamps] }

const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });

const zoeiraDe = (guildId) => getGuildConfig(guildId).zoeira || null;
function garantirZoeira(guildId) {
  const cfg = ensureGuildConfig(guildId);
  cfg.zoeira ??= { ligada: false, nivel: 'maluco', canais: [], sair: [] };
  cfg.zoeira.canais ??= [];
  cfg.zoeira.sair ??= [];
  return cfg.zoeira;
}

/* ============================================================
 *  TEXTO SEGURO
 * ============================================================ */
/** Tira menções, links, markdown e caracteres invisíveis; limita o tamanho. */
function limpar(texto, max) {
  return String(texto ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/https?:\/\/\S+|discord\.gg\/\S+/gi, ' ')
    .replace(/@(everyone|here)/gi, ' ')
    .replace(/[\u0000-\u001f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/[@#`*_~|>\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}
const ofensivo = (texto) => PROIBIDO.test(normalize(texto)) || PROIBIDO.test(String(texto));
const EMOJI_OK = /^(?:\p{Extended_Pictographic}\uFE0F?(?:\u200D\p{Extended_Pictographic}\uFE0F?)*){1,2}$/u;

function lerJson(texto) {
  const m = String(texto || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch (_) { return null; }
}

/* ============================================================
 *  LIMITES
 * ============================================================ */
function podeChamarIA(guildId) {
  const hoje = today();
  const c = chamadasDia.get(guildId);
  if (c && c.dia === hoje && c.n >= DAILY_CALLS) return false;
  chamadasDia.set(guildId, { dia: hoje, n: (c && c.dia === hoje ? c.n : 0) + 1 });
  return true;
}

function podeAgir(guildId, userId, tipo) {
  const agora = Date.now();
  const u = acoesUsuario.get(`${guildId}:${userId}`);
  if (u && agora - u.ult < USER_GAP_MS) return false;
  if (u && u.dia === today() && u.n >= USER_DAILY) return false;
  const lista = (acoesHora.get(guildId)?.[tipo] || []).filter((t) => agora - t < 3_600_000);
  return !(HOUR_CAPS[tipo] && lista.length >= HOUR_CAPS[tipo]);
}

function registrarAcao(guildId, userId, tipo) {
  const agora = Date.now();
  const k = `${guildId}:${userId}`;
  const u = acoesUsuario.get(k);
  acoesUsuario.set(k, { ult: agora, dia: today(), n: (u && u.dia === today() ? u.n : 0) + 1 });
  const g = acoesHora.get(guildId) || {};
  g[tipo] = [...(g[tipo] || []).filter((t) => agora - t < 3_600_000), agora];
  acoesHora.set(guildId, g);
}

/* ============================================================
 *  EFEITOS TEMPORÁRIOS (sobrevivem a reinício e sempre são desfeitos)
 * ============================================================ */
function guardarEfeito(efeito) {
  efeitosStore.data.efeitos.push({ id: `${Date.now()}${Math.floor(Math.random() * 1000)}`, ...efeito });
  efeitosStore.save();
}

async function desfazerEfeito(client, e, { forcar = false } = {}) {
  const guild = client.guilds.cache.get(e.guildId);
  if (!guild) return;
  if (e.tipo === 'nick') {
    const m = await guild.members.fetch(e.userId).catch(() => null);
    // só devolve se ainda estiver com o apelido da zoeira (não atropela quem trocou por conta própria)
    if (m && m.nickname === e.nome) await m.setNickname(e.original || null, 'Zoeira acabou').catch(() => {});
  } else if (e.tipo === 'cargo') {
    await guild.roles.cache.get(e.roleId)?.delete('Zoeira acabou').catch(() => {});
  } else if (e.tipo === 'timeout' && forcar) {
    const m = await guild.members.fetch(e.userId).catch(() => null);
    if (m && (m.communicationDisabledUntilTimestamp || 0) > Date.now()) await m.timeout(null, 'Zoeira desfeita').catch(() => {});
  }
}

/** Reverte o que já venceu. */
async function varrer(client) {
  const agora = Date.now();
  const vencidos = efeitosStore.data.efeitos.filter((e) => e.ate <= agora);
  if (!vencidos.length) return;
  for (const e of vencidos) await desfazerEfeito(client, e).catch((err) => console.error('[zoeira] desfazer:', err.message));
  efeitosStore.data.efeitos = efeitosStore.data.efeitos.filter((e) => e.ate > agora);
  efeitosStore.save();
}

/** Reverte AGORA os efeitos de um servidor (ou de uma pessoa). */
async function desfazerAgora(client, guildId, userId = null) {
  const alvo = efeitosStore.data.efeitos.filter((e) => e.guildId === guildId && (!userId || e.userId === userId));
  for (const e of alvo) await desfazerEfeito(client, e, { forcar: true }).catch(() => {});
  efeitosStore.data.efeitos = efeitosStore.data.efeitos.filter((e) => !alvo.includes(e));
  efeitosStore.save();
  return alvo.length;
}

function startZoeira(client) {
  setTimeout(() => varrer(client).catch(() => {}), 10_000).unref?.(); // o que ficou pendente de antes do reinício
  setInterval(() => varrer(client).catch((err) => console.error('[zoeira] varredura:', err.message)), 30_000).unref?.();
}

/* ============================================================
 *  DECISÃO (IA) E EXECUÇÃO (código, com todas as travas)
 * ============================================================ */
function sistemaZoeira(nivel, botNome) {
  const acoes = ['{"acao":"nada"}'];
  if (nivel.acoes.includes('responder')) acoes.push('{"acao":"responder","texto":"zoeira de até 160 caracteres"}');
  if (nivel.acoes.includes('reagir')) acoes.push('{"acao":"reagir","id":"<idMsg>","emoji":"🤡"}');
  if (nivel.acoes.includes('apelido')) acoes.push('{"acao":"apelido","alvo":"<idUsuario>","nome":"apelido engraçado de até 24 caracteres","texto":"comentário curto"}');
  if (nivel.acoes.includes('cargo')) acoes.push('{"acao":"cargo","alvo":"<idUsuario>","nome":"cargo de enfeite de até 20 caracteres","texto":"comentário curto"}');
  if (nivel.acoes.includes('mutar')) acoes.push('{"acao":"mutar","alvo":"<idUsuario>","segundos":10,"texto":"motivo engraçado"}');
  return `Você é ${botNome}, o bot zoeiro de um servidor de Discord de amigos brasileiros. Leia as últimas mensagens (formato [idMsg] nome (idUsuario): texto) e decida se vale UMA brincadeira agora. Seja engraçado, com gírias, zoeira leve e sem maldade.
NUNCA: ofensa pesada, preconceito, sexo, política, religião, família ou algo pessoal/sensível; nem zoar quem está triste, sério ou pedindo ajuda. Sem graça ou na dúvida: {"acao":"nada"}.
Responda SÓ com um JSON, uma destas ações:
${acoes.join('\n')}
Reaja ou responda na maioria das vezes; as outras só de vez em quando e só em quem está na conversa.`;
}

async function logZoeira(guild, texto) {
  const canal = guild.channels.cache.get(getGuildConfig(guild.id).logsChannel);
  if (!canal) return;
  await canal.send({
    embeds: [new EmbedBuilder().setColor(0xE67E22).setTitle('🎭 Zoeira automática').setDescription(truncate(texto, 1000)).setTimestamp()],
    allowedMentions: { parse: [] }
  }).catch(() => {});
}

async function alvoValido(guild, userId, z, participantes) {
  if (!userId || !participantes.has(String(userId))) return null; // só quem está na conversa
  const member = await guild.members.fetch(String(userId)).catch(() => null);
  if (!member || member.user.bot || member.id === guild.ownerId || member.id === guild.client.user.id) return null;
  if ((z.sair || []).includes(member.id)) return null;
  return member;
}

async function executar(message, dec, ctx) {
  const { guild, channel } = message;
  const { z, participantes, recentes } = ctx;
  const cfg = getGuildConfig(guild.id);

  /* ---- responder ---- */
  if (dec.acao === 'responder') {
    const texto = limpar(dec.texto, 180);
    if (!texto || ofensivo(texto)) return;
    await message.reply({ content: texto, allowedMentions: { parse: [], repliedUser: false } });
    return logZoeira(guild, `💬 Respondeu em <#${channel.id}>: ${texto}`);
  }

  /* ---- reagir ---- */
  if (dec.acao === 'reagir') {
    const emoji = String(dec.emoji || '').trim();
    if (!EMOJI_OK.test(emoji) || !recentes.some((m) => m.id === String(dec.id))) return;
    const alvo = await channel.messages.fetch(String(dec.id)).catch(() => null);
    if (alvo) await alvo.react(emoji);
    return;
  }

  /* ---- ações em pessoas ---- */
  const member = await alvoValido(guild, dec.alvo, z, participantes);
  if (!member || !podeAgir(guild.id, member.id, dec.acao)) return;
  const comentario = limpar(dec.texto, 160);
  if (comentario && ofensivo(comentario)) return;
  const fala = (detalhe) => channel.send({
    content: `${comentario ? `${comentario} ` : ''}(${detalhe})`,
    allowedMentions: { parse: [] }
  }).catch(() => {});

  if (dec.acao === 'apelido') {
    const nome = limpar(dec.nome, 24);
    if (!nome || ofensivo(nome) || FAZ_SE_PASSAR.test(normalize(nome)) || !member.manageable || member.displayName === nome) return;
    const original = member.nickname;
    await member.setNickname(nome, 'Zoeira automática');
    guardarEfeito({ guildId: guild.id, userId: member.id, tipo: 'nick', nome, original, ate: Date.now() + NICK_MS });
    registrarAcao(guild.id, member.id, 'apelido');
    await fala(`<@${member.id}> agora é **${nome}** por ${NICK_MS / 60_000} min`);
    return logZoeira(guild, `🏷️ Apelido de <@${member.id}> → **${nome}** (volta em ${NICK_MS / 60_000} min)`);
  }

  if (dec.acao === 'cargo') {
    const nome = limpar(dec.nome, 20);
    const ativos = efeitosStore.data.efeitos.filter((e) => e.guildId === guild.id && e.tipo === 'cargo').length;
    if (!nome || ofensivo(nome) || FAZ_SE_PASSAR.test(normalize(nome)) || ativos >= MAX_ROLES_ATIVOS) return;
    const role = await guild.roles.create({
      name: nome, color: CORES[Math.floor(Math.random() * CORES.length)], permissions: [], hoist: false, mentionable: false,
      reason: 'Zoeira automática (cargo de enfeite, sem permissões)'
    });
    const ancora = guild.roles.cache.get(cfg.setupRoles?.suporte);
    if (ancora) await placeRoleBelow(guild, role, ancora);
    try {
      await member.roles.add(role, 'Zoeira automática');
    } catch (err) {
      await role.delete('Zoeira: não consegui entregar').catch(() => {});
      throw err;
    }
    guardarEfeito({ guildId: guild.id, userId: member.id, tipo: 'cargo', roleId: role.id, ate: Date.now() + ROLE_MS });
    registrarAcao(guild.id, member.id, 'cargo');
    await fala(`<@${member.id}> ganhou o cargo **${nome}** por ${ROLE_MS / 60_000} min`);
    return logZoeira(guild, `🎖️ Cargo de enfeite **${nome}** para <@${member.id}> (some em ${ROLE_MS / 60_000} min)`);
  }

  if (dec.acao === 'mutar') {
    if (isStaff(member, cfg) || !member.moderatable) return; // a equipe nunca é silenciada
    const seg = Math.min(MUTE_MAX, Math.max(MUTE_MIN, Math.round(Number(dec.segundos) || 10)));
    await member.timeout(seg * 1000, 'Zoeira automática');
    guardarEfeito({ guildId: guild.id, userId: member.id, tipo: 'timeout', ate: Date.now() + seg * 1000 });
    registrarAcao(guild.id, member.id, 'mutar');
    await fala(`<@${member.id}> silenciado por ${seg}s`);
    return logZoeira(guild, `🤐 <@${member.id}> silenciado por ${seg}s`);
  }
}

async function decidirEAgir(message, recentes, z, nivel) {
  const participantes = new Map(recentes.map((m) => [m.uid, m.nome]));
  const linhas = recentes.map((m) => `[${m.id}] ${m.nome} (${m.uid}): ${m.texto}`).join('\n');
  const bot = message.client.user;
  const r = await ai.askGemini(linhas, {
    system: sistemaZoeira(nivel, bot.displayName || bot.username), json: true, temperature: 0.9, maxOutputTokens: 200
  });
  if (!r.texto) return; // IA indisponível: fica quieto, sem avisar ninguém
  const dec = lerJson(r.texto);
  if (!dec || !nivel.acoes.includes(dec.acao)) return;
  await executar(message, dec, { z, participantes, recentes });
}

/** Chamado a cada mensagem (depois dos comandos). Quase sempre não faz nada, de propósito. */
async function handleZoeiraMessage(message) {
  try {
    if (message.author.bot || !message.guild || !message.member) return;
    const z = zoeiraDe(message.guild.id);
    if (!z?.ligada || !z.canais?.includes(message.channel.id)) return;
    if ((z.sair || []).includes(message.author.id)) return; // quem saiu nem entra na conversa lida pela IA

    const texto = limpar(message.cleanContent, 140);
    if (!texto && !message.attachments?.size) return;
    const buf = buffers.get(message.channel.id) ?? [];
    buf.push({ id: message.id, uid: message.author.id, nome: limpar(message.member.displayName, 24) || 'alguém', texto: texto || '[anexo]', ts: Date.now() });
    while (buf.length > 10) buf.shift();
    buffers.set(message.channel.id, buf);

    if (SENSIVEL.test(normalize(texto))) { silencio.set(message.channel.id, Date.now() + 30 * 60_000); return; }
    if ((silencio.get(message.channel.id) || 0) > Date.now()) return;

    // Verificações baratas primeiro: só gasta a IA se tudo isso passar
    const nivel = NIVEIS[z.nivel] || NIVEIS.maluco;
    if (!ai.aiConfigured()) return;
    if (Date.now() - (ultimaDecisao.get(message.guild.id) || 0) < GAP_MS) return;
    const fora = new Set(z.sair || []); // quem saiu da zoeira some até do que a IA lê (inclusive mensagens antigas)
    const recentes = buf.filter((m) => Date.now() - m.ts < 10 * 60_000 && !fora.has(m.uid));
    if (recentes.length < 4 || new Set(recentes.map((m) => m.uid)).size < 2) return; // só quando há conversa de verdade
    if (Math.random() >= nivel.chance) return;
    if (!podeChamarIA(message.guild.id)) return;

    ultimaDecisao.set(message.guild.id, Date.now()); // antes do await: duas mensagens seguidas não disparam duas decisões
    await decidirEAgir(message, recentes, z, nivel);
  } catch (err) {
    console.error('[zoeira]', err.message);
  }
}

/* ============================================================
 *  COMANDO /zoeira
 * ============================================================ */
const zoeiraSlashCommands = [
  new SlashCommandBuilder().setName('zoeira').setDescription('Zoeira automática: o bot age sozinho no papo (liga/desliga, nível, canais, sair)')
    .addStringOption((o) => o.setName('acao').setDescription('O que fazer (vazio = ver o estado)').setRequired(false).addChoices(
      { name: 'Ver o estado', value: 'status' },
      { name: 'Ligar a zoeira automática (staff)', value: 'ligar' },
      { name: 'Desligar e desfazer tudo (staff)', value: 'desligar' },
      { name: 'Mudar o nível: leve, medio ou maluco (staff)', value: 'nivel' },
      { name: 'Ligar/desligar a zoeira num canal (staff)', value: 'canal' },
      { name: 'Desfazer apelidos, cargos e silenciamentos agora (staff)', value: 'desfazer' },
      { name: 'Não quero ser alvo da zoeira', value: 'sair' },
      { name: 'Voltar a participar da zoeira', value: 'entrar' }
    ))
    .addStringOption((o) => o.setName('nivel').setDescription('Nível, para a ação "nivel"').setRequired(false).addChoices(
      { name: 'leve (só reage e responde)', value: 'leve' },
      { name: 'medio (+ apelido e cargo)', value: 'medio' },
      { name: 'maluco (+ silenciar por segundos)', value: 'maluco' }
    ))
    .addChannelOption((o) => o.setName('canal').setDescription('Canal, para a ação "canal" (vazio = o atual)').setRequired(false).addChannelTypes(ChannelType.GuildText))
];

/** Canais de conversa criados pelo ?setup (ou o canal atual, se não houver). */
function canaisPadrao(guild, atual) {
  const ids = CANAIS_PADRAO.map((k) => getGuildConfig(guild.id).setupChannels?.[k]).filter((id) => id && guild.channels.cache.has(id));
  return ids.length ? ids : [atual.id];
}

function statusTexto(guild, userId) {
  const z = zoeiraDe(guild.id) || {};
  const nivel = NIVEIS[z.nivel] ? z.nivel : 'maluco';
  const hoje = chamadasDia.get(guild.id);
  const ativos = efeitosStore.data.efeitos.filter((e) => e.guildId === guild.id && e.ate > Date.now() && e.tipo !== 'timeout').length;
  return [
    `🎭 Zoeira automática: **${z.ligada ? 'LIGADA 🟢' : 'DESLIGADA 🔴'}**`,
    `🎚️ Nível: **${nivel}** (${NIVEIS[nivel].acoes.join(', ')})`,
    `📍 Canais: ${z.canais?.length ? z.canais.map((id) => `<#${id}>`).join(' ') : 'nenhum'}`,
    `🙋 Você: **${(z.sair || []).includes(userId) ? 'fora da zoeira' : 'participando'}**`,
    `⏳ Efeitos ativos: ${ativos} • decisões da IA hoje: ${hoje && hoje.dia === today() ? hoje.n : 0}/${DAILY_CALLS}`,
    '',
    `Equipe: \`${PREFIX}zoeira ligar\` • \`desligar\` • \`nivel leve|medio|maluco\` • \`canal #canal\` • \`desfazer\``,
    `Qualquer pessoa: \`${PREFIX}zoeira sair\` ou \`entrar\``
  ].join('\n');
}

const COMMANDS = {
  async zoeira(interaction) {
    if (!interaction.guild) return interaction.reply(eph('❌ Este comando só funciona dentro de um servidor.'));
    const { guild } = interaction;
    const acao = interaction.options.getString('acao') || 'status';
    const z = garantirZoeira(guild.id);

    if (acao === 'status') return interaction.reply(eph(statusTexto(guild, interaction.user.id)));

    if (acao === 'sair' || acao === 'entrar') {
      z.sair = z.sair.filter((id) => id !== interaction.user.id);
      if (acao === 'sair') {
        z.sair.push(interaction.user.id);
        await desfazerAgora(interaction.client, guild.id, interaction.user.id); // devolve apelido/cargo na hora
        for (const [canalId, lista] of buffers) buffers.set(canalId, lista.filter((m) => m.uid !== interaction.user.id)); // apaga o que já estava na memória
      }
      saveConfig();
      return interaction.reply(eph(acao === 'sair'
        ? '✅ Pronto! Você saiu da zoeira: o bot não mexe mais em você (nem lê suas mensagens para isso). Para voltar: `/zoeira entrar`.'
        : '🎭 Boa! Você voltou para a zoeira. Para sair de novo: `/zoeira sair`.'));
    }

    // daqui para baixo é só da equipe (a permissão já foi checada antes de chegar aqui)
    if (acao === 'ligar') {
      if (!ai.aiConfigured()) return interaction.reply(eph('🤖 A zoeira usa a IA, e ela ainda não está configurada (falta `GEMINI_API_KEY` no Render).'));
      z.ligada = true;
      if (!z.canais.some((id) => guild.channels.cache.has(id))) z.canais = canaisPadrao(guild, interaction.channel);
      saveConfig();
      await interaction.channel?.send({
        content: `🎭 **Zoeira automática LIGADA.** Posso reagir, responder, trocar apelidos, dar cargos de enfeite e até silenciar por segundos, de vez em quando e do nada. A equipe nunca é silenciada. Quem não quiser ser alvo: \`${PREFIX}zoeira sair\`.`,
        allowedMentions: { parse: [] }
      }).catch(() => {});
      return interaction.reply(eph(`✅ Ligada no nível **${z.nivel}**.\n\n${statusTexto(guild, interaction.user.id)}`));
    }

    if (acao === 'desligar') {
      z.ligada = false;
      saveConfig();
      const n = await desfazerAgora(interaction.client, guild.id);
      return interaction.reply(eph(`🔴 Zoeira desligada.${n ? ` Desfiz ${n} efeito(s) ativo(s).` : ''}`));
    }

    if (acao === 'nivel') {
      const nivel = interaction.options.getString('nivel');
      if (!NIVEIS[nivel]) return interaction.reply(eph(`Escolha o nível: \`leve\` (só reage e responde), \`medio\` (+ apelido e cargo) ou \`maluco\` (+ silenciar por segundos). Ex.: \`${PREFIX}zoeira nivel medio\``));
      z.nivel = nivel;
      saveConfig();
      return interaction.reply(eph(`🎚️ Nível **${nivel}**: ${NIVEIS[nivel].acoes.join(', ')}.`));
    }

    if (acao === 'canal') {
      const canal = interaction.options.getChannel('canal') || interaction.channel;
      if (canal.type !== ChannelType.GuildText) return interaction.reply(eph('❌ Escolha um canal de texto.'));
      const tem = z.canais.includes(canal.id);
      z.canais = tem ? z.canais.filter((id) => id !== canal.id) : [...z.canais, canal.id];
      saveConfig();
      return interaction.reply(eph(`${tem ? '🔇 Zoeira **desligada**' : '🎭 Zoeira **ligada**'} em <#${canal.id}>.`));
    }

    if (acao === 'desfazer') {
      const n = await desfazerAgora(interaction.client, guild.id);
      return interaction.reply(eph(n ? `↩️ Desfiz ${n} efeito(s): apelidos, cargos e silenciamentos voltaram ao normal.` : 'Não há nenhum efeito ativo para desfazer.'));
    }
  }
};

const handledCommands = Object.keys(COMMANDS);

async function handleZoeiraInteraction(interaction) {
  try {
    if (!interaction.isChatInputCommand()) return;
    if (!Object.hasOwn(COMMANDS, interaction.commandName)) return;
    await COMMANDS[interaction.commandName](interaction);
  } catch (err) {
    console.error('[interação/zoeira]', err);
    try {
      const aviso = describeError(err);
      if (aviso) await (interaction.replied || interaction.deferred ? interaction.followUp(eph(aviso)) : interaction.reply(eph(aviso)));
    } catch (_) { /* ignora */ }
  }
}

module.exports = {
  zoeiraSlashCommands, handledCommands, handleZoeiraInteraction, handleZoeiraMessage, startZoeira,
  canaisPadrao, garantirZoeira, desfazerAgora, varrer, NIVEIS
};
