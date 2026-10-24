cat << 'EOF' > ticket.js
const { ChannelType, PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, SlashCommandBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, AttachmentBuilder } = require('discord.js');
const fs = require('fs');

const CONFIG_FILE = './welcome_config.json';
const WARNINGS_FILE = './warnings.json';
const CENSURA_FILE = './censura.json';

function getConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      const formatted = {};
      for (const [guildId, val] of Object.entries(data)) {
        if (typeof val === 'string') {
          formatted[guildId] = { verifyRole: val };
        } else {
          formatted[guildId] = val;
        }
      }
      return formatted;
    }
  } catch (e) {}
  return {};
}

function saveConfig(data) {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {}
}

function getWarnings() {
  try {
    if (fs.existsSync(WARNINGS_FILE)) {
      return JSON.parse(fs.readFileSync(WARNINGS_FILE, 'utf8'));
    }
  } catch (e) {}
  return {};
}

function saveWarnings(data) {
  try {
    fs.writeFileSync(WARNINGS_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {}
}

function getCensura() {
  try {
    if (fs.existsSync(CENSURA_FILE)) {
      return JSON.parse(fs.readFileSync(CENSURA_FILE, 'utf8'));
    }
  } catch (e) {}
  return {};
}

function saveCensura(data) {
  try {
    fs.writeFileSync(CENSURA_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {}
}

function hasAdminPermission(member, guildConfig) {
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  if (guildConfig.adminRoles && guildConfig.adminRoles.some(rId => member.roles.cache.has(rId))) return true;
  if (guildConfig.adminUsers && guildConfig.adminUsers.includes(member.id)) return true;
  return false;
}

const globalCooldowns = new Map();
const closingTickets = new Set();
const ticketRatings = new Map();
const permNicks = new Map();
const caladosMap = new Set(); // Guarda os IDs dos usuários que estão "calados" (mensagens apagadas)

function checkGlobalCooldown(userId) {
  const agora = Date.now();
  const ultimoUso = globalCooldowns.get(userId) || 0;
  if (agora - ultimoUso < 3000) {
    return Math.ceil((3000 - (agora - ultimoUso)) / 1000);
  }
  globalCooldowns.set(userId, agora);
  return 0;
}

async function sendLog(guild, type, embed, attachment = null) {
  try {
    const config = getConfig();
    const guildConfig = config[guild.id];
    if (!guildConfig) return;

    let channelId = null;
    if (type === 'denuncia') channelId = guildConfig.denunciasChannel || guildConfig.logsChannel;
    else if (type === 'duvida') channelId = guildConfig.duvidasChannel || guildConfig.logsChannel;
    else if (type === 'punicao') channelId = guildConfig.punicoesChannel || guildConfig.logsChannel;
    else if (type === 'sugestao') channelId = guildConfig.suggestionChannel || guildConfig.logsChannel;
    else if (type === 'apagada') channelId = guildConfig.msgDeleteChannel || guildConfig.logsChannel;
    else channelId = guildConfig.logsChannel;

    if (!channelId) return;
    let channel = guild.channels.cache.get(channelId);
    if (!channel) {
      try { channel = await guild.channels.fetch(channelId); } catch (e) {}
    }

    if (channel) {
      const options = { embeds: [embed] };
      if (attachment) options.files = [attachment];
      await channel.send(options);
    }
  } catch (e) {}
}

const allSlashCommands = [
  new SlashCommandBuilder().setName('ping').setDescription('Latência do bot'),
  new SlashCommandBuilder().setName('say').setDescription('Faz o bot falar').addStringOption(o => o.setName('texto').setDescription('Texto').setRequired(true)),
  new SlashCommandBuilder().setName('clear').setDescription('Limpa mensagens').addIntegerOption(o => o.setName('qtd').setDescription('Quantidade (1-100)').setRequired(true)),
  new SlashCommandBuilder().setName('avatar').setDescription('Mostra o avatar').addUserOption(o => o.setName('usuario').setDescription('Alvo').setRequired(false)),
  new SlashCommandBuilder().setName('serverinfo').setDescription('Informações do servidor'),
  new SlashCommandBuilder().setName('userinfo').setDescription('Informações de um usuário').addUserOption(o => o.setName('usuario').setDescription('Alvo').setRequired(false)),
  new SlashCommandBuilder().setName('ban').setDescription('Bane um membro').addUserOption(o => o.setName('usuario').setDescription('Usuário').setRequired(true)).addStringOption(o => o.setName('motivo').setDescription('Motivo').setRequired(false)),
  new SlashCommandBuilder().setName('kick').setDescription('Expulsa um membro').addUserOption(o => o.setName('usuario').setDescription('Usuário').setRequired(true)).addStringOption(o => o.setName('motivo').setDescription('Motivo').setRequired(false)),
  
  new SlashCommandBuilder().setName('mute').setDescription('Silencia um membro por tempo determinado')
    .addUserOption(o => o.setName('usuario').setDescription('Usuário').setRequired(true))
    .addIntegerOption(o => o.setName('minutos').setDescription('Tempo do silêncio em minutos').setRequired(true))
    .addStringOption(o => o.setName('motivo').setDescription('Motivo do mute').setRequired(false)),

  new SlashCommandBuilder().setName('unmute').setDescription('Remove o silenciamento de um membro').addUserOption(o => o.setName('usuario').setDescription('Usuário').setRequired(true)),
  new SlashCommandBuilder().setName('warn').setDescription('Avisa um membro').addUserOption(o => o.setName('usuario').setDescription('Usuário').setRequired(true)).addStringOption(o => o.setName('motivo').setDescription('Motivo').setRequired(true)),
  new SlashCommandBuilder().setName('warnings').setDescription('Mostra os avisos de um membro').addUserOption(o => o.setName('usuario').setDescription('Usuário').setRequired(true)),
  new SlashCommandBuilder().setName('setcargo').setDescription('Adiciona ou remove um cargo de um membro').addUserOption(o => o.setName('usuario').setDescription('Membro').setRequired(true)).addRoleOption(o => o.setName('cargo').setDescription('Cargo').setRequired(true)),
  new SlashCommandBuilder().setName('lock').setDescription('Tranca o canal atual'),
  new SlashCommandBuilder().setName('unlock').setDescription('Destranca o canal atual'),
  new SlashCommandBuilder().setName('ticket').setDescription('Envia o painel de atendimento/denúncia'),
  new SlashCommandBuilder().setName('painel-sugestao').setDescription('Envia o painel interativo de sugestões'),
  new SlashCommandBuilder().setName('help').setDescription('Painel de ajuda interativo'),
  new SlashCommandBuilder().setName('setwelcome').setDescription('Define o canal de boas-vindas').addChannelOption(o => o.setName('canal').setDescription('Canal de texto').setRequired(true)),
  new SlashCommandBuilder().setName('setautorole').setDescription('Define o cargo automático para novos membros').addRoleOption(o => o.setName('cargo').setDescription('Cargo de membro').setRequired(true)),
  new SlashCommandBuilder().setName('delautorole').setDescription('Remove o cargo automático de novos membros'),
  new SlashCommandBuilder().setName('setsuggestion').setDescription('Define o canal de sugestões').addChannelOption(o => o.setName('canal').setDescription('Canal de sugestões').setRequired(true)),
  new SlashCommandBuilder().setName('setlogs').setDescription('Define o canal de logs geral').addChannelOption(o => o.setName('canal').setDescription('Canal de logs').setRequired(true)),
  new SlashCommandBuilder().setName('setdenuncias').setDescription('Define o canal de logs de denúncias').addChannelOption(o => o.setName('canal').setDescription('Canal').setRequired(true)),
  new SlashCommandBuilder().setName('setduvidas').setDescription('Define o canal de logs de dúvidas').addChannelOption(o => o.setName('canal').setDescription('Canal').setRequired(true)),
  new SlashCommandBuilder().setName('setpunicoes').setDescription('Define o canal de logs de punições').addChannelOption(o => o.setName('canal').setDescription('Canal').setRequired(true)),
  new SlashCommandBuilder().setName('setmsgdelete').setDescription('Define o canal de logs para mensagens apagadas').addChannelOption(o => o.setName('canal').setDescription('Canal').setRequired(true)),
  new SlashCommandBuilder().setName('setverify').setDescription('Envia o painel de verificação por botão').addChannelOption(o => o.setName('canal').setDescription('Canal de verificação').setRequired(true)).addRoleOption(o => o.setName('cargo').setDescription('Cargo liberado ao verificar').setRequired(true)),
  new SlashCommandBuilder().setName('automod').setDescription('Ativa ou desativa o automod de links').addBooleanOption(o => o.setName('status').setDescription('Ligado/Desligado').setRequired(true)),
  new SlashCommandBuilder().setName('sugerir').setDescription('Envia uma sugestão').addStringOption(o => o.setName('ideia').setDescription('Sua ideia').setRequired(true)),
  new SlashCommandBuilder().setName('denuncia').setDescription('Envia uma denúncia anônima para a staff').addStringOption(o => o.setName('mensagem').setDescription('Detalhes da denúncia').setRequired(true)),
  new SlashCommandBuilder().setName('sorteio').setDescription('Cria um sorteio').addStringOption(o => o.setName('premio').setDescription('Prêmio').setRequired(true)).addIntegerOption(o => o.setName('minutos').setDescription('Tempo em minutos').setRequired(true)),
  new SlashCommandBuilder().setName('embed').setDescription('Cria um embed personalizado').addStringOption(o => o.setName('titulo').setDescription('Título').setRequired(true)).addStringOption(o => o.setName('descricao').setDescription('Descrição').setRequired(true)),
  new SlashCommandBuilder().setName('setadminrole').setDescription('Adiciona um cargo com permissões administrativas do bot').addRoleOption(o => o.setName('cargo').setDescription('Cargo permitida').setRequired(true)),
  new SlashCommandBuilder().setName('setadminuser').setDescription('Adiciona um usuário com permissões administrativas do bot').addUserOption(o => o.setName('usuario').setDescription('Usuário permitido').setRequired(true)),
  new SlashCommandBuilder().setName('nick').setDescription('Altera o apelido de um membro').addUserOption(o => o.setName('usuario').setDescription('Membro').setRequired(true)).addStringOption(o => o.setName('apelido').setDescription('Novo apelido').setRequired(true)),
  new SlashCommandBuilder().setName('permnick').setDescription('Trava o apelido de um membro permanentemente').addUserOption(o => o.setName('usuario').setDescription('Membro').setRequired(true)).addStringOption(o => o.setName('apelido').setDescription('Apelido fixo').setRequired(true)),
  
  // Comando calado (ativa/desativa remoção automática de mensagens)
  new SlashCommandBuilder().setName('calado').setDescription('Deixa um membro calado (apaga todas as mensagens dele)').addUserOption(o => o.setName('usuario').setDescription('Membro').setRequired(true)),

  new SlashCommandBuilder().setName('censura').setDescription('Gerencia palavras censuradas')
    .addStringOption(o => o.setName('acao').setDescription('Ação').setRequired(true).addChoices(
      { name: 'Adicionar', value: 'add' },
      { name: 'Remover', value: 'remove' },
      { name: 'Listar', value: 'list' }
    ))
    .addStringOption(o => o.setName('palavra').setDescription('Palavra').setRequired(false))
];

function getHelpEmbed(page) {
  const embed = new EmbedBuilder().setColor(0x00AE86).setFooter({ text: `Página ${page} de 4 • Zapher Bot` });
  switch (page) {
    case 1:
      embed.setTitle('📖 Central de Ajuda — Moderação & Administração (1/4)')
           .addFields({ name: '🛡️ Comandos de Staff', value: '• `/clear`: Limpa mensagens.\n• `/lock` / `/unlock`: Tranca canal.\n• `/setcargo`: Gerencia cargos.\n• `/ban` / `/kick` / `/mute [minutos]`: Punições.\n• `/calado`: Apaga todas as msgs do usuário.' });
      break;
    case 2:
      embed.setTitle('📖 Central de Ajuda — Configurações & Logs (2/4)')
           .addFields({ name: '⚙️ Setups do Servidor', value: '• `/setwelcome`: Boas-vindas.\n• `/setlogs`: Logs geral.\n• `/setdenuncias`: Denúncias.\n• `/setduvidas`: Dúvidas.\n• `/setpunicoes`: Punições.\n• `/setmsgdelete`: Mensagens apagadas.' });
      break;
    case 3:
      embed.setTitle('📖 Central de Ajuda — Economia & Ganhos (3/4)')
           .addFields({ name: '💳 Sistema Financeiro & Trabalho', value: '• `/saldo` / `/patrimonio`: Consulta fundos.\n• `/depositar` / `/sacar` / `/transferir`: Banco e Pix.\n• `/perfil` / `/rank` / `/extrato`: Dados e Top 10.\n• `/daily` / `/trabalhar` / `/minerar`: Obter lucros.\n• `/investir` / `/loteria`: Aplicações e sorte.' });
      break;
    case 4:
      embed.setTitle('📖 Central de Ajuda — Lojas, Jogos & Utilitários (4/4)')
           .addFields({ name: '🛒 Lojas & Outros', value: '• `/mercado` (Painel interativo de compras).\n• `/apostar` / `/slots`: Jogos de risco.\n• `/ticket` / `/sugerir`: Suporte e ideias.\n• `/ping` / `/say` / `/embed`: Utilitários.' });
      break;
  }
  return embed;
}

function getHelpButtons(page) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('help_prev').setLabel('◀️ Anterior').setStyle(ButtonStyle.Primary).setDisabled(page === 1),
    new ButtonBuilder().setCustomId('help_next').setLabel('Próxima ▶️').setStyle(ButtonStyle.Primary).setDisabled(page === 4)
  );
}

async function sendTicketPanel(channel) {
  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('🎫 Central de Atendimento & Denúncias')
    .setDescription('Precisa de ajuda ou deseja realizar uma denúncia sigilosa?\n\nClique no botão abaixo para abrir um canal de atendimento privado.')
    .setFooter({ text: 'Sistema de Segurança e Suporte Zapher' });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('create_ticket_duvida').setLabel('❓ Abrir Dúvida').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('create_ticket_denuncia').setLabel('🚨 Fazer Denúncia').setStyle(ButtonStyle.Danger)
  );
  await channel.send({ embeds: [embed], components: [row] });
}

async function sendSuggestionPanel(channel) {
  const embed = new EmbedBuilder()
    .setColor(0xF1C40F)
    .setTitle('💡 Central de Sugestões')
    .setDescription('Clique no botão abaixo para abrir a janela (Modal) e enviar sua sugestão diretamente para a equipe!');

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('btn_abrir_sugestao').setLabel('Enviar Sugestão').setStyle(ButtonStyle.Success).setEmoji('💡')
  );
  await channel.send({ embeds: [embed], components: [row] });
}

