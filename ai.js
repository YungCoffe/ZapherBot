'use strict';

/**
 * IA que responde perguntas: Google Gemini, com ESCOLHA AUTOMÁTICA DE MODELO.
 *   /perguntar ...   ?perguntar ...   ou marcando o bot:  @Bot sua pergunta
 *   ?ia on | ?ia off   liga/desliga neste servidor (precisa de "Gerenciar Servidor");  ?ia  mostra o estado
 *   ?ia testar         roda pelos modelos, do mais barato ao mais caro, até achar o primeiro que responde
 *   ?ia comparar       testa TODOS os modelos de texto e fica com o que gasta menos token
 *
 * Como o modelo é escolhido: o bot tenta os modelos em ordem de custo (lite -> flash -> gemma -> pro). Se um não
 * existe, está sem cota (429) ou fora do ar (5xx), ele é posto "em espera" e a pergunta segue para o próximo, sem o
 * usuário perceber. Modelos de voz, imagem, música, embeddings e agentes ficam de fora (não respondem texto).
 *
 * Variáveis de ambiente (Render > Environment):
 *   GEMINI_API_KEY            (obrigatória) chave criada em aistudio.google.com/apikey
 *                             ⚠️ NUNCA coloque a chave no código nem em chat/print: só aqui.
 *   GEMINI_MODEL              (opcional) FORÇA um modelo como primeira escolha. Vazio ou "auto" = automático
 *   GEMINI_FALLBACK_MODELS    (opcional) modelos extras tentados logo depois do forçado (separados por vírgula)
 *   AI_DEFAULT                (opcional) "off" = vem DESLIGADA em servidores que nunca usaram /ia
 *   AI_COOLDOWN_SECONDS       (opcional) espera entre perguntas de cada pessoa (padrão 8)
 *   AI_DAILY_LIMIT            (opcional) perguntas por pessoa por dia (padrão 30)
 *   AI_GLOBAL_DAILY_LIMIT     (opcional) perguntas por dia somando todos os servidores (padrão 400)
 *
 * Economia de tokens: instrução curta, pergunta limitada a 500 caracteres, resposta limitada a ~350 tokens, "pensamento"
 * do modelo reduzido ao mínimo, SEM histórico de conversa e com cache de respostas repetidas (pergunta igual não gasta nada).
 */

const { SlashCommandBuilder } = require('discord.js');
const { eph, truncate, normalize, respond, describeError, PREFIX } = require('./utils');
const { getGuildConfig, ensureGuildConfig, saveConfig } = require('./ticket');
const { checkAccess } = require('./perms');
const { JsonStore } = require('./storage');

const API_KEY = process.env.GEMINI_API_KEY || '';
const MODEL_FORCADO = /^(auto)?$/i.test(process.env.GEMINI_MODEL || '') ? '' : process.env.GEMINI_MODEL.trim();
const FALLBACK_FORCADOS = (process.env.GEMINI_FALLBACK_MODELS || '').split(',').map((m) => m.trim()).filter(Boolean);
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
 *  MODELOS: usa sempre o mais econômico que está funcionando
 * ============================================================ */
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const MAX_TENTATIVAS = 10;         // modelos tentados por pergunta
const ORCAMENTO_MS = 60_000;       // tempo máximo somando todas as tentativas
const TIMEOUT_MS = 20_000;         // por tentativa
const PROBE_PROMPT = 'Responda apenas: ok';

/**
 * Ordem de tentativa: do mais econômico ao mais caro. Só entram modelos que respondem texto.
 * (Se o Google liberar modelos novos, eles entram no fim da fila sozinhos, pela lista da própria API.)
 */
const MODELOS_ORDEM = [
  // 1) Lite: os mais baratos
  'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-2.5-flash-lite', 'gemini-3.1-flash-lite-preview', 'gemini-flash-lite-latest',
  // 2) Flash
  'gemini-2.5-flash', 'gemini-3.5-flash', 'gemini-3-flash-preview', 'gemini-3.6-flash', 'gemini-3.7-flash', 'gemini-3.8-flash', 'gemini-flash-latest',
  // 3) Gemma (não "pensam", mas não aceitam instrução de sistema: ela vai junto da pergunta)
  'gemma-4-26b-a4b-it', 'gemma-4-31b-it',
  // 4) Pro: os mais caros
  'gemini-2.5-pro', 'gemini-3.1-pro-preview', 'gemini-pro-latest',
  // 5) Sem tipo claro: último recurso
  'gemini-4-argon', 'gemini-omni-flash-preview', 'gemini-omni-1.1-flash'
];

