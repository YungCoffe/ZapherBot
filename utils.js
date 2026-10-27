'use strict';

const { MessageFlags } = require('discord.js');

const EPHEMERAL = MessageFlags.Ephemeral;

/** Prefixo dos comandos de texto (mude com a variável de ambiente PREFIX). */
const PREFIX = process.env.PREFIX || '?';

/** Nome e símbolo da moeda do servidor. */
const CURRENCY_NAME = 'ZapherCoin';

/** Valores especiais que só o prefixo gera: "tudo" e "metade" em comandos de dinheiro. */
const ALL_AMOUNT = -1;
const HALF_AMOUNT = -2;

/** Resposta efêmera simples. */
const eph = (content) => ({ content, flags: EPHEMERAL });

/** Corta textos para caber nos limites do Discord. */
const truncate = (text, max) => {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};

/** Minúsculas e sem acentos (para comparar palavras). */
const normalize = (text) => String(text ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

const fmtDate = (date = new Date()) => date.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
const fmtDateTime = (date = new Date()) => date.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
const unix = (ms) => Math.floor(ms / 1000);
const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

/**
 * Responde a uma interação sem nunca dar erro de "já respondida":
 * escolhe reply / editReply / followUp conforme o estado atual.
 */
async function respond(interaction, payload) {
  if (interaction.deferred && !interaction.replied) {
    const { flags, ...rest } = payload; // editReply não aceita flags
    return interaction.editReply(rest);
  }
  if (interaction.replied || interaction.deferred) return interaction.followUp(payload);
  return interaction.reply(payload);
}

const COLOR_NAMES = {
  vermelho: 0xE74C3C, azul: 0x3498DB, verde: 0x2ECC71, amarelo: 0xF1C40F, laranja: 0xE67E22, roxo: 0x9B59B6,
  rosa: 0xFF69B4, preto: 0x010101, branco: 0xFFFFFF, cinza: 0x95A5A6, ciano: 0x00BCD4, turquesa: 0x1ABC9C,
  dourado: 0xFFD700, prata: 0xC0C0C0, marrom: 0x8B4513, bordo: 0x800020, lilas: 0xC8A2C8, azulmarinho: 0x1F3A93,
  verdeescuro: 0x1E8449, azulclaro: 0x5DADE2, vinho: 0x722F37, magenta: 0xFF00FF, coral: 0xFF7F50
};

/** Converte "#FF8800", "f80" ou um nome de cor em português ("azul") para número. null se inválida. */
function parseColor(text) {
  const raw = normalize(text).replace(/[\s_-]/g, '');
  if (COLOR_NAMES[raw] !== undefined) return COLOR_NAMES[raw];
  const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/.exec(raw);
  if (!m) return null;
  let hex = m[1];
  if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
  const n = parseInt(hex, 16);
  return n === 0 ? 0x010101 : n; // 0 = "sem cor" no Discord
}

/** Posiciona um cargo logo abaixo de outro (sem passar do cargo mais alto do bot). */
async function placeRoleBelow(guild, role, anchor) {
  try {
    const maxPos = (guild.members.me?.roles.highest.position ?? 1) - 1;
    const alvo = Math.min(anchor.position, maxPos);
    if (alvo > 0) await role.setPosition(alvo);
  } catch (err) {
    console.error('[cargos] não consegui posicionar o cargo:', err.message);
  }
}

/** Transforma erros da API do Discord em mensagens que o usuário entende. null = não adianta responder. */
function describeError(err) {
  switch (err?.code) {
    case 50013: return '❌ Eu não tenho permissão para fazer isso. Confira se o meu cargo está acima dos envolvidos e se tenho as permissões necessárias.';
    case 50001: return '❌ Eu não consigo acessar este canal. Dê ao meu cargo a permissão **Ver Canal** e **Enviar Mensagens**.';
    case 10062: case 40060: return null; // interação expirada ou já respondida
    case 50007: return '❌ Não consegui enviar mensagem privada para essa pessoa.';
    default: return '❌ Ocorreu um erro inesperado ao executar isso.';
  }
}

module.exports = { describeError, EPHEMERAL, PREFIX, CURRENCY_NAME, ALL_AMOUNT, HALF_AMOUNT, parseColor, placeRoleBelow, eph, truncate, normalize, fmtDate, fmtDateTime, unix, randInt, respond };