const ticketCreators = new Map();
const ticketTypesMap = new Map();

async function handleMessage(message) {
  if (message.author.bot || !message.guild) return;

  // VERIFICA SE O USUÁRIO ESTÁ NA LISTA DE "CALADOS" (APAGA TODAS AS MENSAGENS DELE)
  if (caladosMap.has(message.author.id)) {
    try {
      await message.delete();
      return;
    } catch (e) {}
  }

  const content = message.content.trim();

  const censuraData = getCensura();
  const palavrasProibidas = censuraData[message.guild.id] || [];
  if (palavrasProibidas.length > 0 && !hasAdminPermission(message.member, getConfig()[message.guild.id] || {})) {
    const textoLower = message.content.toLowerCase();
    const contemProibida = palavrasProibidas.some(palavra => textoLower.includes(palavra.toLowerCase()));
    if (contemProibida) {
      try {
        await message.delete();
        const aviso = await message.channel.send(`⚠️ <@${message.author.id}>, mensagem apagada por conter censura.`);
        setTimeout(() => aviso.delete().catch(() => {}), 4000);
        return;
      } catch (e) {}
    }
  }

  if (!content.startsWith('?')) return;

  const tempoRestante = checkGlobalCooldown(message.author.id);
  if (tempoRestante > 0) {
    return message.reply(`⏳ Aguarde **${tempoRestante} segundos** para usar outro comando.`);
  }

  const args = content.slice(1).trim().split(/ +/);
  const command = args.shift().toLowerCase();
  
  const guild = message.guild;
  const member = message.member;
  const channel = message.channel;
  const config = getConfig();
  const guildConfig = config[guild.id] || {};

  if (command === 'ping') {
    return message.reply(`🏓 Pong! ${Date.now() - message.createdTimestamp}ms`);
  }
  if (command === 'help') {
    return message.reply({ embeds: [getHelpEmbed(1)], components: [getHelpButtons(1)] });
  }
  if (command === 'say') {
    const texto = args.join(' ');
    if (!texto) return message.reply('❌ Escreve o texto que queres que o bot diga.');
    await message.delete().catch(() => {});
    return channel.send(texto);
  }
  if (command === 'clear') {
    if (!hasAdminPermission(member, guildConfig) && !member.permissions.has(PermissionFlagsBits.ManageMessages)) {
      return message.reply('❌ Sem permissão.');
    }
    const qtd = parseInt(args[0]);
    if (!qtd || qtd < 1 || qtd > 100) return message.reply('❌ Indica uma quantidade entre 1 e 100.');
    try {
      await channel.bulkDelete(qtd, true);
      const msg = await channel.send(`✅ ${qtd} mensagens limpas!`);
      setTimeout(() => msg.delete().catch(() => {}), 3000);
    } catch (e) {
      return message.reply('❌ Erro ao limpar mensagens.');
    }
  }
  if (command === 'lock') {
    if (!hasAdminPermission(member, guildConfig) && !member.permissions.has(PermissionFlagsBits.ManageChannels)) {
      return message.reply('❌ Sem permissão.');
    }
    await channel.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: false });
    return message.reply('🔒 Canal trancado com sucesso!');
  }
  if (command === 'unlock') {
    if (!hasAdminPermission(member, guildConfig) && !member.permissions.has(PermissionFlagsBits.ManageChannels)) {
      return message.reply('❌ Sem permissão.');
    }
    await channel.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: null });
    return message.reply('🔓 Canal destrancado com sucesso!');
  }
  if (command === 'ticket') {
    if (!hasAdminPermission(member, guildConfig)) return message.reply('❌ Sem permissão.');
    await sendTicketPanel(channel);
    return message.reply({ content: '✅ Painel de tickets enviado!', ephemeral: true });
  }
}