/** Modelos que NÃO respondem perguntas em texto (voz, imagem, música, embeddings, robótica, agentes...). */
const MODELOS_EXCLUIDOS = /(tts|image|embedding|lyria|robotics|computer-use|transcribe|antigravity|deep-research|aqa|customtools|nano-banana|live|veo|imagen)/i;

const modeloStore = new JsonStore('ai-modelo.json', { fallback: { preferido: null, ruins: {} } });
modeloStore.data.ruins ??= {};

let catalogo = [...MODELOS_ORDEM];
let catalogoEm = 0;
let workingModel = null; // último modelo que respondeu
let lastFailure = null;  // aparece no ?ia
let testando = false;
const perfis = new Map(); // model -> { thinking, sistema } (aprende o que cada modelo aceita)
const uso = { dia: '', respostas: 0, entrada: 0, saida: 0, pensamento: 0 };

/** Pensamento mínimo: é o que mais gasta token escondido. Se o modelo recusar, o bot aprende e tenta sem. */
function thinkingInicial(model) {
  if (/^gemma/i.test(model)) return null;
  if (/2\.5/.test(model)) return /pro/i.test(model) ? { thinkingBudget: 128 } : { thinkingBudget: 0 };
  if (/pro/i.test(model)) return { thinkingLevel: 'low' };
  return { thinkingLevel: 'minimal' };
}

function perfilDe(model) {
  if (!perfis.has(model)) perfis.set(model, { thinking: thinkingInicial(model), sistema: !/^gemma/i.test(model) });
  return perfis.get(model);
}

