const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const fs = require('fs');

const ECONOMY_FILE = './economy.json';

function getEconomyData() {
  try {
    if (fs.existsSync(ECONOMY_FILE)) {
      return JSON.parse(fs.readFileSync(ECONOMY_FILE, 'utf8'));
    }
  } catch (e) {}
  return {};
}

function saveEconomyData(data) {
  try {
    fs.writeFileSync(ECONOMY_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {}
}

const economySlashCommands = [
  new SlashCommandBuilder().setName('saldo').setDescription('Consulta o teu saldo atual').addUserOption(o => o.setName('usuario').setDescription('Usuário').setRequired(false)),
  new SlashCommandBuilder().setName('daily').setDescription('Resgata a tua recompensa diária'),
  new SlashCommandBuilder().setName('trabalhar').setDescription('Trabalha para ganhar dinheiro'),
  new SlashCommandBuilder().setName('depositar').setDescription('Deposita dinheiro no banco').addIntegerOption(o => o.setName('quantia').setDescription('Quantidade').setRequired(true)),
  new SlashCommandBuilder().setName('sacar').setDescription('Saca dinheiro do banco').addIntegerOption(o => o.setName('quantia').setDescription('Quantidade').setRequired(true))
];

function processBalance(guildId, userId) {
  const data = getEconomyData();
  if (!data[guildId]) data[guildId] = {};
  if (!data[guildId][userId]) {
    data[guildId][userId] = { wallet: 100, bank: 500, lastDaily: 0, lastWork: 0 };
    saveEconomyData(data);
  }
  return data[guildId][userId];
}

async function handleEconomyMessage(message) {
  if (message.author.bot || !message.guild) return;
  const content = message.content.trim();
  if (!content.startsWith('?')) return;

  const args = content.slice(1).trim().split(/ +/);
  const command = args.shift().toLowerCase();
  const guildId = message.guild.id;
  const userId = message.author.id;

  try {
    const userEco = processBalance(guildId, userId);

    if (command === 'saldo' || command === 'carteira') {
      return message.reply(`💰 **Saldo de <@${userId}>**\n💵 Carteira: **$${userEco.wallet}**\n🏦 Banco: **$${userEco.bank}**`);
    }

    if (command === 'daily') {
      const agora = Date.now();
      if (agora - userEco.lastDaily < 86400000) {
        return message.reply('⏳ Já resgataste o teu daily hoje! Volta amanhã.');
      }
      userEco.wallet += 500;
      userEco.lastDaily = agora;
      const data = getEconomyData();
      data[guildId][userId] = userEco;
      saveEconomyData(data);
      return message.reply('🎁 Resgataste **$500** com sucesso no teu daily!');
    }

    if (command === 'trabalhar' || command === 'work') {
      const agora = Date.now();
      if (agora - userEco.lastWork < 3600000) {
        return message.reply('⏳ Estás cansado! Descansa um pouco antes de voltar a trabalhar.');
      }
      const ganho = Math.floor(Math.random() * 200) + 50;
      userEco.wallet += ganho;
      userEco.lastWork = agora;
      const data = getEconomyData();
      data[guildId][userId] = userEco;
      saveEconomyData(data);
      return message.reply(`🔨 Trabalhaste duramente e ganhaste **$${ganho}**!`);
    }

    if (command === 'depositar' || command === 'dep') {
      const qtd = parseInt(args[0]);
      if (!qtd || qtd <= 0) return message.reply('❌ Indica uma quantia válida para depositar.');
      if (userEco.wallet < qtd) return message.reply('❌ Não tens esse dinheiro todo na carteira.');
      userEco.wallet -= qtd;
      userEco.bank += qtd;
      const data = getEconomyData();
      data[guildId][userId] = userEco;
      saveEconomyData(data);
      return message.reply(`✅ Depositaste **$${qtd}** no banco com sucesso!`);
    }

    if (command === 'sacar' || command === 'withdraw') {
      const qtd = parseInt(args[0]);
      if (!qtd || qtd <= 0) return message.reply('❌ Indica uma quantia válida para sacar.');
      if (userEco.bank < qtd) return message.reply('❌ Não tens esse dinheiro todo no banco.');
      userEco.bank -= qtd;
      userEco.wallet += qtd;
      const data = getEconomyData();
      data[guildId][userId] = userEco;
      saveEconomyData(data);
      return message.reply(`✅ Sacaste **$${qtd}** do banco com sucesso!`);
    }
  } catch (err) {
    return message.reply('❌ Não foi possível executar este comando de economia via prefixo. Tente usar o comando em barra (`/`).');
  }
}

async function handleEconomyInteraction(interaction) {
  if (!interaction.isChatInputCommand()) return;
  const { commandName, options, guild, user } = interaction;
  const guildId = guild.id;
  const userId = user.id;

  try {
    const userEco = processBalance(guildId, userId);

    if (commandName === 'saldo') {
      return interaction.reply({ content: `💰 **Saldo de <@${userId}>**\n💵 Carteira: **$${userEco.wallet}**\n🏦 Banco: **$${userEco.bank}**`, ephemeral: true });
    }
    if (commandName === 'daily') {
      const agora = Date.now();
      if (agora - userEco.lastDaily < 86400000) {
        return interaction.reply({ content: '⏳ Já resgataste o teu daily hoje!', ephemeral: true });
      }
      userEco.wallet += 500;
      userEco.lastDaily = agora;
      const data = getEconomyData();
      data[guildId][userId] = userEco;
      saveEconomyData(data);
      return interaction.reply({ content: '🎁 Resgataste **$500** com sucesso!', ephemeral: true });
    }
    if (commandName === 'trabalhar') {
      const agora = Date.now();
      if (agora - userEco.lastWork < 3600000) {
        return interaction.reply({ content: '⏳ Estás cansado!', ephemeral: true });
      }
      const ganho = Math.floor(Math.random() * 200) + 50;
      userEco.wallet += ganho;
      userEco.lastWork = agora;
      const data = getEconomyData();
      data[guildId][userId] = userEco;
      saveEconomyData(data);
      return interaction.reply({ content: `🔨 Trabalhaste e ganhaste **$${ganho}**!` });
    }
    if (commandName === 'depositar') {
      const qtd = options.getInteger('quantia');
      if (userEco.wallet < qtd) return interaction.reply({ content: '❌ Dinheiro insuficiente na carteira.', ephemeral: true });
      userEco.wallet -= qtd;
      userEco.bank += qtd;
      const data = getEconomyData();
      data[guildId][userId] = userEco;
      saveEconomyData(data);
      return interaction.reply({ content: `✅ Depositaste **$${qtd}**!`, ephemeral: true });
    }
    if (commandName === 'sacar') {
      const qtd = options.getInteger('quantia');
      if (userEco.bank < qtd) return interaction.reply({ content: '❌ Dinheiro insuficiente no banco.', ephemeral: true });
      userEco.bank -= qtd;
      userEco.wallet += qtd;
      const data = getEconomyData();
      data[guildId][userId] = userEco;
      saveEconomyData(data);
      return interaction.reply({ content: `✅ Sacaste **$${qtd}**!`, ephemeral: true });
    }
  } catch (err) {
    if (interaction.deferred || interaction.replied) {
      return interaction.editReply({ content: '❌ Não foi possível executar este comando de economia por barra.' });
    } else {
      return interaction.reply({ content: '❌ Não foi possível executar este comando de economia por barra.', ephemeral: true });
    }
  }
}

module.exports = { economySlashCommands, handleEconomyMessage, handleEconomyInteraction };
