'use strict';

/**
 * Comandos híbridos: cada slash command também funciona com prefixo (ex.: /saldo e ?saldo).
 * Em vez de duplicar a lógica, lemos as opções definidas no SlashCommandBuilder, interpretamos
 * o texto da mensagem e entregamos ao MESMO handler um objeto que imita uma interação.
 */

const { EPHEMERAL, PREFIX, ALL_AMOUNT, HALF_AMOUNT, normalize } = require('./utils');

const T = { STRING: 3, INTEGER: 4, BOOLEAN: 5, USER: 6, CHANNEL: 7, ROLE: 8, NUMBER: 10 };
const PREFIX_COOLDOWN_MS = 2000;

// Atalhos curtos (opcional) -> nome real do comando
const ALIASES = {
  ajuda: 'help', comandos: 'help',
  bal: 'saldo', money: 'saldo', grana: 'saldo',
  dep: 'depositar', with: 'sacar', pix: 'transferir',
  work: 'trabalhar', w: 'trabalhar',
  inv: 'inventario', top: 'rank', rich: 'rank',
  cf: 'coinflip', bj: 'blackjack', slot: 'slots',
  lvl: 'nivel', xp: 'nivel', av: 'avatar',
  pergunta: 'perguntar', ask: 'perguntar',
  dados: 'dado', cd: 'cooldowns', biz: 'negocios', collect: 'coletar'
};

const MULT = { k: 1e3, m: 1e6, mi: 1e6, b: 1e9 };
const TRUE_WORDS = new Set(['sim', 's', 'true', 'on', 'ligar', 'ligado', 'ativar', 'ativado', 'yes', 'y', '1']);
const FALSE_WORDS = new Set(['nao', 'n', 'false', 'off', 'desligar', 'desligado', 'desativar', 'desativado', 'no', '0']);
const ID_PATTERNS = {
  user: /^<@!?(\d{15,22})>$|^(\d{15,22})$/,
  channel: /^<#(\d{15,22})>$|^(\d{15,22})$/,
  role: /^<@&(\d{15,22})>$|^(\d{15,22})$/
};

/* ============================================================
 *  LEITURA DO TEXTO
 * ============================================================ */
/** Divide em palavras respeitando "aspas" (para textos com espaços no meio dos argumentos). */
function tokenize(text) {
  const tokens = [];
  const re = /"([^"]*)"|“([^”]*)”|(\S+)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    tokens.push({ value: m[1] ?? m[2] ?? m[3], start: m.index, end: m.index + m[0].length });
  }
  return tokens;
}

function stripQuotes(text) {
  const m = /^"([^"]*)"$|^“([^”]*)”$/.exec(text);
  return m ? (m[1] ?? m[2]) : text;
}

/** Aceita 5000, 5k, 1.5m, 2b e 1.500 (separador de milhar). */
function parseAmount(raw) {
  const s = String(raw).toLowerCase().replace(/^r\$/, '');
  let m = /^(\d+(?:[.,]\d+)?)(k|mi|m|b)$/.exec(s);
  if (m) return Math.round(parseFloat(m[1].replace(',', '.')) * MULT[m[2]]);
  if (/^\d{1,3}(\.\d{3})+$/.test(s)) return parseInt(s.replace(/\./g, ''), 10);
  m = /^\d+$/.exec(s);
  return m ? parseInt(s, 10) : undefined;
}

const extractId = (raw, kind) => {
  const m = ID_PATTERNS[kind].exec(raw);
  return m ? (m[1] || m[2]) : null;
};

