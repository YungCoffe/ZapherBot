'use strict';

/**
 * /criaremoji     nome + imagem (ou cole um emoji personalizado de outro servidor)
 * /criarfigurinha nome + imagem (+ tags opcionais)
 *
 * Também funcionam com prefixo: anexe a imagem na mesma mensagem.
 *   ?criaremoji festa            (com uma imagem anexada)
 *   ?criaremoji festa <:outro:123456789012345678>
 *   ?criarfigurinha meme         (com uma imagem anexada)
 */

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { eph, truncate, respond, describeError } = require('./utils');
const { checkAccess } = require('./perms');

// Nome da permissão mudou entre versões do discord.js
const MANAGE_EXPRESSIONS = PermissionFlagsBits.ManageGuildExpressions ?? PermissionFlagsBits.ManageEmojisAndStickers;
const EMOJI_MAX_BYTES = 256 * 1024;
const STICKER_MAX_BYTES = 512 * 1024;
const CUSTOM_EMOJI_REGEX = /<(a?):(\w{2,32}):(\d{15,22})>/;

const expressionsSlashCommands = [
  new SlashCommandBuilder().setName('criaremoji').setDescription('Cria um emoji no servidor a partir de uma imagem ou de outro emoji')
    .addStringOption(o => o.setName('nome').setDescription('Nome do emoji (letras, números e _)').setRequired(true).setMinLength(2).setMaxLength(32))
    .addAttachmentOption(o => o.setName('imagem').setDescription('Imagem PNG/JPG/GIF de até 256 KB').setRequired(false))
    .addStringOption(o => o.setName('emoji').setDescription('Ou cole um emoji personalizado de outro servidor').setRequired(false)),
  new SlashCommandBuilder().setName('criarfigurinha').setDescription('Cria uma figurinha (sticker) no servidor a partir de uma imagem')
    .addStringOption(o => o.setName('nome').setDescription('Nome da figurinha').setRequired(true).setMinLength(2).setMaxLength(30))
    .addAttachmentOption(o => o.setName('imagem').setDescription('Imagem PNG/GIF de até 512 KB (ideal: 320x320)').setRequired(true))
    .addStringOption(o => o.setName('tags').setDescription('Palavras-chave / emoji relacionado (opcional)').setRequired(false).setMaxLength(100))
];

const sanitizeEmojiName = (text) => String(text ?? '').trim().replace(/\s+/g, '_').replace(/[^A-Za-z0-9_]/g, '');

/** Verifica permissões; devolve uma mensagem de erro ou null. */
function checkPermissions(interaction) {
  const { guild } = interaction;
  if (!guild) return '❌ Este comando só funciona dentro de um servidor.';
  const negado = checkAccess(interaction, { strict: true });
  if (negado) return negado;
  if (!guild.members.me?.permissions.has(MANAGE_EXPRESSIONS)) return '❌ Eu preciso da permissão **Gerenciar Expressões** (emojis e figurinhas) para fazer isso.';
  return null;
}

function friendlyError(err, tipo) {
  const code = err?.code;
  if (code === 30008) return '❌ O servidor atingiu o limite de emojis (estáticos ou animados). Apague algum ou impulsione o servidor.';
  if (code === 30039) return '❌ O servidor atingiu o limite de figurinhas. Apague alguma ou impulsione o servidor.';
  if (code === 50035) return `❌ O Discord recusou a imagem. Confira o formato e o tamanho (${tipo === 'emoji' ? 'máx. 256 KB' : 'máx. 512 KB, PNG/GIF'}).`;
  if (code === 50013) return '❌ Não tenho permissão para fazer isso.';
  console.error(`[${tipo}]`, err);
  return `❌ Não consegui criar o ${tipo}. Tente com outra imagem.`;
}

