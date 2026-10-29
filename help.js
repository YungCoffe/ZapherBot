'use strict';

/**
 * Ajuda automática: lê TODOS os comandos registrados, então nunca fica faltando nenhum.
 * Comandos novos que não estejam em nenhuma categoria aparecem sozinhos em "Outros".
 *
 *   /help                 → painel com categorias (botões + menu)
 *   /help comando:ban     → detalhes de um comando (uso, opções, atalhos)
 */

const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, SlashCommandBuilder
} = require('discord.js');
const { EPHEMERAL, PREFIX, CURRENCY_NAME, eph, truncate, normalize, respond, describeError } = require('./utils');
const { ALIASES } = require('./hybrid');
const { lockLabel } = require('./perms');

const CATEGORIES = [
  { emoji: '🛡️', nome: 'Moderação', cmds: ['ban', 'unban', 'kick', 'mute', 'unmute', 'warn', 'warnings', 'clearwarns', 'clear', 'calado', 'lock', 'unlock', 'slowmode', 'setcargo', 'nick', 'permnick', 'unpermnick', 'censura', 'automod'] },
  { emoji: '⚙️', nome: 'Configuração', cmds: ['setwelcome', 'setlogs', 'setdenuncias', 'setduvidas', 'setpunicoes', 'setmsgdelete', 'setsuggestion', 'setnivel', 'logs', 'setverify', 'setautorole', 'delautorole', 'setadminrole', 'setadminuser', 'deladminrole', 'deladminuser', 'ia', 'backup'] },
  { emoji: '💳', nome: 'Economia — Conta', cmds: ['saldo', 'patrimonio', 'depositar', 'sacar', 'transferir', 'perfil', 'rank', 'extrato', 'inventario', 'emprestimo', 'pagar', 'vender', 'cooldowns', 'addmoney', 'removemoney'] },
  { emoji: '💼', nome: 'Economia — Ganhos', cmds: ['daily', 'weekly', 'trabalhar', 'profissao', 'minerar', 'pescar', 'cacar', 'farmar', 'negocios', 'coletar', 'empresa', 'investir', 'loteria', 'caixa'] },
  { emoji: '🎮', nome: 'Jogos & Loja', cmds: ['mercado', 'loja', 'painel-economia', 'apostar', 'slots', 'coinflip', 'roleta', 'blackjack', 'roubar', 'crime'] },
  { emoji: '⭐', nome: 'Níveis & Cargos', cmds: ['nivel', 'ranknivel', 'cargosnivel', 'painel-cargos'] },
  { emoji: '🎨', nome: 'Emojis & Figurinhas', cmds: ['criaremoji', 'criarfigurinha'] },
  { emoji: '🤖', nome: 'IA & Diversão', cmds: ['perguntar', '8ball', 'dado', 'escolher', 'enquete', 'lembrete', 'sorteio'] },
  { emoji: '🧰', nome: 'Utilidades & Suporte', cmds: ['help', 'novidades', 'ping', 'botinfo', 'avatar', 'userinfo', 'serverinfo', 'say', 'embed', 'ticket', 'painel-sugestao', 'sugerir', 'denuncia'] }
];

const helpSlashCommands = [
  new SlashCommandBuilder().setName('help').setDescription('Mostra todos os comandos (ou os detalhes de um comando)')
    .addStringOption(o => o.setName('comando').setDescription('Nome de um comando para ver os detalhes').setRequired(false).setAutocomplete(true))
];

/* ============================================================
 *  MONTAGEM (feita uma vez, com os comandos reais)
 * ============================================================ */
let defs = new Map();
let prefixOnly = new Set(); // comandos que existem só com prefixo (não são slash)
let pages = []; // [{ emoji, nome, lines: [...] }]