/** Interpreta UMA opção a partir da posição i. Devolve { entry, next } | { skip } | { error }. */
async function parseOne(message, options, k, tokens, i, text) {
  const opt = options[k];
  const tok = tokens[i];
  const raw = tok.value;
  const guild = message.guild;

  switch (opt.type) {
    case T.USER: {
      const id = extractId(raw, 'user');
      if (!id) return { skip: true };
      const user = await message.client.users.fetch(id).catch(() => null);
      if (!user) return { skip: true };
      const member = guild ? await guild.members.fetch(id).catch(() => null) : null;
      return { entry: { user, member }, next: i + 1 };
    }

    case T.CHANNEL: {
      let channel = ['aqui', 'here', 'este', 'atual'].includes(normalize(raw)) ? message.channel : null;
      if (!channel) {
        const id = extractId(raw, 'channel');
        if (id) channel = guild.channels.cache.get(id) ?? await guild.channels.fetch(id).catch(() => null);
      }
      if (!channel) return { skip: true };
      if (opt.channel_types?.length && !opt.channel_types.includes(channel.type)) return { error: { kind: 'channeltype', opt } };
      return { entry: { channel }, next: i + 1 };
    }

    case T.ROLE: {
      const id = extractId(raw, 'role');
      const role = id
        ? (guild.roles.cache.get(id) ?? await guild.roles.fetch(id).catch(() => null))
        : guild.roles.cache.find((r) => normalize(r.name) === normalize(raw));
      if (!role) return { skip: true };
      return { entry: { role }, next: i + 1 };
    }

    case T.INTEGER:
    case T.NUMBER: {
      let v;
      if (opt.name === 'valor') {
        const w = normalize(raw);
        if (['tudo', 'all', 'total'].includes(w)) v = ALL_AMOUNT;
        else if (['metade', 'half', '50%'].includes(w)) v = HALF_AMOUNT;
      }
      if (v === undefined) v = parseAmount(raw);
      if (v === undefined || !Number.isSafeInteger(v)) return { skip: true };
      if (v !== ALL_AMOUNT && v !== HALF_AMOUNT) {
        if ((opt.min_value !== undefined && v < opt.min_value) || (opt.max_value !== undefined && v > opt.max_value)) {
          return { error: { kind: 'range', opt } };
        }
      }
      return { entry: { value: v }, next: i + 1 };
    }

    case T.BOOLEAN: {
      const w = normalize(raw);
      if (TRUE_WORDS.has(w)) return { entry: { value: true }, next: i + 1 };
      if (FALSE_WORDS.has(w)) return { entry: { value: false }, next: i + 1 };
      return { skip: true };
    }

    case T.STRING: {
      if (opt.choices?.length) {
        const n = normalize(raw);
        const choice = opt.choices.find((c) => normalize(String(c.value)) === n)
          || opt.choices.find((c) => normalize(c.name) === n)
          || (n.length >= 3 ? opt.choices.find((c) => normalize(c.name).startsWith(n)) : null);
        if (!choice) return { skip: true };
        return { entry: { value: choice.value }, next: i + 1 };
      }

      const rest = options.slice(k + 1);
      let value;
      let next;
      if (rest.length === 0) {
        // Último texto: leva o resto da linha inteira
        value = stripQuotes(text.slice(tok.start).trim());
        next = tokens.length;
      } else {
        // Texto seguido só de números/booleanos obrigatórios (ex.: sorteio <premio> <minutos>):
        // o texto leva tudo menos as últimas palavras reservadas aos números.
        const reservados = rest.filter((o) => o.required).length;
        const soNaoTexto = rest.every((o) => o.type !== T.STRING);
        if (soNaoTexto && reservados > 0 && tokens.length - i > reservados) {
          const ultimo = tokens.length - reservados - 1;
          value = stripQuotes(text.slice(tok.start, tokens[ultimo].end).trim());
          next = ultimo + 1;
        } else {
          value = raw;
          next = i + 1;
        }
      }
      if (opt.max_length && value.length > opt.max_length) return { error: { kind: 'maxlength', opt } };
      if (opt.min_length && value.length < opt.min_length) return { error: { kind: 'minlength', opt } };
      return { entry: { value }, next };
    }

    default:
      return { skip: true };
  }
}

