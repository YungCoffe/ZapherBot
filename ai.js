'use strict';

/**
 * IA que responde perguntas — Google Gemini (modelo gemini-3.1-flash-lite).
 *   /perguntar ...   ?perguntar ...   ou marcando o bot:  @Bot sua pergunta
 *   ?ia on | ?ia off   liga/desliga neste servidor (precisa de "Gerenciar Servidor");  ?ia  mostra o estado
 *
 * Variáveis de ambiente (Render > Environment):
 *   GEMINI_API_KEY            (obrigatória) chave criada em aistudio.google.com/apikey
 *                             ⚠️ NUNCA coloque a chave no código nem em chat/print: só aqui.
 *   GEMINI_MODEL              (opcional) padrão: gemini-3.1-flash-lite
 *   GEMINI_FALLBACK_MODELS    (opcional) modelos tentados se o principal não existir (separados por vírgula)
 *   AI_DEFAULT                (opcional) "off" = vem DESLIGADA em servidores que nunca usaram /ia
 *   AI_COOLDOWN_SECONDS       (opcional) espera entre perguntas de cada pessoa (padrão 8)
 *   AI_DAILY_LIMIT            (opcional) perguntas por pessoa por dia (padrão 30)
 *   AI_GLOBAL_DAILY_LIMIT     (opcional) perguntas por dia somando todos os servidores (padrão 400)
 *
 * Economia de tokens: instrução curta, pergunta limitada a 500 caracteres, resposta limitada a ~350 tokens,
 * SEM histórico de conversa e com cache de respostas repetidas (perguntas iguais não gastam nada).
 */

const { SlashCommandBuilder } = require('discord.js');
const { eph, truncate, normalize, respond, describeError } = require('./utils');
const { getGuildConfig, ensureGuildConfig, saveConfig } = require('./ticket');
const { checkAccess } = require('./perms');

const API_KEY = process.env.GEMINI_API_KEY || '';
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite';
const FALLBACK_MODELS = (process.env.GEMINI_FALLBACK_MODELS || 'gemini-2.5-flash-lite')
  .split(',').map((m) => m.trim()).filter(Boolean);
const COOLDOWN_MS = (Number(process.env.AI_COOLDOWN_SECONDS) || 8) * 1000;
const DAILY_LIMIT = Number(process.env.AI_DAILY_LIMIT) || 30;
const GLOBAL_DAILY_LIMIT = Number(process.env.AI_GLOBAL_DAILY_LIMIT) || 400;
const MAX_QUESTION = 500;        // caracteres da pergunta
const MAX_OUTPUT_TOKENS = 350;   // ~1.000 caracteres de resposta
const CACHE_TTL = 6 * 60 * 60_000;
const CACHE_MAX = 300;

// Instrução curta de propósito: ela é enviada a cada pergunta e conta como token de entrada.
const SYSTEM_PROMPT = 'Assistente de um servidor de Discord. Responda em português do Brasil, direto e curto (máx. ~800 caracteres). Se não souber ou depender de dados em tempo real, diga isso. Recuse pedidos perigosos ou ilegais.';

/** Ligada neste servidor? (padrão: ligada, a menos que AI_DEFAULT=off ou a staff tenha desligado) */
const aiEnabled = (guildId) => getGuildConfig(guildId).aiEnabled ?? (process.env.AI_DEFAULT !== 'off');

/* ============================================================
 *  LIMITES DE USO
 * ============================================================ */
let globalUse = { dia: '', count: 0 };
const lastUse = new Map();
const dailyUse = new Map();
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });

function checkLimits(userId) {
  const agora = Date.now();
  const espera = COOLDOWN_MS - (agora - (lastUse.get(userId) || 0));
  if (espera > 0) return { erro: `⏳ Calma! Espere mais ${Math.ceil(espera / 1000)}s antes de perguntar de novo.` };

  const hoje = today();
  if (globalUse.dia === hoje && globalUse.count >= GLOBAL_DAILY_LIMIT) return { erro: '🚫 A IA atingiu o limite de perguntas de hoje (somando todos os servidores). Volte amanhã!' };
  const d = dailyUse.get(userId);
  const usadas = d && d.dia === hoje ? d.count : 0;
  if (usadas >= DAILY_LIMIT) return { erro: `🚫 Você atingiu o limite de ${DAILY_LIMIT} perguntas por dia. Volte amanhã!` };
  return { hoje, usadas };
}

function registerUse(userId, { hoje, usadas }) {
  lastUse.set(userId, Date.now());
  dailyUse.set(userId, { dia: hoje, count: usadas + 1 });
  globalUse = { dia: hoje, count: (globalUse.dia === hoje ? globalUse.count : 0) + 1 };
  if (lastUse.size > 1000) {
    const limite = Date.now() - COOLDOWN_MS;
    for (const [id, t] of lastUse) if (t < limite) lastUse.delete(id);
  }
}

/* ============================================================
 *  CACHE (pergunta repetida = resposta grátis, sem gastar token)
 * ============================================================ */
