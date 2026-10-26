'use strict';

const { MessageFlags } = require('discord.js');

const EPHEMERAL = MessageFlags.Ephemeral;

/** Prefixo dos comandos de texto (mude com a variável de ambiente PREFIX). */
const PREFIX = process.env.PREFIX || '?';

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

module.exports = { EPHEMERAL, PREFIX, ALL_AMOUNT, HALF_AMOUNT, eph, truncate, normalize, fmtDate, fmtDateTime, unix, randInt, respond };