async function handleMessageDelete(message) {
  if (!message.guild || message.author?.bot) return;
  const embed = new EmbedBuilder()
    .setColor(0xE74C3C)
    .setTitle('🗑️ Mensagem Apagada')
    .addFields(
      { name: '👤 Autor', value: `<@${message.author?.id || 'Desconhecido'}>`, inline: true },
      { name: '📁 Canal', value: `<#${message.channel.id}>`, inline: true },
      { name: '💬 Conteúdo', value: message.content || '[Anexo/Vazio]', inline: false }
    )
    .setTimestamp();

  await sendLog(message.guild, 'apagada', embed);
}

async function handleInteraction(interaction) {
  if (interaction.isButton()) {
    if (interaction.customId === 'help_prev' || interaction.customId === 'help_next') {
      let footerText = interaction.message.embeds[0].footer.text;
      let currentPage = parseInt(footerText.match(/Página (\d+)/)[1]);
      if (interaction.customId === 'help_prev' && currentPage > 1) currentPage--;
      if (interaction.customId === 'help_next' && currentPage < 4) currentPage++;
      await interaction.update({ embeds: [getHelpEmbed(currentPage)], components: [getHelpButtons(currentPage)] });
      return;
    }

    if (interaction.customId === 'verify_btn') {
      const configData = getConfig();
      const roleId = configData[interaction.guild.id]?.verifyRole;
      if (!roleId) return interaction.reply({ content: '❌ Cargo de verificação não configurado.', ephemeral: true });
      try {
        await interaction.member.roles.add(roleId);
        return interaction.reply({ content: '✅ Verificado com sucesso!', ephemeral: true });
      } catch (e) {
        return interaction.reply({ content: '❌ Erro ao atribuir cargo.', ephemeral: true });
      }
    }

    if (interaction.customId === 'btn_abrir_sugestao') {
      const modal = new ModalBuilder().setCustomId('modal_sugestao').setTitle('Enviar Sugestão');
      const input = new TextInputBuilder()
        .setCustomId('input_sugestao')
        .setLabel('O que deseja sugerir?')
        .setStyle(TextInputStyle.Paragraph)
        .setPlaceholder('Escreve a tua ideia aqui...')
        .setRequired(true)
        .setMinLength(5);
      modal.addComponents(new ActionRowBuilder().addComponents(input));
      return interaction.showModal(modal);
    }

    if (interaction.customId === 'create_ticket_duvida' || interaction.customId === 'create_ticket_denuncia') {
      const guild = interaction.guild;
      const member = interaction.member;
      const isDenuncia = interaction.customId === 'create_ticket_denuncia';
      const tipo = isDenuncia ? 'denuncia' : 'duvida';
      const nomeCanal = `${tipo}-${member.user.username}`.toLowerCase().replace(/[^a-z0-9]/g, '');

      const existingChannel = guild.channels.cache.find(c => c.name === nomeCanal);
      if (existingChannel) {
        return interaction.reply({ content: `❌ Já tens um canal aberto em <#${existingChannel.id}>!`, ephemeral: true });
      }

      await interaction.deferReply({ ephemeral: true });
      try {
        const ticketChannel = await guild.channels.create({
          name: nomeCanal,
          type: ChannelType.GuildText,
          permissionOverwrites: [
            { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
            { id: member.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
            { id: interaction.client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels] }
          ],
        });

        ticketCreators.set(ticketChannel.id, member.id);
        ticketTypesMap.set(ticketChannel.id, tipo);

        const controlEmbed = new EmbedBuilder()
          .setColor(isDenuncia ? 0xFF0000 : 0x00AE86)
          .setTitle(isDenuncia ? '🚨 Canal de Denúncia' : '❓ Canal de Dúvida')
          .setDescription(`Olá <@${member.id}>, aguarda um membro da staff.`);

        const ratingRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('rate_1').setLabel('⭐ 1').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId('rate_2').setLabel('⭐ 2').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId('rate_3').setLabel('⭐ 3').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId('rate_4').setLabel('⭐ 4').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId('rate_5').setLabel('⭐ 5').setStyle(ButtonStyle.Success)
        );

        const actionRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('claim_ticket').setLabel('🙋‍♂️ Assumir Ticket').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId('close_ticket').setLabel('🔒 Fechar').setStyle(ButtonStyle.Danger)
        );

        await ticketChannel.send({ content: `<@${member.id}> - Avalia o atendimento abaixo:`, embeds: [controlEmbed], components: [ratingRow, actionRow] });
        await interaction.editReply({ content: `✅ Canal criado: <#${ticketChannel.id}>` });
      } catch (err) {
        await interaction.editReply({ content: '❌ Erro ao criar o canal do ticket.' });
      }
    }

    if (interaction.customId === 'claim_ticket') {
      const config = getConfig();
      const guildConfig = config[interaction.guild.id] || {};
      if (!hasAdminPermission(interaction.member, guildConfig)) {
        return interaction.reply({ content: '❌ Apenas a staff pode assumir tickets.', ephemeral: true });
      }
      return interaction.reply({ content: `✅ Atendimento assumido por <@${interaction.user.id}>!` });
    }

    if (interaction.customId === 'close_ticket') {
      const channel = interaction.channel;
      if (closingTickets.has(channel.id)) return interaction.reply({ content: '⚠️ Já está a fechar!', ephemeral: true });
      closingTickets.add(channel.id);

      const creatorId = ticketCreators.get(channel.id);
      const tipoTicket = ticketTypesMap.get(channel.id) || 'duvida';
      const notaFinal = ticketRatings.get(channel.id) || 'Não avaliado';

      await interaction.reply({ content: '🔒 A fechar e a gerar transcript...' });

      try {
        const messages = await channel.messages.fetch({ limit: 100 });
        const transcriptText = messages.reverse().map(m => `[${new Date(m.createdTimestamp).toLocaleString()}] ${m.author.tag}: ${m.content}`).join('\n');
        const buffer = Buffer.from(transcriptText || 'Vazio', 'utf-8');
        const attachment = new AttachmentBuilder(buffer, { name: `transcript-${channel.name}.txt` });
        
        const transcriptEmbed = new EmbedBuilder()
          .setColor(0x5865F2)
          .setTitle(`📜 Transcript: #${channel.name}`)
          .addFields({ name: 'Criador', value: creatorId ? `<@${creatorId}>` : 'Desconhecido', inline: true }, { name: 'Avaliação', value: `${notaFinal} ⭐`, inline: true })
          .setTimestamp();

        await sendLog(channel.guild, tipoTicket, transcriptEmbed, attachment);
      } catch (e) {}

      setTimeout(() => { channel.delete().catch(() => {}); }, 4000);
      return;
    }

    if (interaction.customId.startsWith('rate_')) {
      const nota = interaction.customId.split('_')[1];
      ticketRatings.set(interaction.channel.id, nota);
      return interaction.reply({ content: `✅ Votaste com **${nota} estrela(s)**!`, ephemeral: true });
    }
  }

  if (interaction.isModalSubmit()) {
    if (interaction.customId === 'modal_sugestao') {
      const texto = interaction.fields.getTextInputValue('input_sugestao');
      const embed = new EmbedBuilder().setColor(0xFFA500).setTitle('💡 Nova Sugestão').setDescription(texto).setFooter({ text: interaction.user.tag }).setTimestamp();
      await sendLog(interaction.guild, 'sugestao', embed);
      return interaction.reply({ content: '✅ Sugestão enviada com sucesso!', ephemeral: true });
    }
  }

  if (!interaction.isChatInputCommand()) return;

  const { commandName, options, member, guild, channel } = interaction;
  const config = getConfig();
  const guildConfig = config[guild.id] || {};

  if (commandName === 'ping') {
    await interaction.reply({ content: `🏓 Pong! ${Date.now() - interaction.createdTimestamp}ms`, ephemeral: true });
  } 
  else if (commandName === 'help') {
    await interaction.reply({ embeds: [getHelpEmbed(1)], components: [getHelpButtons(1)], ephemeral: true });
  }
  else if (commandName === 'lock') {
    if (!hasAdminPermission(member, guildConfig) && !member.permissions.has(PermissionFlagsBits.ManageChannels)) {
      return interaction.reply({ content: '❌ Sem permissão.', ephemeral: true });
    }
    await channel.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: false });
    await interaction.reply({ content: '🔒 Canal trancado!' });
  }
  else if (commandName === 'unlock') {
    if (!hasAdminPermission(member, guildConfig) && !member.permissions.has(PermissionFlagsBits.ManageChannels)) {
      return interaction.reply({ content: '❌ Sem permissão.', ephemeral: true });
    }
    await channel.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: null });
    await interaction.reply({ content: '🔓 Canal destrancado!' });
  }
  else if (commandName === 'say') {
    await channel.send(options.getString('texto'));
    await interaction.reply({ content: '✅ Enviado!', ephemeral: true });
  }
  else if (commandName === 'clear') {
    if (!hasAdminPermission(member, guildConfig) && !member.permissions.has(PermissionFlagsBits.ManageMessages)) {
      return interaction.reply({ content: '❌ Sem permissão.', ephemeral: true });
    }
    const qtd = options.getInteger('qtd');
    await interaction.deferReply({ ephemeral: true });
    try {
      await channel.bulkDelete(qtd, true);
      await interaction.editReply({ content: `✅ ${qtd} mensagens limpas!` });
    } catch (e) {
      await interaction.editReply({ content: '❌ Erro ao limpar mensagens.' });
    }
  }
  else if (commandName === 'avatar') {
    const alvo = options.getUser('usuario') || interaction.user;
    const embed = new EmbedBuilder().setColor(0x00AE86).setTitle(`Avatar de ${alvo.tag}`).setImage(alvo.displayAvatarURL({ size: 1024, dynamic: true }));
    await interaction.reply({ embeds: [embed] });
  }
  else if (commandName === 'serverinfo') {
    const embed = new EmbedBuilder().setColor(0x00AE86).setTitle(guild.name).addFields({ name: 'Membros', value: `${guild.memberCount}`, inline: true });
    await interaction.reply({ embeds: [embed] });
  }
  else if (commandName === 'userinfo') {
    const alvo = options.getMember('usuario') || member;
    const embed = new EmbedBuilder().setColor(0x00AE86).setTitle(alvo.user.tag).addFields({ name: 'ID', value: alvo.id, inline: true });
    await interaction.reply({ embeds: [embed] });
  }
  else if (commandName === 'ban') {
    if (!hasAdminPermission(member, guildConfig) && !member.permissions.has(PermissionFlagsBits.BanMembers)) {
      return interaction.reply({ content: '❌ Sem permissão.', ephemeral: true });
    }
    const alvo = options.getUser('usuario');
    const motivo = options.getString('motivo') || 'Sem motivo';
    await guild.members.ban(alvo, { reason: motivo });
    await interaction.reply({ content: `✅ Banido: **${alvo.tag}**` });
  }
  else if (commandName === 'kick') {
    if (!hasAdminPermission(member, guildConfig) && !member.permissions.has(PermissionFlagsBits.KickMembers)) {
      return interaction.reply({ content: '❌ Sem permissão.', ephemeral: true });
    }
    const alvo = options.getMember('usuario');
    const motivo = options.getString('motivo') || 'Sem motivo';
    await alvo.kick(motivo);
    await interaction.reply({ content: `✅ Expulso: **${alvo.user.tag}**` });
  }
  else if (commandName === 'mute') {
    if (!hasAdminPermission(member, guildConfig)) return interaction.reply({ content: '❌ Sem permissão.', ephemeral: true });
    const alvo = options.getMember('usuario');
    const minutos = options.getInteger('minutos');
    const motivo = options.getString('motivo') || 'Sem motivo especificado';
    
    try {
      await alvo.timeout(minutos * 60 * 1000, motivo);
      await interaction.reply({ content: `✅ <@${alvo.id}> foi silenciado por **${minutos} minuto(s)**. Motivo: *${motivo}*` });
    } catch (e) {
      await interaction.reply({ content: '❌ Erro ao silenciar o membro.', ephemeral: true });
    }
  }
  else if (commandName === 'unmute') {
    if (!hasAdminPermission(member, guildConfig)) return interaction.reply({ content: '❌ Sem permissão.', ephemeral: true });
    const alvo = options.getMember('usuario');
    await alvo.timeout(null, 'Unmute');
    // Se estivesse calado, remove também da lista de calados
    caladosMap.delete(alvo.id);
    await interaction.reply({ content: `✅ Silêncio e restrições removidos de ${alvo.user.tag}.` });
  }
  // COMANDO CALADO: Alterna o estado de apagar mensagens automaticamente do usuário
  else if (commandName === 'calado') {
    if (!hasAdminPermission(member, guildConfig)) return interaction.reply({ content: '❌ Sem permissão.', ephemeral: true });
    const alvo = options.getUser('usuario');
    
    if (caladosMap.has(alvo.id)) {
      caladosMap.delete(alvo.id);
      await interaction.reply({ content: `🔊 <@${alvo.id}> não está mais calado (as mensagens voltaram a aparecer).` });
    } else {
      caladosMap.add(alvo.id);
      await interaction.reply({ content: `🔇 <@${alvo.id}> foi deixado **calado**! A partir de agora, todas as mensagens dele serão apagadas automaticamente.` });
    }
  }
  else if (commandName === 'setcargo') {
    if (!hasAdminPermission(member, guildConfig) && !member.permissions.has(PermissionFlagsBits.ManageRoles)) {
      return interaction.reply({ content: '❌ Sem permissão.', ephemeral: true });
    }
    const alvo = options.getMember('usuario');
    const cargo = options.getRole('cargo');
    try {
      if (alvo.roles.cache.has(cargo.id)) {
        await alvo.roles.remove(cargo);
        await interaction.reply({ content: `✅ Cargo <@&${cargo.id}> removido de ${alvo.user.tag}.` });
      } else {
        await alvo.roles.add(cargo);
        await interaction.reply({ content: `✅ Cargo <@&${cargo.id}> adicionado a ${alvo.user.tag}.` });
      }
    } catch (e) {
      await interaction.reply({ content: '❌ Erro ao gerenciar cargo.', ephemeral: true });
    }
  }
  else if (commandName === 'warn') {
    if (!hasAdminPermission(member, guildConfig)) return interaction.reply({ content: '❌ Sem permissão.', ephemeral: true });
    const alvo = options.getUser('usuario');
    const motivo = options.getString('motivo');
    const warnings = getWarnings();
    if (!warnings[guild.id]) warnings[guild.id] = {};
    if (!warnings[guild.id][alvo.id]) warnings[guild.id][alvo.id] = [];
    warnings[guild.id][alvo.id].push({ motivo, data: new Date().toLocaleDateString() });
    saveWarnings(warnings);
    await interaction.reply({ content: `✅ Aviso registado para ${alvo.tag}.` });
  }
  else if (commandName === 'warnings') {
    const alvo = options.getUser('usuario');
    const warnings = getWarnings();
    const lista = warnings[guild.id]?.[alvo.id] || [];
    if (lista.length === 0) return interaction.reply({ content: `ℹ️ ${alvo.tag} não tem avisos.`, ephemeral: true });
    const desc = lista.map((w, i) => `${i+1}. ${w.motivo} (${w.data})`).join('\n');
    await interaction.reply({ content: `⚠️ Avisos de ${alvo.tag}:\n${desc}`, ephemeral: true });
  }
  else if (commandName === 'ticket') {
    if (!hasAdminPermission(member, guildConfig)) return interaction.reply({ content: '❌ Sem permissão.', ephemeral: true });
    await sendTicketPanel(channel);
    await interaction.reply({ content: '✅ Painel de tickets enviado!', ephemeral: true });
  }
  else if (commandName === 'painel-sugestao') {
    if (!hasAdminPermission(member, guildConfig)) return interaction.reply({ content: '❌ Sem permissão.', ephemeral: true });
    await sendSuggestionPanel(channel);
    await interaction.reply({ content: '✅ Painel de sugestões enviado!', ephemeral: true });
  }
  else if (commandName === 'sugerir') {
    const ideia = options.getString('ideia');
    const embed = new EmbedBuilder().setColor(0xFFA500).setTitle('💡 Sugestão').setDescription(ideia).setFooter({ text: interaction.user.tag });
    await sendLog(guild, 'sugestao', embed);
    await interaction.reply({ content: '✅ Sugestão enviada!', ephemeral: true });
  }
  else if (commandName === 'denuncia') {
    const texto = options.getString('mensagem');
    const embed = new EmbedBuilder().setColor(0xFF0000).setTitle('🚨 Denúncia Anônima').setDescription(texto);
    await sendLog(guild, 'denuncia', embed);
    await interaction.reply({ content: '✅ Denúncia enviada à staff.', ephemeral: true });
  }
  else if (commandName === 'sorteio') {
    if (!hasAdminPermission(member, guildConfig)) return interaction.reply({ content: '❌ Sem permissão.', ephemeral: true });
    const premio = options.getString('premio');
    const msg = await channel.send({ embeds: [new EmbedBuilder().setTitle('🎉 SORTEIO').setDescription(`Prêmio: **${premio}**`)] });
    await msg.react('🎉');
    await interaction.reply({ content: '✅ Sorteio iniciado!', ephemeral: true });
  }
  else if (commandName === 'embed') {
    if (!hasAdminPermission(member, guildConfig)) return interaction.reply({ content: '❌ Sem permissão.', ephemeral: true });
    await channel.send({ embeds: [new EmbedBuilder().setTitle(options.getString('titulo')).setDescription(options.getString('descricao')).setColor(0x3498DB)] });
    await interaction.reply({ content: '✅ Embed criado!', ephemeral: true });
  }
  else if (commandName === 'automod') {
    if (!hasAdminPermission(member, guildConfig)) return interaction.reply({ content: '❌ Sem permissão.', ephemeral: true });
    if (!config[guild.id]) config[guild.id] = {};
    config[guild.id].automod = options.getBoolean('status');
    saveConfig(config);
    await interaction.reply({ content: '✅ Automod atualizado!', ephemeral: true });
  }
  else if (commandName === 'setadminrole') {
    if (!member.permissions.has(PermissionFlagsBits.Administrator)) return interaction.reply({ content: '❌ Apenas Administradores.', ephemeral: true });
    const cargo = options.getRole('cargo');
    if (!config[guild.id]) config[guild.id] = {};
    if (!config[guild.id].adminRoles) config[guild.id].adminRoles = [];
    config[guild.id].adminRoles.push(cargo.id);
    saveConfig(config);
    await interaction.reply({ content: `✅ Cargo <@&${cargo.id}> adicionado como admin do bot.`, ephemeral: true });
  }
  else if (commandName === 'setadminuser') {
    if (!member.permissions.has(PermissionFlagsBits.Administrator)) return interaction.reply({ content: '❌ Apenas Administradores.', ephemeral: true });
    const usuario = options.getUser('usuario');
    if (!config[guild.id]) config[guild.id] = {};
    if (!config[guild.id].adminUsers) config[guild.id].adminUsers = [];
    config[guild.id].adminUsers.push(usuario.id);
    saveConfig(config);
    await interaction.reply({ content: `✅ Utilizador <@${usuario.id}> adicionado como admin do bot.`, ephemeral: true });
  }
  else if (commandName === 'nick') {
    if (!hasAdminPermission(member, guildConfig)) return interaction.reply({ content: '❌ Sem permissão.', ephemeral: true });
    const alvo = options.getMember('usuario');
    const apelido = options.getString('apelido');
    await alvo.setNickname(apelido);
    await interaction.reply({ content: `✅ Apelido de ${alvo.user.tag} alterado.` });
  }
  else if (commandName === 'permnick') {
    if (!hasAdminPermission(member, guildConfig)) return interaction.reply({ content: '❌ Sem permissão.', ephemeral: true });
    const alvo = options.getMember('usuario');
    const apelido = options.getString('apelido');
    await alvo.setNickname(apelido);
    permNicks.set(alvo.id, apelido);
    await interaction.reply({ content: `🔒 Apelido de ${alvo.user.tag} travado como **${apelido}**.` });
  }
  else if (commandName === 'censura') {
    if (!hasAdminPermission(member, guildConfig)) return interaction.reply({ content: '❌ Sem permissão.', ephemeral: true });
    const acao = options.getString('acao');
    const palavra = options.getString('palavra');
    const censuraData = getCensura();
    if (!censuraData[guild.id]) censuraData[guild.id] = [];

    if (acao === 'list') {
      const lista = censuraData[guild.id];
      if (lista.length === 0) return interaction.reply({ content: '🛡️ Nenhuma palavra censurada.', ephemeral: true });
      return interaction.reply({ content: `🛡️ **Censuradas:**\n${lista.join(', ')}`, ephemeral: true });
    }

    if (!palavra) return interaction.reply({ content: '❌ Indica a palavra.', ephemeral: true });

    if (acao === 'add') {
      if (!censuraData[guild.id].includes(palavra)) censuraData[guild.id].push(palavra);
      saveCensura(censuraData);
      return interaction.reply({ content: `✅ Palavra \`${palavra}\` censurada.`, ephemeral: true });
    }

    if (acao === 'remove') {
      censuraData[guild.id] = censuraData[guild.id].filter(p => p !== palavra);
      saveCensura(censuraData);
      return interaction.reply({ content: `✅ Palavra \`${palavra}\` removida da censura.`, ephemeral: true });
    }
  }
  else if (commandName.startsWith('set')) {
    if (!hasAdminPermission(member, guildConfig)) return interaction.reply({ content: '❌ Apenas administradores.', ephemeral: true });
    const chan = options.getChannel('canal');
    if (!config[guild.id]) config[guild.id] = {};
    
    if (commandName === 'setdenuncias') config[guild.id].denunciasChannel = chan.id;
    else if (commandName === 'setduvidas') config[guild.id].duvidasChannel = chan.id;
    else if (commandName === 'setlogs') config[guild.id].logsChannel = chan.id;
    else if (commandName === 'setpunicoes') config[guild.id].punicoesChannel = chan.id;
    else if (commandName === 'setsuggestion') config[guild.id].suggestionChannel = chan.id;
    else if/commandName === 'setwelcome' config[guild.id].welcomeChannel = chan.id;
    else if (commandName === 'setmsgdelete') config[guild.id].msgDeleteChannel = chan.id;
    
    saveConfig(config);
    await interaction.reply({ content: `✅ Canal <#${chan.id}> configurado com sucesso!`, ephemeral: true });
  }
}