const cache = new Map();
const cacheKey = (pergunta) => normalize(pergunta).replace(/[^a-z0-9 ]+/g, '').replace(/\s+/g, ' ').trim();

function cacheGet(pergunta) {
  const k = cacheKey(pergunta);
  const hit = cache.get(k);
  if (!hit) return null;
  if (hit.exp < Date.now()) { cache.delete(k); return null; }
  return hit.texto;
}

function cacheSet(pergunta, texto) {
  const k = cacheKey(pergunta);
  if (!k) return;
  cache.delete(k);
  cache.set(k, { texto, exp: Date.now() + CACHE_TTL });
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value); // descarta a mais antiga
}

/* ============================================================
 *  CHAMADA À API DO GEMINI
 * ============================================================ */
let workingModel = null; // último modelo que funcionou
let lastFailure = null;  // aparece no ?ia

function explain(status, apiStatus = '', message = '') {
  const m = String(message).toLowerCase();
  if (m.includes('api key not valid') || m.includes('api_key_invalid') || status === 401) return '🔑 A chave da API é inválida ou foi revogada. O dono precisa atualizar a `GEMINI_API_KEY`.';
  if (status === 403 || apiStatus === 'PERMISSION_DENIED') return '🚫 A chave não tem permissão para usar este modelo (ou o serviço não está liberado na sua região).';
  if (status === 404 || apiStatus === 'NOT_FOUND') return '🤖 O modelo configurado não existe. Defina `GEMINI_MODEL` com um modelo válido.';
  if (status === 429 || apiStatus === 'RESOURCE_EXHAUSTED') return '🚦 O limite de uso da IA foi atingido (por minuto ou por dia). Tente de novo daqui a pouco.';
  if (status >= 500) return '🛠️ O serviço da IA está sobrecarregado ou fora do ar agora. Tente de novo daqui a pouco.';
  if (status === 400) return '❌ A IA recusou essa pergunta. Tente reformular.';
  return '❌ A IA não conseguiu responder agora. Tente de novo mais tarde.';
}

async function callModel(model, pergunta) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': API_KEY },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: 'user', parts: [{ text: pergunta }] }],
      generationConfig: { maxOutputTokens: MAX_OUTPUT_TOKENS, temperature: 0.7 }
    }),
    signal: AbortSignal.timeout(30000)
  });
  const corpo = await res.json().catch(() => null);
  return { res, corpo };
}

async function askGemini(pergunta) {
  const modelos = [...new Set([workingModel, MODEL, ...FALLBACK_MODELS].filter(Boolean))];
  let ultimo = null;

  for (const model of modelos) {
    try {
      const { res, corpo } = await callModel(model, pergunta);
      if (res.ok) {
        const candidato = corpo?.candidates?.[0];
        const texto = (candidato?.content?.parts || []).filter((p) => p.text && !p.thought).map((p) => p.text).join('').trim();
        workingModel = model;
        lastFailure = null;
        if (!texto) {
          const bloqueada = corpo?.promptFeedback?.blockReason || candidato?.finishReason === 'SAFETY';
          return { erro: bloqueada ? '🙈 Não posso responder a esse tipo de pergunta.' : '🤔 Não consegui pensar em uma resposta. Tente reformular a pergunta.' };
        }
        return { texto: candidato.finishReason === 'MAX_TOKENS' ? `${texto}…` : texto };
      }
      const apiStatus = corpo?.error?.status;
      const msg = corpo?.error?.message || '';
      console.error(`[ia] modelo ${model} -> HTTP ${res.status} ${apiStatus || ''}: ${msg.slice(0, 200)}`);
      ultimo = { status: res.status, apiStatus, msg };
      // modelo inexistente: tenta o próximo; qualquer outro erro não adianta trocar de modelo
      if (!(res.status === 404 || apiStatus === 'NOT_FOUND')) break;
    } catch (err) {
      console.error('[ia] falha na chamada:', err.message);
      lastFailure = { texto: err.message };
      return { erro: err.name === 'TimeoutError' ? '⌛ A IA demorou demais para responder. Tente de novo.' : '❌ Não consegui falar com a IA agora (sem conexão com o serviço). Tente de novo.' };
    }
  }
  lastFailure = { texto: `HTTP ${ultimo?.status} ${ultimo?.apiStatus || ''} ${truncate(ultimo?.msg || '', 150)}` };
  return { erro: explain(ultimo?.status, ultimo?.apiStatus, ultimo?.msg) };
}

/** Responde uma pergunta: usa o cache quando possível (não gasta token nem cota diária). */
async function answer(pergunta, userId, limites) {
  const guardada = cacheGet(pergunta);
  if (guardada) {
    lastUse.set(userId, Date.now()); // só o tempo de espera conta
    return { texto: guardada, cached: true };
  }
  registerUse(userId, limites);
  const r = await askGemini(pergunta);
  if (r.texto) cacheSet(pergunta, r.texto);
  return r;
}