function setHelpSources(builders, prefixOnlyNames = []) {
  prefixOnly = new Set(prefixOnlyNames);
  defs = new Map();
  for (const b of builders) {
    try { const j = b.toJSON(); defs.set(j.name, j); } catch (_) { /* inválido: o hybrid já avisa */ }
  }

  const usados = new Set();
  pages = [];
  for (const cat of CATEGORIES) {
    const nomes = cat.cmds.filter((n) => defs.has(n));
    nomes.forEach((n) => usados.add(n));
    if (nomes.length) pages.push({ emoji: cat.emoji, nome: cat.nome, nomes });
  }
  const sobrando = [...defs.keys()].filter((n) => !usados.has(n));
  if (sobrando.length) pages.push({ emoji: '📦', nome: 'Outros', nomes: sobrando });
}

const line = (name) => {
  const lock = lockLabel(name);
  return `• \`${prefixOnly.has(name) ? PREFIX : '/'}${name}\` — ${defs.get(name).description}${lock ? ` *(${lock})*` : ''}`;
};

/** Quebra uma lista de linhas em campos de até ~1000 caracteres (limite do Discord: 1024). */
function chunkLines(lines) {
  const chunks = [];
  let atual = '';
  for (const l of lines) {
    if (atual && atual.length + l.length + 1 > 1000) { chunks.push(atual); atual = ''; }
    atual += (atual ? '\n' : '') + l;
  }
  if (atual) chunks.push(atual);
  return chunks;
}

const totalPages = () => pages.length + 1; // +1 = visão geral

function buildPage(index) {
  const embed = new EmbedBuilder().setColor(0x00AE86);
  const total = totalPages();

  if (index <= 0) {
    embed.setTitle(`📖 Central de Ajuda (1/${total})`)
      .setDescription([
        `Olá! Existem **${defs.size} comandos**. Escolha uma categoria no menu abaixo ou use os botões.`,
        '',
        pages.map((p) => `${p.emoji} **${p.nome}** — ${p.nomes.length}`).join('\n'),
        '',
        `💡 **Todos os comandos funcionam com \`/\` ou com o prefixo \`${PREFIX}\`** (ex.: \`${PREFIX}saldo\`, \`${PREFIX}apostar tudo\`).`,
        `💰 A moeda do servidor é a **${CURRENCY_NAME}** (🪙). Em comandos de dinheiro com prefixo você pode usar \`5k\`, \`1.5m\`, \`tudo\` e \`metade\`.`,
        '🤖 Marque o bot ou use `/perguntar` para conversar com a IA.',
        '🔎 Detalhes de um comando: `/help comando:ban`'
      ].join('\n'))
      .setFooter({ text: `Página 1 de ${total} • Zapher Bot` });
    return embed;
  }

  const page = pages[Math.min(index, pages.length) - 1];
  embed.setTitle(`${page.emoji} ${page.nome} (${Math.min(index, pages.length) + 1}/${total})`)
    .setFooter({ text: `Página ${Math.min(index, pages.length) + 1} de ${total} • /help comando:<nome> para detalhes` });
  chunkLines(page.nomes.map(line)).forEach((chunk, i) => embed.addFields({ name: i === 0 ? `Comandos (${page.nomes.length})` : '\u200b', value: chunk }));
  return embed;
}

function buildComponents(index) {
  const total = totalPages();
  const atual = Math.max(0, Math.min(index, total - 1));

  const menu = new StringSelectMenuBuilder().setCustomId('help_select').setPlaceholder('📂 Escolha uma categoria')
    .addOptions([
      { label: 'Visão geral', value: '0', emoji: '📖', default: atual === 0 },
      ...pages.map((p, i) => ({ label: truncate(p.nome, 100), value: String(i + 1), emoji: p.emoji, description: `${p.nomes.length} comandos`, default: atual === i + 1 }))
    ]);
  const botoes = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`help_page_${Math.max(0, atual - 1)}`).setLabel('Anterior').setEmoji('◀️').setStyle(ButtonStyle.Primary).setDisabled(atual === 0),
    new ButtonBuilder().setCustomId(`help_page_${Math.min(total - 1, atual + 1)}`).setLabel('Próxima').setEmoji('▶️').setStyle(ButtonStyle.Primary).setDisabled(atual >= total - 1)
  );
  return [new ActionRowBuilder().addComponents(menu), botoes];
}