/** Converte o texto digitado nas opções do comando. */
async function parseOptions(message, def, text) {
  const options = def.options || [];
  const tokens = tokenize(text);
  const values = new Map();
  let i = 0;

  for (let k = 0; k < options.length; k++) {
    const opt = options[k];
    if (!tokens[i]) {
      if (opt.required) return { error: { kind: 'missing', opt } };
      continue;
    }
    const res = await parseOne(message, options, k, tokens, i, text);
    if (res.error) return { error: res.error };
    if (res.skip) {
      if (opt.required) return { error: { kind: 'invalid', opt, token: tokens[i].value } };
      continue; // opção opcional que não casou: não consome a palavra
    }
    values.set(opt.name, res.entry);
    i = res.next;
  }
  return { values };
}

/* ============================================================
 *  MENSAGENS DE USO / ERRO
 * ============================================================ */
function usage(def) {
  const parts = (def.options || []).map((o) => {
    const label = o.choices?.length ? o.choices.map((c) => c.value).join('|') : o.name;
    return o.required ? `<${label}>` : `[${label}]`;
  });
  return `${PREFIX}${def.name} ${parts.join(' ')}`.trim();
}

const TYPE_LABELS = {
  [T.USER]: 'um usuário (@menção ou ID)',
  [T.CHANNEL]: 'um canal (#canal ou "aqui")',
  [T.ROLE]: 'um cargo (@cargo, ID ou nome)',
  [T.INTEGER]: 'um número (aceita 5k, 1m; em dinheiro também "tudo" e "metade")',
  [T.NUMBER]: 'um número',
  [T.BOOLEAN]: 'sim ou não',
  [T.STRING]: 'um texto'
};

function errorMessage(def, error) {
  const { opt } = error;
  const uso = `Uso: \`${usage(def)}\``;
  const dica = (def.options || []).filter((o) => o.type === T.STRING && !o.choices?.length).length > 1
    ? '\n💡 Use aspas para textos com espaços: `"assim"`.' : '';
  switch (error.kind) {
    case 'missing': return `❌ Falta o argumento **${opt.name}**.\n${uso}${dica}`;
    case 'invalid': return `❌ Valor inválido para **${opt.name}** (esperado: ${TYPE_LABELS[opt.type] || 'valor'}).\n${uso}${dica}`;
    case 'range': return `❌ **${opt.name}** deve estar entre ${opt.min_value ?? '-∞'} e ${opt.max_value ?? '∞'}.\n${uso}`;
    case 'maxlength': return `❌ **${opt.name}** pode ter no máximo ${opt.max_length} caracteres.`;
    case 'minlength': return `❌ **${opt.name}** precisa de pelo menos ${opt.min_length} caracteres.`;
    case 'channeltype': return `❌ Esse tipo de canal não serve para **${opt.name}** (use um canal de texto).`;
    default: return `❌ Argumentos inválidos.\n${uso}`;
  }
}

/* ============================================================
 *  ADAPTADOR: faz uma mensagem parecer uma interação de slash command
 * ============================================================ */
class PrefixOptions {
  constructor(values) { this.values = values; }
  getString(name) { return this.values.get(name)?.value ?? null; }
  getInteger(name) { return this.values.get(name)?.value ?? null; }
  getNumber(name) { return this.values.get(name)?.value ?? null; }
  getBoolean(name) { return this.values.get(name)?.value ?? null; }
  getUser(name) { return this.values.get(name)?.user ?? null; }
  getMember(name) { return this.values.get(name)?.member ?? null; }
  getChannel(name) { return this.values.get(name)?.channel ?? null; }
  getRole(name) { return this.values.get(name)?.role ?? null; }
}

const isEphemeral = (p) => !!p && (p.ephemeral === true || (typeof p.flags === 'number' && (p.flags & EPHEMERAL) !== 0));

class PrefixInteraction {
  constructor(message, def, values) {
    this.message = message;
    this.isPrefix = true;
    this.commandName = def.name;
    this.client = message.client;
    this.user = message.author;
    this.member = message.member;
    this.memberPermissions = message.member?.permissions ?? null;
    this.guild = message.guild;
    this.guildId = message.guildId;
    this.channel = message.channel;
    this.channelId = message.channelId;
    this.createdTimestamp = message.createdTimestamp;
    this.options = new PrefixOptions(values);
    this.deferred = false;
    this.replied = false;
    this._sent = null;
    this._deferEphemeral = false;
  }