const COMMANDS = {
  async criaremoji(interaction) {
    const erroPerm = checkPermissions(interaction);
    if (erroPerm) return interaction.reply(eph(erroPerm));

    const { guild, user, options } = interaction;
    const nome = sanitizeEmojiName(options.getString('nome'));
    if (nome.length < 2) return interaction.reply(eph('❌ O nome precisa ter pelo menos 2 letras, números ou `_`.'));

    const anexo = options.getAttachment?.('imagem') ?? null;
    const colado = options.getString('emoji');
    let url;

    if (anexo) {
      if (anexo.contentType && !anexo.contentType.startsWith('image/')) return interaction.reply(eph('❌ O arquivo precisa ser uma imagem.'));
      if (anexo.size && anexo.size > EMOJI_MAX_BYTES) return interaction.reply(eph(`❌ A imagem tem ${Math.ceil(anexo.size / 1024)} KB. O limite para emojis é **256 KB**.`));
      url = anexo.url;
    } else if (colado) {
      const m = CUSTOM_EMOJI_REGEX.exec(colado);
      if (!m) return interaction.reply(eph('❌ Não reconheci esse emoji. Cole um emoji personalizado (ex.: `<:nome:123456789012345678>`) ou anexe uma imagem.'));
      url = `https://cdn.discordapp.com/emojis/${m[3]}.${m[1] ? 'gif' : 'png'}?size=128&quality=lossless`;
    } else {
      return interaction.reply(eph('❌ Anexe uma imagem ou cole um emoji personalizado de outro servidor.'));
    }

    await interaction.deferReply();
    try {
      const emoji = await guild.emojis.create({ attachment: url, name: nome, reason: `Criado por ${user.tag}` });
      return interaction.editReply({ content: `✅ Emoji criado: ${emoji} — use \`:${emoji.name}:\``, allowedMentions: { parse: [] } });
    } catch (err) {
      return interaction.editReply({ content: friendlyError(err, 'emoji') });
    }
  },

  async criarfigurinha(interaction) {
    const erroPerm = checkPermissions(interaction);
    if (erroPerm) return interaction.reply(eph(erroPerm));

    const { guild, user, options } = interaction;
    const nome = String(options.getString('nome') ?? '').trim().slice(0, 30);
    if (nome.length < 2) return interaction.reply(eph('❌ O nome da figurinha precisa ter pelo menos 2 caracteres.'));

    const anexo = options.getAttachment?.('imagem') ?? null;
    if (!anexo) return interaction.reply(eph('❌ Anexe a imagem da figurinha.'));
    if (anexo.contentType && !anexo.contentType.startsWith('image/')) return interaction.reply(eph('❌ O arquivo precisa ser uma imagem (PNG ou GIF).'));
    if (anexo.size && anexo.size > STICKER_MAX_BYTES) return interaction.reply(eph(`❌ A imagem tem ${Math.ceil(anexo.size / 1024)} KB. O limite para figurinhas é **512 KB**.`));

    const tags = truncate((options.getString('tags') || nome).trim(), 200) || nome;
    await interaction.deferReply();
    try {
      const sticker = await guild.stickers.create({
        file: anexo.url,
        name: nome,
        tags,
        description: truncate(`Criada por ${user.username}`, 100),
        reason: `Criada por ${user.tag}`
      });
      return interaction.editReply({ content: `✅ Figurinha **${sticker.name}** criada! Procure por ela no seletor de figurinhas.` });
    } catch (err) {
      return interaction.editReply({ content: friendlyError(err, 'figurinha') });
    }
  }
};

const handledCommands = Object.keys(COMMANDS);

async function handleExpressionsInteraction(interaction) {
  try {
    if (!interaction.isChatInputCommand()) return;
    if (!Object.hasOwn(COMMANDS, interaction.commandName)) return;
    await COMMANDS[interaction.commandName](interaction);
  } catch (err) {
    console.error('[interação/emojis]', err);
    try { const aviso = describeError(err); if (aviso) await respond(interaction, eph(aviso)); } catch (_) { /* ignora */ }
  }
}

module.exports = { expressionsSlashCommands, handledCommands, handleExpressionsInteraction };