const formatAnswer = (pergunta, texto) => `> ❓ ${truncate(pergunta.replace(/\n+/g, ' '), 150)}\n\n${truncate(texto, 1800)}`;

/* ============================================================
 *  COMANDOS
 * ============================================================ */
const aiSlashCommands = [
  new SlashCommandBuilder().setName('perguntar').setDescription('Faz uma pergunta à inteligência artificial')
    .addStringOption(o => o.setName('pergunta').setDescription('O que você quer saber?').setRequired(true).setMaxLength(MAX_QUESTION)),
  new SlashCommandBuilder().setName('ia').setDescription('Liga/desliga a IA neste servidor, ou mostra se está ligada (staff)')
    .addBooleanOption(o => o.setName('status').setDescription('Ligada ou desligada (vazio = ver o estado atual)').setRequired(false))
];

const COMMANDS = {
  async perguntar(interaction) {
    if (!API_KEY) return interaction.reply(eph('🤖 A IA ainda não está configurada (falta a variável `GEMINI_API_KEY` no Render).'));
    if (interaction.guild && !aiEnabled(interaction.guild.id)) {
      return interaction.reply(eph('🤖 A IA está **desligada** neste servidor. Quem tem *Gerenciar Servidor* liga com `/ia status:sim` (ou `?ia on`).'));
    }

    const limites = checkLimits(interaction.user.id);
    if (limites.erro) return interaction.reply(eph(limites.erro));

    const pergunta = interaction.options.getString('pergunta').trim().slice(0, MAX_QUESTION);
    await interaction.deferReply();
    const resp = await answer(pergunta, interaction.user.id, limites);
    await interaction.editReply({ content: resp.erro || formatAnswer(pergunta, resp.texto), allowedMentions: { parse: [] } });
  },

  async ia(interaction) {
    if (!interaction.guild) return interaction.reply(eph('❌ Este comando só funciona dentro de um servidor.'));
    const negado = checkAccess(interaction, { strict: true });
    if (negado) return interaction.reply(eph(negado));

    const novo = interaction.options.getBoolean('status');
    if (novo !== null) {
      ensureGuildConfig(interaction.guild.id).aiEnabled = novo;
      saveConfig();
    }
    const ligada = aiEnabled(interaction.guild.id);
    const linhas = [
      `${novo !== null ? '✅ Alterado! ' : ''}A IA está **${ligada ? 'LIGADA 🟢' : 'DESLIGADA 🔴'}** neste servidor.`,
      `🔑 Chave da API: ${API_KEY ? 'configurada' : '**não configurada** (falta `GEMINI_API_KEY`)'}`,
      `🧠 Modelo: \`${workingModel || MODEL}\``,
      `📦 Respostas guardadas em cache: ${cache.size}`
    ];
    if (lastFailure) linhas.push(`⚠️ Último erro: ${truncate(lastFailure.texto, 200)}`);
    linhas.push('', ligada ? 'Desligue com `?ia off`.' : 'Ligue com `?ia on`.');
    return interaction.reply({ content: linhas.join('\n'), flags: 64 });
  }
};

const handledCommands = Object.keys(COMMANDS);

async function handleAiInteraction(interaction) {
  try {
    if (!interaction.isChatInputCommand()) return;
    if (!Object.hasOwn(COMMANDS, interaction.commandName)) return;
    await COMMANDS[interaction.commandName](interaction);
  } catch (err) {
    console.error('[interação/ia]', err);
    try { const aviso = describeError(err); if (aviso) await respond(interaction, eph(aviso)); } catch (_) { /* ignora */ }
  }
}

/** Responde quando alguém marca o bot com uma pergunta. Devolve true se tratou a mensagem. */
async function handleAiMention(message) {
  try {
    if (message.author.bot || !message.guild || !API_KEY) return false;
    const bot = message.client.user;
    if (!message.mentions.has(bot, { ignoreRepliedUser: true, ignoreEveryone: true, ignoreRoles: true })) return false;
    if (!aiEnabled(message.guild.id)) return false; // desligada: ignora a marcação em silêncio

    const pergunta = message.content.replace(new RegExp(`<@!?${bot.id}>`, 'g'), '').trim().slice(0, MAX_QUESTION);
    if (!pergunta) {
      await message.reply({ content: 'Fala! Me marque com uma pergunta ou use `/perguntar` 😉', allowedMentions: { repliedUser: false } });
      return true;
    }

    const limites = checkLimits(message.author.id);
    if (limites.erro) {
      await message.reply({ content: limites.erro, allowedMentions: { repliedUser: false } });
      return true;
    }

    await message.channel.sendTyping().catch(() => {});
    const resp = await answer(pergunta, message.author.id, limites);
    await message.reply({ content: resp.erro || formatAnswer(pergunta, resp.texto), allowedMentions: { parse: [], repliedUser: false } });
    return true;
  } catch (err) {
    console.error('[ia/menção]', err.message);
    return false;
  }
}

module.exports = { aiSlashCommands, handledCommands, handleAiInteraction, handleAiMention, aiEnabled, askGemini, answer, cacheGet };