  isChatInputCommand() { return true; }
  isButton() { return false; }
  isModalSubmit() { return false; }
  isAutocomplete() { return false; }

  async _send(payload, forceEphemeral = false) {
    const { flags, ephemeral, ...rest } = typeof payload === 'string' ? { content: payload } : payload;
    const efemera = forceEphemeral || isEphemeral({ flags, ephemeral });
    rest.allowedMentions = { parse: [], repliedUser: false, ...(rest.allowedMentions || {}) };
    rest.reply = { messageReference: this.message.id, failIfNotExists: false };

    const sent = await this.channel.send(rest);
    if (!this._sent) this._sent = sent;
    if (efemera) {
      // Não existe "mensagem só para você" no prefixo: apaga sozinha depois de um tempo
      const ms = rest.components?.length ? 180000 : rest.embeds?.length ? 60000 : 15000;
      setTimeout(() => sent.delete().catch(() => {}), ms);
    }
    return sent;
  }

  async deferReply(opts = {}) {
    this.deferred = true;
    this._deferEphemeral = isEphemeral(opts);
    this.channel.sendTyping?.().catch(() => {});
  }

  async reply(payload) {
    this.replied = true;
    return this._send(payload);
  }

  async editReply(payload) {
    this.replied = true;
    const p = typeof payload === 'string' ? { content: payload } : { ...payload };
    if (!this._sent) return this._send(p, this._deferEphemeral);
    const { flags, ephemeral, ...rest } = p;
    return this._sent.edit(rest);
  }

  async followUp(payload) {
    return this._send(payload);
  }

  async fetchReply() {
    return this._sent;
  }
}

/* ============================================================
 *  ENTRADA PRINCIPAL
 * ============================================================ */
/**
 * @param builders  lista de SlashCommandBuilder (usada para saber as opções de cada comando)
 * @param dispatch  função async (interaction) que executa o comando
 * @returns handlePrefix(message) -> true se a mensagem era um comando
 */
function createPrefixHandler({ builders, dispatch }) {
  const defs = new Map();
  for (const b of builders) {
    try {
      const json = b.toJSON();
      defs.set(json.name, json);
    } catch (err) {
      console.error(`[hybrid] comando inválido "${b.name}":`, err.message);
    }
  }
  const lastUse = new Map();

  return async function handlePrefix(message) {
    if (message.author.bot || !message.guild) return false;
    if (!message.content.startsWith(PREFIX)) return false;

    const match = /^(\S+)\s*([\s\S]*)$/.exec(message.content.slice(PREFIX.length));
    if (!match) return false;
    const name = match[1].toLowerCase();
    const def = defs.get(name) || defs.get(ALIASES[name]); // nomes reais têm prioridade sobre atalhos
    if (!def) return false; // não é um comando nosso: ignora (ex.: "?? oi")

    const agora = Date.now();
    const anterior = lastUse.get(message.author.id) || 0;
    if (agora - anterior < PREFIX_COOLDOWN_MS) {
      const aviso = await message.reply({ content: '⏳ Calma! Um comando de cada vez.', allowedMentions: { repliedUser: false } }).catch(() => null);
      if (aviso) setTimeout(() => aviso.delete().catch(() => {}), 3000);
      return true;
    }
    lastUse.set(message.author.id, agora);
    if (lastUse.size > 500) {
      for (const [id, t] of lastUse) if (agora - t > 10000) lastUse.delete(id);
    }

    if (!message.member) message.member = await message.guild.members.fetch(message.author.id).catch(() => null);

    const parsed = await parseOptions(message, def, match[2] || '');
    if (parsed.error) {
      const aviso = await message.reply({ content: errorMessage(def, parsed.error), allowedMentions: { repliedUser: false } }).catch(() => null);
      if (aviso) setTimeout(() => aviso.delete().catch(() => {}), 20000);
      return true;
    }

    await dispatch(new PrefixInteraction(message, def, parsed.values));
    return true;
  };
}

module.exports = { createPrefixHandler, parseOptions, parseAmount, tokenize, usage, ALIASES };