async function handleGuildMemberAdd(member) {
  const fullConfig = getConfig();
  const conf = fullConfig[member.guild.id];
  if (!conf || !conf.welcomeChannel) return;
  const channel = member.guild.channels.cache.get(conf.welcomeChannel);
  if (channel) {
    const embed = new EmbedBuilder().setColor(0x00FF00).setTitle('👋 Novo Membro!').setDescription(`Bem-vindo(a), <@${member.id}>!`).setTimestamp();
    await channel.send({ embeds: [embed] });
  }
}

async function handleGuildMemberRemove(member) {
  const fullConfig = getConfig();
  const conf = fullConfig[member.guild.id];
  if (!conf || !conf.welcomeChannel) return;
  const channel = member.guild.channels.cache.get(conf.welcomeChannel);
  if (channel) {
    const embed = new EmbedBuilder().setColor(0xFF0000).setTitle('🚪 Membro Saiu').setDescription(`**${member.user.tag}** saiu.`).setTimestamp();
    await channel.send({ embeds: [embed] });
  }
}

async function handleGuildMemberUpdate(oldMember, newMember) {
  const fixedNick = permNicks.get(newMember.id);
  if (fixedNick && newMember.nickname !== fixedNick) {
    try { await newMember.setNickname(fixedNick, 'PermNick Active'); } catch (e) {}
  }
}

module.exports = { allSlashCommands, handleInteraction, handleMessage, handleMessageDelete, handleGuildMemberAdd, handleGuildMemberRemove, handleGuildMemberUpdate, sendTicketPanel };
EOF
