'use strict';

const { EmbedBuilder, SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, version: djsVersion } = require('discord.js');
const { inviteUrl } = require('./perms');
const { JsonStore } = require('./storage');
const { eph, truncate, unix, randInt, respond, describeError } = require('./utils');

/* ============================================================
 *  AJUSTES
 * ============================================================ */
const MAX_REMINDERS = 10;
const NUM_EMOJIS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣'];

const BALL_ANSWERS = [
  '✅ Com certeza!', '✅ Sem dúvida nenhuma.', '✅ Pode apostar nisso.', '✅ Tudo indica que sim.',
  '🤔 Talvez... pergunta outra vez mais tarde.', '🤔 Não consigo prever agora.', '🤔 Concentra-te e pergunta de novo.',
  '🤷 Melhor não te dizer agora.', '❌ Nem pensar.', '❌ Minhas fontes dizem que não.',
  '❌ Duvido muito.', '❌ A resposta é não.'
];

/* ============================================================
 *  DADOS
 * ============================================================ */
const remindersStore = new JsonStore('reminders.json');
remindersStore.data.items ??= [];

/* ============================================================
 *  LEMBRETES (sobrevivem a reinícios)
 * ============================================================ */
async function deliverReminder(client, r) {
  const content = `⏰ <@${r.userId}> Lembrete: ${r.texto}`;
  try {
    const channel = r.channelId ? await client.channels.fetch(r.channelId) : null;
    if (channel?.isTextBased()) {
      await channel.send({ content, allowedMentions: { users: [r.userId] } });
      return;
    }
  } catch (_) { /* cai para a DM */ }
  const user = await client.users.fetch(r.userId).catch(() => null);
  if (user) await user.send(content).catch(() => {});
}

let funTimer = null;
let funTickRunning = false;

async function funTick(client) {
  if (funTickRunning) return;
  funTickRunning = true;
  try {
    const now = Date.now();
    const vencidos = remindersStore.data.items.filter((r) => r.endsAt <= now);
    if (vencidos.length) {
      remindersStore.data.items = remindersStore.data.items.filter((r) => r.endsAt > now);
      remindersStore.save();
      for (const r of vencidos) await deliverReminder(client, r);
    }
  } catch (err) {
    console.error('[fun/agendador]', err.message);
  } finally {
    funTickRunning = false;
  }
}

function startFunScheduler(client) {
  if (funTimer) return;
  funTimer = setInterval(() => funTick(client), 15000);
  funTick(client);
}

/* ============================================================
 *  COMANDOS SLASH
 * ============================================================ */
const funSlashCommands = [
  new SlashCommandBuilder().setName('8ball').setDescription('Faz uma pergunta à bola mágica').addStringOption(o => o.setName('pergunta').setDescription('A tua pergunta').setRequired(true).setMaxLength(200)),
  new SlashCommandBuilder().setName('dado').setDescription('Rola um ou mais dados')
    .addIntegerOption(o => o.setName('lados').setDescription('Número de lados (padrão 6)').setRequired(false).setMinValue(2).setMaxValue(1000))
    .addIntegerOption(o => o.setName('quantidade').setDescription('Quantos dados (padrão 1)').setRequired(false).setMinValue(1).setMaxValue(10)),
  new SlashCommandBuilder().setName('escolher').setDescription('O bot escolhe uma opção por ti').addStringOption(o => o.setName('opcoes').setDescription('Opções separadas por ; ou , ou |').setRequired(true).setMaxLength(500)),
  new SlashCommandBuilder().setName('enquete').setDescription('Cria uma enquete com reações')
    .addStringOption(o => o.setName('pergunta').setDescription('Pergunta da enquete').setRequired(true).setMaxLength(250))
    .addStringOption(o => o.setName('opcoes').setDescription('2 a 9 opções separadas por ; (vazio = 👍/👎)').setRequired(false).setMaxLength(900)),
  new SlashCommandBuilder().setName('lembrete').setDescription('Cria um lembrete para daqui a alguns minutos')
    .addIntegerOption(o => o.setName('minutos').setDescription('Daqui a quantos minutos').setRequired(true).setMinValue(1).setMaxValue(43200))
    .addStringOption(o => o.setName('texto').setDescription('Do que te devo lembrar').setRequired(true).setMaxLength(500)),
  new SlashCommandBuilder().setName('botinfo').setDescription('Informações e estatísticas do bot')
];

const splitOptions = (text, regex) => text.split(regex).map((s) => s.trim()).filter(Boolean);