/** Monta a lista de modelos: forçados -> ordem de custo -> modelos novos que a API listar. */
async function garantirCatalogo(force = false) {
  if (!force && Date.now() - catalogoEm < 12 * 60 * 60_000) return;
  catalogoEm = Date.now();
  let disponiveis = null;
  try {
    const res = await fetch(`${API_BASE}/models?pageSize=1000`, { headers: { 'x-goog-api-key': API_KEY }, signal: AbortSignal.timeout(10_000) });
    if (res.ok) {
      const corpo = await res.json();
      disponiveis = new Set((corpo.models || [])
        .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
        .map((m) => String(m.name).replace(/^models\//, '')));
    }
  } catch (err) {
    console.warn('[ia] não consegui listar os modelos (uso a lista padrão):', err.message);
  }
  const conhecidos = MODELOS_ORDEM.filter((m) => !disponiveis || disponiveis.has(m));
  const novos = disponiveis
    ? [...disponiveis].filter((m) => /^(gemini|gemma)/.test(m) && !MODELOS_EXCLUIDOS.test(m) && !MODELOS_ORDEM.includes(m)).sort()
    : [];
  catalogo = [...new Set([MODEL_FORCADO, ...FALLBACK_FORCADOS, ...conhecidos, ...novos].filter(Boolean))];
}

const emEspera = (model) => (modeloStore.data.ruins[model]?.ate || 0) > Date.now();

function marcarRuim(model, ms, motivo) {
  modeloStore.data.ruins[model] = { ate: Date.now() + ms, motivo };
  if (ms >= 10 * 60_000) modeloStore.save();
}

function ordemDeTentativa() {
  const { preferido } = modeloStore.data;
  const lista = preferido && catalogo.includes(preferido) ? [preferido, ...catalogo.filter((m) => m !== preferido)] : catalogo;
  return lista.filter((m) => !emEspera(m));
}

function explain(status, apiStatus = '', message = '') {
  const m = String(message).toLowerCase();
  if (m.includes('api key not valid') || m.includes('api_key_invalid') || status === 401) return '🔑 A chave da API é inválida ou foi revogada. O dono precisa atualizar a `GEMINI_API_KEY`.';
  if (status === 403 || apiStatus === 'PERMISSION_DENIED') return '🚫 A chave não tem permissão para usar os modelos (ou o serviço não está liberado na sua região).';
  if (status === 404 || apiStatus === 'NOT_FOUND') return `🤖 Nenhum dos modelos de IA respondeu. O dono pode usar \`${PREFIX}ia testar\` para ver o que está acontecendo.`;
  if (status === 429 || apiStatus === 'RESOURCE_EXHAUSTED') return '🚦 O limite de uso da IA foi atingido (por minuto ou por dia). Tente de novo daqui a pouco.';
  if (status >= 500) return '🛠️ O serviço da IA está sobrecarregado ou fora do ar agora. Tente de novo daqui a pouco.';
  if (status === 400) return '❌ A IA recusou essa pergunta. Tente reformular.';
  return '❌ A IA não conseguiu responder agora. Tente de novo mais tarde.';
}

async function requisitar(model, pergunta, perfil, maxOutputTokens, timeout) {
  const generationConfig = { maxOutputTokens, temperature: 0.7 };
  if (perfil.thinking) generationConfig.thinkingConfig = perfil.thinking;
  const body = perfil.sistema
    ? { systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] }, contents: [{ role: 'user', parts: [{ text: pergunta }] }], generationConfig }
    : { contents: [{ role: 'user', parts: [{ text: `${SYSTEM_PROMPT}\n\nPergunta: ${pergunta}` }] }], generationConfig };
  const res = await fetch(`${API_BASE}/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': API_KEY },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout)
  });
  const corpo = await res.json().catch(() => null);
  return { res, corpo };
}

/** Chama um modelo. Se ele recusar "pensamento" ou "instrução de sistema", aprende e repete sem isso. */
async function chamar(model, pergunta, { maxOutputTokens = MAX_OUTPUT_TOKENS, timeout = TIMEOUT_MS } = {}) {
  const perfil = perfilDe(model);
  try {
    for (let i = 0; i < 3; i++) {
      const { res, corpo } = await requisitar(model, pergunta, perfil, maxOutputTokens, timeout);
      if (res.ok) return { ok: true, corpo };
      const msg = corpo?.error?.message || '';
      const m = msg.toLowerCase();
      if (res.status === 400 && perfil.thinking && /think/.test(m)) { perfil.thinking = null; continue; }
      if (res.status === 400 && perfil.sistema && /(developer|system) instruction|systeminstruction/.test(m)) { perfil.sistema = false; continue; }
      const retry = JSON.stringify(corpo?.error?.details || []).match(/"retryDelay":"(\d+(?:\.\d+)?)s"/);
      return { ok: false, status: res.status, apiStatus: corpo?.error?.status, msg, retryMs: retry ? Math.ceil(Number(retry[1]) * 1000) : 0 };
    }
    return { ok: false, status: 400, msg: 'o modelo recusou a configuração' };
  } catch (err) {
    return { ok: false, rede: true, timeout: err.name === 'TimeoutError', msg: err.message };
  }
}

/** O que fazer depois de uma falha: tentar o próximo modelo (e por quanto tempo esse fica de lado), parar ou devolver o erro. */
function classificar(f) {
  const m = String(f.msg || '').toLowerCase();
  if (f.status === 401 || /api key not valid|api_key_invalid/.test(m)) return { acao: 'parar' };
  if (f.status === 404 || f.apiStatus === 'NOT_FOUND' || /not supported for generatecontent|is not found|does not support|not supported/.test(m)) {
    return { acao: 'proximo', ate: 24 * 60 * 60_000, motivo: 'não existe / sem suporte' };
  }
  if (f.status === 429 || f.apiStatus === 'RESOURCE_EXHAUSTED') {
    const diario = /perday|per day|daily/.test(m);
    return { acao: 'proximo', ate: diario ? 6 * 60 * 60_000 : Math.max(f.retryMs || 0, 60_000), motivo: diario ? 'limite diário' : 'limite por minuto' };
  }
  if (f.status === 403 || f.apiStatus === 'PERMISSION_DENIED') return { acao: 'proximo', ate: 60 * 60_000, motivo: 'sem permissão' };
  if (f.status >= 500) return { acao: 'proximo', ate: 2 * 60_000, motivo: 'instável' };
  if (f.status === 400) return { acao: 'pedido' }; // o pedido é que foi recusado: trocar de modelo não resolve
  return { acao: 'proximo', ate: 5 * 60_000, motivo: `erro ${f.status}` };
}

function tokensDe(corpo) {
  const u = corpo?.usageMetadata || {};
  const entrada = u.promptTokenCount || 0;
  const saida = u.candidatesTokenCount || 0;
  const pensamento = u.thoughtsTokenCount || 0;
  return { entrada, saida, pensamento, total: u.totalTokenCount || entrada + saida + pensamento };
}

const textoDe = (corpo) => (corpo?.candidates?.[0]?.content?.parts || []).filter((p) => p.text && !p.thought).map((p) => p.text).join('').trim();

function registrarTokens(corpo) {
  const hoje = today();
  if (uso.dia !== hoje) Object.assign(uso, { dia: hoje, respostas: 0, entrada: 0, saida: 0, pensamento: 0 });
  const t = tokensDe(corpo);
  uso.respostas++;
  uso.entrada += t.entrada;
  uso.saida += t.saida;
  uso.pensamento += t.pensamento;
}

async function askGemini(pergunta) {
  await garantirCatalogo();
  const lista = ordemDeTentativa();
  if (!lista.length) {
    const volta = Math.min(...Object.values(modeloStore.data.ruins).map((r) => r.ate));
    lastFailure = { texto: 'todos os modelos estão em espera' };
    return { erro: `🚦 Todos os modelos de IA estão no limite ou fora do ar agora. Tente de novo em ~${Math.max(1, Math.ceil((volta - Date.now()) / 60_000))} min.` };
  }

  const inicio = Date.now();
  let ultimo = null;
  for (const model of lista.slice(0, MAX_TENTATIVAS)) {
    if (Date.now() - inicio > ORCAMENTO_MS) break;
    const r = await chamar(model, pergunta);

    if (r.ok) {
      const candidato = r.corpo?.candidates?.[0];
      const texto = textoDe(r.corpo);
      registrarTokens(r.corpo);
      if (texto) {
        workingModel = model;
        lastFailure = null;
        return { texto: candidato.finishReason === 'MAX_TOKENS' ? `${texto}…` : texto, model };
      }
      if (r.corpo?.promptFeedback?.blockReason || candidato?.finishReason === 'SAFETY') {
        workingModel = model;
        return { erro: '🙈 Não posso responder a esse tipo de pergunta.' };
      }
      ultimo = { status: 200, msg: 'resposta vazia' };
      marcarRuim(model, 5 * 60_000, 'resposta vazia');
      continue;
    }

    ultimo = r;
    console.error(`[ia] modelo ${model} -> ${r.rede ? r.msg : `HTTP ${r.status} ${r.apiStatus || ''}: ${String(r.msg).slice(0, 160)}`}`);
    if (r.rede && !r.timeout) {
      lastFailure = { texto: r.msg };
      return { erro: '❌ Não consegui falar com a IA agora (sem conexão com o serviço). Tente de novo.' };
    }
    if (r.timeout) { marcarRuim(model, 2 * 60_000, 'demorou demais'); continue; }
    const c = classificar(r);
    if (c.acao === 'parar' || c.acao === 'pedido') break;
    marcarRuim(model, c.ate, c.motivo);
  }

  lastFailure = { texto: `HTTP ${ultimo?.status} ${ultimo?.apiStatus || ''} ${truncate(ultimo?.msg || '', 150)}` };
  if (ultimo?.timeout) return { erro: '⌛ A IA demorou demais para responder. Tente de novo.' };
  return { erro: explain(ultimo?.status, ultimo?.apiStatus, ultimo?.msg) };
}

/**
 * ?ia testar    -> roda pelos modelos, do mais barato ao mais caro, e para no primeiro que responde.
 * ?ia comparar  -> testa TODOS os modelos de texto e fica com o que gasta menos token.
 * Cada teste usa uma pergunta mínima (poucos tokens).
 */
async function testarModelos({ todos = false } = {}) {
  testando = true;
  try {
    await garantirCatalogo(true);
    modeloStore.data.ruins = {}; // começa do zero: nada fica "em espera"
    modeloStore.data.preferido = null;
    const resultados = [];
    for (const model of catalogo) {
      const t0 = Date.now();
      const r = await chamar(model, PROBE_PROMPT, { maxOutputTokens: 64, timeout: 15_000 });
      const ms = Date.now() - t0;
      if (r.ok && textoDe(r.corpo)) {
        resultados.push({ model, ok: true, ms, tokens: tokensDe(r.corpo) });
        if (!todos) break;
        continue;
      }
      const motivo = r.ok ? 'não devolveu texto' : r.rede ? (r.timeout ? 'demorou demais' : 'sem conexão') : (classificar(r).motivo || `HTTP ${r.status}`);
      if (!r.ok && !r.rede) {
        const c = classificar(r);
        if (c.ate) marcarRuim(model, c.ate, c.motivo);
      } else if (r.ok) {
        marcarRuim(model, 10 * 60_000, 'não devolveu texto');
      }
      resultados.push({ model, ok: false, ms, motivo });
    }
    const bons = resultados.filter((x) => x.ok);
    // menor gasto de token; empate: o mais barato (primeiro da lista)
    const melhor = bons.length ? bons.reduce((a, b) => (b.tokens.total < a.tokens.total ? b : a)) : null;
    if (melhor) {
      workingModel = melhor.model;
      lastFailure = null;
      if (todos) modeloStore.data.preferido = melhor.model;
    }
    modeloStore.save();
    return { resultados, melhor, todos };
  } finally {
    testando = false;
  }
}

function formatarTeste({ resultados, melhor, todos }) {
  const linhas = resultados.map((r) => (r.ok
    ? `✅ \`${r.model}\` — ${r.tokens.total} tokens (pensou ${r.tokens.pensamento}) • ${r.ms} ms`
    : `❌ \`${r.model}\` — ${r.motivo}`));
  linhas.push('');
  if (!melhor) linhas.push('😕 Nenhum modelo respondeu. Confira a `GEMINI_API_KEY` e a cota no Google AI Studio.');
  else if (todos) linhas.push(`🏆 Fico com **${melhor.model}**: o que gastou menos token (${melhor.tokens.total} no teste). Se ele falhar, o bot passa sozinho para o próximo.`);
  else linhas.push(`✅ Em uso: **${melhor.model}**, o mais econômico que respondeu. Para comparar todos, use \`${PREFIX}ia comparar\`.`);
  return truncate(linhas.join('\n'), 1950);
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
  new SlashCommandBuilder().setName('ia').setDescription('Liga/desliga a IA, mostra o estado ou testa os modelos (staff)')
    .addBooleanOption(o => o.setName('status').setDescription('Ligada ou desligada (vazio = ver o estado atual)').setRequired(false))
    .addStringOption(o => o.setName('acao').setDescription('Testar os modelos de IA').setRequired(false).addChoices(
      { name: 'Testar até achar um que funcione (do mais barato ao mais caro)', value: 'testar' },
      { name: 'Comparar todos e ficar com o que gasta menos token', value: 'comparar' }
    ))
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

    const acao = interaction.options.getString('acao');
    if (acao) {
      if (!API_KEY) return interaction.reply(eph('🤖 A IA ainda não está configurada (falta a variável `GEMINI_API_KEY` no Render).'));
      if (testando) return interaction.reply(eph('⏳ Já estou testando os modelos. Espere terminar.'));
      await interaction.deferReply({ flags: 64 });
      const resultado = await testarModelos({ todos: acao === 'comparar' });
      return interaction.editReply({ content: formatarTeste(resultado) });
    }

    const novo = interaction.options.getBoolean('status');
    if (novo !== null) {
      ensureGuildConfig(interaction.guild.id).aiEnabled = novo;
      saveConfig();
    }
    const ligada = aiEnabled(interaction.guild.id);
    const linhas = [
      `${novo !== null ? '✅ Alterado! ' : ''}A IA está **${ligada ? 'LIGADA 🟢' : 'DESLIGADA 🔴'}** neste servidor.`,
      `🔑 Chave da API: ${API_KEY ? 'configurada' : '**não configurada** (falta `GEMINI_API_KEY`)'}`,
      `🧠 Modelo em uso: ${workingModel ? `\`${workingModel}\`` : '**automático** (escolhe o mais econômico que responder)'}${MODEL_FORCADO ? ` • forçado: \`${MODEL_FORCADO}\`` : ''}`,
      `📚 Modelos na fila: ${catalogo.length}${Object.values(modeloStore.data.ruins).filter((r) => r.ate > Date.now()).length ? ` • em espera: ${Object.values(modeloStore.data.ruins).filter((r) => r.ate > Date.now()).length}` : ''}${modeloStore.data.preferido ? ` • preferido: \`${modeloStore.data.preferido}\`` : ''}`,
      `🔢 Tokens hoje: ${uso.dia === today() ? `entrada ${uso.entrada} • saída ${uso.saida} • pensamento ${uso.pensamento} (${uso.respostas} respostas)` : 'nenhum ainda'}`,
      `📦 Respostas guardadas em cache: ${cache.size}`
    ];
    if (lastFailure) linhas.push(`⚠️ Último erro: ${truncate(lastFailure.texto, 200)}`);
    linhas.push('', `${ligada ? 'Desligue com `?ia off`.' : 'Ligue com `?ia on`.'} Testar modelos: \`${PREFIX}ia testar\` ou \`${PREFIX}ia comparar\`.`);
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

module.exports = { aiSlashCommands, handledCommands, handleAiInteraction, handleAiMention, aiEnabled, askGemini, answer, cacheGet, testarModelos, MODELOS_ORDEM, MODELOS_EXCLUIDOS };