/* ============================================================
 *  DETALHE DE UM COMANDO
 * ============================================================ */
const TYPE_NAMES = { 3: 'texto', 4: 'número', 5: 'sim/não', 6: 'usuário', 7: 'canal', 8: 'cargo', 10: 'número', 11: 'imagem' };

function buildDetail(def) {
  const opts = def.options || [];
  const uso = (prefixo) => `${prefixo}${def.name} ${opts.map((o) => {
    const label = o.choices?.length ? o.choices.map((c) => c.value).join('|') : o.name;
    return o.required ? `<${label}>` : `[${label}]`;
  }).join(' ')}`.trim();

  const embed = new EmbedBuilder().setColor(0x3498DB).setTitle(`🔎 /${def.name}`).setDescription(def.description)
    .addFields({ name: 'Uso', value: prefixOnly.has(def.name) ? `\`${uso(PREFIX)}\` *(só com prefixo)*` : `\`${uso('/')}\`\n\`${uso(PREFIX)}\`` });
  if (opts.length) {
    embed.addFields({
      name: 'Opções',
      value: truncate(opts.map((o) => `• **${o.name}** (${TYPE_NAMES[o.type] || 'valor'}${o.required ? ', obrigatório' : ', opcional'}) — ${o.description}`).join('\n'), 1024)
    });
  }
  const atalhos = Object.entries(ALIASES).filter(([, alvo]) => alvo === def.name).map(([a]) => `\`${PREFIX}${a}\``);
  if (atalhos.length) embed.addFields({ name: 'Atalhos', value: atalhos.join(', ') });
  return embed;
}

/* ============================================================
 *  ENTRADA
 * ============================================================ */
const handledCommands = ['help'];

async function handleHelpInteraction(interaction) {
  try {
    if (interaction.isAutocomplete()) {
      if (interaction.commandName !== 'help') return;
      const foco = normalize(interaction.options.getFocused());
      const nomes = [...defs.keys()].filter((n) => normalize(n).includes(foco)).slice(0, 25);
      return await interaction.respond(nomes.map((n) => ({ name: n, value: n })));
    }

    if (interaction.isButton() && interaction.customId.startsWith('help_page_')) {
      const index = parseInt(interaction.customId.slice('help_page_'.length), 10) || 0;
      return await interaction.update({ embeds: [buildPage(index)], components: buildComponents(index) });
    }

    if (interaction.isStringSelectMenu?.() && interaction.customId === 'help_select') {
      const index = parseInt(interaction.values[0], 10) || 0;
      return await interaction.update({ embeds: [buildPage(index)], components: buildComponents(index) });
    }

    if (interaction.isChatInputCommand() && interaction.commandName === 'help') {
      const pedido = interaction.options.getString('comando');
      if (pedido) {
        const nome = normalize(pedido).replace(/^[/?!.]/, '');
        const def = defs.get(nome) || defs.get(ALIASES[nome]);
        if (!def) return await interaction.reply(eph(`❌ Não encontrei o comando \`${truncate(pedido, 50)}\`. Use \`/help\` para ver a lista.`));
        return await interaction.reply({ embeds: [buildDetail(def)], flags: EPHEMERAL });
      }
      return await interaction.reply({ embeds: [buildPage(0)], components: buildComponents(0), flags: EPHEMERAL });
    }
  } catch (err) {
    console.error('[interação/help]', err);
    try { const aviso = describeError(err); if (aviso) await respond(interaction, eph(aviso)); } catch (_) { /* ignora */ }
  }
}

/** Lista (para testes/diagnóstico) de comandos que aparecem na ajuda. */
const listedCommands = () => pages.flatMap((p) => p.nomes);

module.exports = { helpSlashCommands, handledCommands, handleHelpInteraction, setHelpSources, buildPage, listedCommands, totalPages };