const COMMANDS = {
  async '8ball'(interaction) {
    const pergunta = interaction.options.getString('pergunta');
    const resposta = BALL_ANSWERS[randInt(0, BALL_ANSWERS.length - 1)];
    const embed = new EmbedBuilder().setColor(0x2C3E50).setTitle('🎱 Bola Mágica')
      .addFields({ name: 'Pergunta', value: truncate(pergunta, 1024) }, { name: 'Resposta', value: resposta });
    return interaction.reply({ embeds: [embed], allowedMentions: { parse: [] } });
  },

  async dado(interaction) {
    const lados = interaction.options.getInteger('lados') ?? 6;
    const qtd = interaction.options.getInteger('quantidade') ?? 1;
    const rolagens = Array.from({ length: qtd }, () => randInt(1, lados));
    const total = rolagens.reduce((a, b) => a + b, 0);
    const detalhe = qtd > 1 ? ` [${rolagens.join(', ')}] = **${total}**` : ` **${total}**`;
    return interaction.reply(`🎲 Rolaste ${qtd}d${lados}:${detalhe}`);
  },

  async escolher(interaction) {
    const opcoes = splitOptions(interaction.options.getString('opcoes'), /[;,|]/);
    if (opcoes.length < 2) return interaction.reply(eph('❌ Indica pelo menos 2 opções separadas por `;`, `,` ou `|`.'));
    const escolha = opcoes[randInt(0, opcoes.length - 1)];
    return interaction.reply({ content: `🤔 Eu escolho: **${truncate(escolha, 500)}**`, allowedMentions: { parse: [] } });
  },

  async enquete(interaction) {
    const pergunta = interaction.options.getString('pergunta');
    const raw = interaction.options.getString('opcoes');
    const opcoes = raw ? splitOptions(raw, /[;|]/).map((o) => truncate(o, 100)) : [];
    if (raw && (opcoes.length < 2 || opcoes.length > 9)) {
      return interaction.reply(eph('❌ Indica entre 2 e 9 opções separadas por `;` (ou deixa vazio para 👍/👎).'));
    }

    const emojis = opcoes.length ? NUM_EMOJIS.slice(0, opcoes.length) : ['👍', '👎'];
    const descricao = opcoes.length ? opcoes.map((o, i) => `${emojis[i]} ${o}`).join('\n') : 'Reage com 👍 ou 👎';
    const embed = new EmbedBuilder().setColor(0x3498DB).setTitle(`📊 ${pergunta}`).setDescription(descricao)
      .setFooter({ text: `Enquete de ${interaction.user.username}` }).setTimestamp();

    await interaction.reply({ embeds: [embed], allowedMentions: { parse: [] } });
    const msg = await interaction.fetchReply().catch(() => null);
    if (msg) for (const e of emojis) await msg.react(e).catch(() => {});
  },

  async lembrete(interaction) {
    const minutos = interaction.options.getInteger('minutos');
    const texto = interaction.options.getString('texto');
    const pendentes = remindersStore.data.items.filter((r) => r.userId === interaction.user.id).length;
    if (pendentes >= MAX_REMINDERS) return interaction.reply(eph(`❌ Já tens ${MAX_REMINDERS} lembretes pendentes.`));

    const endsAt = Date.now() + minutos * 60000;
    remindersStore.data.items.push({ userId: interaction.user.id, channelId: interaction.channelId, texto, endsAt });
    remindersStore.save();
    return interaction.reply(eph(`⏰ Combinado! Lembro-te <t:${unix(endsAt)}:R>.`));
  },

  async botinfo(interaction) {
    const c = interaction.client;
    const embed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle(`🤖 ${c.user.username}`)
      .setThumbnail(c.user.displayAvatarURL({ size: 256 }))
      .addFields(
        { name: '🌐 Servidores', value: `${c.guilds.cache.size}`, inline: true },
        { name: '📡 Ping', value: `${Math.round(c.ws.ping)}ms`, inline: true },
        { name: '⏱️ Online desde', value: `<t:${unix(Date.now() - c.uptime)}:R>`, inline: true },
        { name: '💾 Memória', value: `${(process.memoryUsage().rss / 1024 / 1024).toFixed(1)} MB`, inline: true },
        { name: '🟢 Node.js', value: process.version, inline: true },
        { name: '📦 discord.js', value: `v${djsVersion}`, inline: true }
      );
    const link = inviteUrl(c);
    if (link) embed.setDescription('Quer o bot no seu servidor? É só clicar no botão abaixo! 👇');
    const components = link
      ? [new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel('Adicionar ao meu servidor').setEmoji('➕').setStyle(ButtonStyle.Link).setURL(link))]
      : [];
    return interaction.reply({ embeds: [embed], components });
  }
};

const handledCommands = Object.keys(COMMANDS);

async function handleFunInteraction(interaction) {
  try {
    if (!interaction.isChatInputCommand()) return;
    if (!Object.hasOwn(COMMANDS, interaction.commandName)) return;
    await COMMANDS[interaction.commandName](interaction);
  } catch (err) {
    console.error('[interação/fun]', err);
    try { const aviso = describeError(err); if (aviso) await respond(interaction, eph(aviso)); } catch (_) { /* ignora */ }
  }
}

module.exports = { funSlashCommands, handledCommands, handleFunInteraction, startFunScheduler };
