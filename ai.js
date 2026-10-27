'use strict';

/**
 * IA que responde perguntas (usa a API da Anthropic, modelo Claude).
 * Funciona assim:  /perguntar ...   ?perguntar ...   ou marcando o bot: @Bot sua pergunta
 *
 * Variáveis de ambiente (Render > Environment):
 *   chave                  (obrigatória) chave criada em console.anthropic.com
 *   ANTHROPIC_MODEL        (opcional)    padrão: claude-haiku-5-5 (rápido e barato)
 *   AI_COOLDOWN_SECONDS    (opcional)    espera entre perguntas de cada pessoa (padrão 8)
 *   AI_DAILY_LIMIT         (opcional)    perguntas por pessoa por dia (padrão 40)
 */

const { SlashCommandBuilder } = require('discord.js');
const { eph, truncate, respond, describeError } = require('./utils');
const { getGuildConfig, ensureGuildConfig, saveConfig } = require('./ticket');
const { checkAccess } = require('./perms');

const API_KEY = process.env.chave || '';
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5';
const COOLDOWN_MS = (Number(process.env.AI_COOLDOWN_SECONDS) || 8) * 1000;
const DAILY_LIMIT = Number(process.env.AI_DAILY_LIMIT) || 40;
const GLOBAL_DAILY_LIMIT = Number(process.env.AI_GLOBAL_DAILY_LIMIT) || 500; // soma de todos os servidores
const MAX_QUESTION = 1000;
const MAX_OUTPUT_TOKENS = 700;

const SYSTEM_PROMPT = [
  'Você é o assistente de um servidor de Discord entre amigos.',
  'Responda sempre em português do Brasil, de forma clara, simpática e descontraída.',
  'Seja direto e curto: no máximo cerca de 1500 caracteres. Pode usar negrito e listas curtas, sem títulos grandes.',
  'Se não souber, ou se a resposta depender de informação em tempo real (notícias, placares, preços), diga isso com honestidade em vez de inventar.',
  'Recuse com educação pedidos perigosos, ilegais ou que firam alguém.'
].join(' ');

/* ============================================================
 *  LIMITES DE USO (protege o custo da API)
 * ============================================================ */
let globalUse = { dia: '', count: 0 };
const lastUse = new Map();
const dailyUse = new Map();
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });

function checkLimits(userId) {
  const agora = Date.now();
  const espera = COOLDOWN_MS - (agora - (lastUse.get(userId) || 0));
  if (espera > 0) return { erro: `⏳ Calma! Espera mais ${Math.ceil(espera / 1000)}s antes de perguntar de novo.` };

  const hoje = today();
  if (globalUse.dia === hoje && globalUse.count >= GLOBAL_DAILY_LIMIT) return { erro: '🚫 A IA atingiu o limite de perguntas de hoje (somando todos os servidores). Volte ammanhã!' };
  const d = dailyUse.get(userId);
  const usadas = d && d.dia === hoje ? d.count : 0;
  if (usadas >= DAILY_LIMIT) return { erro: `🚫 Você atingiu o limite de ${DAILY_LIMIT} perguntas por dia. Volte ammanhã!` };
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
 *  CHAMADA À API
 * ============================================================ */
async function askClaude(pergunta) {
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_OUTPUT_TOKENS,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: pergunta }]
      }),
      signal: AbortSignal.timeout(30000)
    });

    if (!res.ok) {
      const corpo = await res.text().catch(() => '');
      console.error(`[ia] API respondeu ${res.status}: ${corpo.slice(0, 300)}`);
      if (res.status === 401) return { erro: '🔑 A chave da API é inválida. Avise o dono do bot.' };
      if (res.status === 429) return { erro: '🚦 A IA está com muitos pedidos agora. Tente de novo em instantes.' };
      if (res.status === 404) return { erro: '🤖 O modelo configurado não existe. Avise o dono do bot (ANTHROPIC_MODEL).' };
      return { erro: '❌ A IA não conseguiu responder agora. Tente de novo mais tarde.' };
    }

    const data = await res.json();
    const texto = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    return texto ? { texto } : { erro: '🤔 Não consegui pensar em uma resposta. Tente reformular.' };
  } catch (err) {
    console.error('[ia] falha na chamada:', err.message);
    return { erro: err.name === 'TimeoutError' ? '⌛ A IA demorou demais para responder. Tente de novo.' : '❌ Não consegui falar com a IA agora.' };
  }
}

const formatAnswer = (pergunta, texto) => `> ❓ ${truncate(pergunta.replace(/\n+/g, ' '), 180)}\n\n${truncate(texto, 1750)}`;

/* ============================================================
 *  COMANDOS
 * ============================================================ */
const aiSlashCommands = [
  new SlashCommandBuilder().setName('perguntar').setDescription('Faz uma pergunta à inteligência artificial')
    .addStringOption(o => o.setName('pergunta').setDescription('O que você quer saber?').setRequired(true).setMaxLength(MAX_QUESTION)),
  new SlashCommandBuilder().setName('ia').setDescription('Liga ou desliga a IA neste servidor (staff)')
    .addBooleanOption(o => o.setName('status').setDescription('Ligada ou desligada').setRequired(true))
];

const COMMANDS = {
  async perguntar(interaction) {
    if (!API_KEY) return interaction.reply(eph('🤖 A IA ainda não está configurada (falta a variável `chave` no Render).'));
    if (interaction.guild && getGuildConfig(interaction.guild.id).aiEnabled === false) {
      return interaction.reply(eph('🤖 A IA está desligada neste servidor.'));
    }

    const limites = checkLimits(interaction.user.id);
    if (limites.erro) return interaction.reply(eph(limites.erro));

    const pergunta = interaction.options.getString('pergunta');
    await interaction.deferReply();
    registerUse(interaction.user.id, limites);

    const resp = await askClaude(pergunta);
    await interaction.editReply({ content: resp.erro || formatAnswer(pergunta, resp.texto), allowedMentions: { parse: [] } });
  },

  async ia(interaction) {
    if (!interaction.guild) return interaction.reply(eph('❌ Este comando só funciona dentro de um servidor.'));
    const negado = checkAccess(interaction, { strict: true });
    if (negado) return interaction.reply(eph(negado));

    const ligada = interaction.options.getBoolean('status');
    ensureGuildConfig(interaction.guild.id).aiEnabled = ligada;
    saveConfig();
    await interaction.reply(eph(`✅ IA ${ligada ? '**ligada**' : '**desligada**'} neste servidor.`));
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
    if (getGuildConfig(message.guild.id).aiEnabled === false) return false;

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
    registerUse(message.author.id, limites);

    await message.channel.sendTyping().catch(() => {});
    const resp = await askClaude(pergunta);
    await message.reply({ content: resp.erro || formatAnswer(pergunta, resp.texto), allowedMentions: { parse: [], repliedUser: false } });
    return true;
  } catch (err) {
    console.error('[ia/menção]', err.message);
    return false;
  }
}

module.exports = { aiSlashCommands, handledCommands, handleAiInteraction, handleAiMention };
