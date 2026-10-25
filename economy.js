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
  new SlashCommandBuilder().setName('saldo').setDescription('Consulta o teu saldo atual ou de outro usuário').addUserOption(o => o.setName('usuario').setDescription('Usuário').setRequired(false)),
  new SlashCommandBuilder().setName('patrimonio').setDescription('Mostra o patrimônio total (carteira + banco)'),
  new SlashCommandBuilder().setName('daily').setDescription('Resgata a tua recompensa diária'),
  new SlashCommandBuilder().setName('trabalhar').setDescription('Trabalha para ganhar dinheiro'),
  new SlashCommandBuilder().setName('minerar').setDescription('Vai minerar para tentar encontrar recursos e dinheiro'),
  new SlashCommandBuilder().setName('depositar').setDescription('Deposita dinheiro no banco').addIntegerOption(o => o.setName('quantia').setDescription('Quantidade').setRequired(true)),
  new SlashCommandBuilder().setName('sacar').setDescription('Saca dinheiro do banco').addIntegerOption(o => o.setName('quantia').setDescription('Quantidade').setRequired(true)),
  new SlashCommandBuilder().setName('transferir').setDescription('Transfere dinheiro para outro usuário (Pix)').addUserOption(o => o.setName('usuario').setDescription('Destinatário').setRequired(true)).addIntegerOption(o => o.setName('quantia').setDescription('Quantidade').setRequired(true)),
  new SlashCommandBuilder().setName('perfil').setDescription('Mostra o teu perfil financeiro'),
  new SlashCommandBuilder().setName('rank').setDescription('Mostra os mais ricos do servidor'),
  new SlashCommandBuilder().setName('extrato').setDescription('Mostra o resumo da tua conta'),
  new SlashCommandBuilder().setName('investir').setDescription('Aplica dinheiro em investimentos de risco').addIntegerOption(o => o.setName('quantia').setDescription('Quantidade').setRequired(true)),
  new SlashCommandBuilder().setName('loteria').setDescription('Compra um bilhete de loteria').addIntegerOption(o => o.setName('quantia').setDescription('Valor da aposta').setRequired(true)),
  new SlashCommandBuilder().setName('mercado').setDescription('Abre o painel da lojinha de itens e melhorias'),
  new SlashCommandBuilder().setName('apostar').setDescription('Aposta uma quantia no coinflip').addIntegerOption(o => o.setName('quantia').setDescription('Quantidade').setRequired(true)).addStringOption(o => o.setName('escolha').setDescription('Cara ou Coroa').setRequired(true).addChoices({name: 'Cara', value: 'cara'}, {name: 'Coroa', value: 'coroa'})),
  new SlashCommandBuilder().setName('slots').setDescription('Joga na máquina caça-níqueis').addIntegerOption(o => o.setName('quantia').setDescription('Quantidade').setRequired(true))
];

function processBalance(guildId, userId) {
  const data = getEconomyData();
  if (!data[guildId]) data[guildId] = {};
  if (!data[guildId][userId]) {
    data[guildId][userId] = { wallet: 100, bank: 500, lastDaily: 0, lastWork: 0, lastMine: 0, inventory: [] };
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
      const targetUser = message.mentions.users.first() || message.author;
      const targetEco = processBalance(guildId, targetUser.id);
      return message.reply(`💰 **Saldo de <@${targetUser.id}>**\n💵 Carteira: **$${targetEco.wallet}**\n🏦 Banco: **$${targetEco.bank}**`);
    }

    if (command === 'patrimonio') {
      const total = userEco.wallet + userEco.bank;
      return message.reply(`💎 O teu patrimônio total é de **$${total}** (Carteira: $${userEco.wallet} | Banco: $${userEco.bank})`);
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

    if (command === 'minerar' || command === 'mine') {
      const agora = Date.now();
      if (agora - userEco.lastMine < 1800000) {
        return message.reply('⏳ A tua picareta está a arrefecer! Aguarda um pouco.');
      }
      const ganho = Math.floor(Math.random() * 300);
      userEco.wallet += ganho;
      userEco.lastMine = agora;
      const data = getEconomyData();
      data[guildId][userId] = userEco;
      saveEconomyData(data);
      return message.reply(`⛏️ Foste minerar e encontraste minérios que renderam **$${ganho}**!`);
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

    if (command === 'sacar' || command === 'withdraw' || command === 'sac') {
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

    if (command === 'transferir' || command === 'pix') {
      const alvo = message.mentions.users.first();
      const qtd = parseInt(args[1]);
      if (!alvo || !qtd || qtd <= 0) return message.reply('❌ Uso correto: `?transferir @usuario <quantia>`');
      if (alvo.id === userId) return message.reply('❌ Não podes transferir dinheiro para ti mesmo.');
      if (userEco.wallet < qtd) return message.reply('❌ Não tens saldo suficiente na carteira.');

      const alvoEco = processBalance(guildId, alvo.id);
      userEco.wallet -= qtd;
      alvoEco.wallet += qtd;

      const data = getEconomyData();
      data[guildId][userId] = userEco;
      data[guildId][alvo.id] = alvoEco;
      saveEconomyData(data);
      return message.reply(`💸 Transferiste **$${qtd}** com sucesso para <@${alvo.id}>!`);
    }

    if (command === 'perfil') {
      const embed = new EmbedBuilder()
        .setColor(0x00AE86)
        .setTitle(`💳 Perfil de ${message.author.username}`)
        .addFields(
          { name: '💵 Carteira', value: `$${userEco.wallet}`, inline: true },
          { name: '🏦 Banco', value: `$${userEco.bank}`, inline: true },
          { name: '💎 Total', value: `$${userEco.wallet + userEco.bank}`, inline: true }
        );
      return message.reply({ embeds: [embed] });
    }

    if (command === 'rank' || command === 'top') {
      const data = getEconomyData();
      const guildData = data[guildId] || {};
      const sorted = Object.entries(guildData)
        .map(([id, eco]) => ({ id, total: eco.wallet + eco.bank }))
        .sort((a, b) => b.total - a.total)
        .slice(0, 10);

      if (sorted.length === 0) return message.reply('📊 Ainda não há dados de economia.');
      const desc = sorted.map((u, i) => `${i + 1}. <@${u.id}> — **$${u.total}**`).join('\n');
      const embed = new EmbedBuilder().setColor(0xF1C40F).setTitle('🏆 Top 10 Mais Ricos').setDescription(desc);
      return message.reply({ embeds: [embed] });
    }

    if (command === 'extrato') {
      return message.reply(`📄 **Extrato da Conta**\nCarteira: $${userEco.wallet}\nBanco: $${userEco.bank}\nTotal: $${userEco.wallet + userEco.bank}`);
    }

    if (command === 'investir') {
      const qtd = parseInt(args[0]);
      if (!qtd || qtd <= 0 || userEco.wallet < qtd) return message.reply('❌ Quantia inválida ou saldo insuficiente.');
      userEco.wallet -= qtd;
      const lucro = Math.random() > 0.4 ? Math.floor(qtd * 1.5) : 0;
      userEco.wallet += lucro;
      const data = getEconomyData();
      data[guildId][userId] = userEco;
      saveEconomyData(data);
      if (lucro > 0) return message.reply(`📈 O teu investimento rendeu frutos! Lucraste e ficaste com **$${lucro}** de retorno.`);
      return message.reply(`📉 O investimento correu mal e perdeste os **$${qtd}** investidos.`);
    }

    if (command === 'loteria') {
      const qtd = parseInt(args[0]);
      if (!qtd || qtd <= 0 || userEco.wallet < qtd) return message.reply('❌ Quantia inválida.');
      userEco.wallet -= qtd;
      const ganhou = Math.random() < 0.15;
      if (ganhou) {
        const premio = qtd * 5;
        userEco.wallet += premio;
        const data = getEconomyData();
        data[guildId][userId] = userEco;
        saveEconomyData(data);
        return message.reply(`🎉 PARABÉNS! Acertaste na loteria e ganhaste **$${premio}**!`);
      }
      const data = getEconomyData();
      data[guildId][userId] = userEco;
      saveEconomyData(data);
      return message.reply(`😢 Não foi desta vez! Perdeste os **$${qtd}** do bilhete.`);
    }

    if (command === 'mercado' || command === 'shop') {
      const embed = new EmbedBuilder()
        .setColor(0x3498DB)
        .setTitle('🛒 Mercado & Lojinha do Servidor')
        .setDescription('Escolha um dos itens abaixo para comprar utilizando o seu saldo da carteira:')
        .addFields(
          { name: '🎟️ VIP Semanal', value: 'Preço: **$5000**', inline: true },
          { name: '⛏️ Picareta de Ouro', value: 'Preço: **$2500**', inline: true }
        )
        .setFooter({ text: 'Sistema de Economia • Zapher' });
      return message.reply({ embeds: [embed] });
    }

    if (command === 'apostar' || command === 'coinflip') {
      const qtd = parseInt(args[0]);
      const escolha = args[1]?.toLowerCase();
      if (!qtd || qtd <= 0 || userEco.wallet < qtd || !['cara', 'coroa'].includes(escolha)) {
        return message.reply('❌ Uso correto: `?apostar <quantia> <cara/coroa>`');
      }
      userEco.wallet -= qtd;
      const resultado = Math.random() < 0.5 ? 'cara' : 'coroa';
      if (escolha === resultado) {
        userEco.wallet += qtd * 2;
        const data = getEconomyData();
        data[guildId][userId] = userEco;
        saveEconomyData(data);
        return message.reply(`🪙 Deu **${resultado}**! Ganhaste a aposta e levaste **$${qtd * 2}**!`);
      }
      const data = getEconomyData();
      data[guildId][userId] = userEco;
      saveEconomyData(data);
      return message.reply(`🪙 Deu **${resultado}**! Infelizmente perdeste os **$${qtd}**.`);
    }

    if (command === 'slots') {
      const qtd = parseInt(args[0]);
      if (!qtd || qtd <= 0 || userEco.wallet < qtd) return message.reply('❌ Quantia inválida.');
      userEco.wallet -= qtd;
      const emojis = ['🍎', '🍋', '🍒', '💎', '7️⃣'];
      const r1 = emojis[Math.floor(Math.random() * emojis.length)];
      const r2 = emojis[Math.floor(Math.random() * emojis.length)];
      const r3 = emojis[Math.floor(Math.random() * emojis.length)];
      
      if (r1 === r2 && r2 === r3) {
        const premio = qtd * 10;
        userEco.wallet += premio;
        const data = getEconomyData();
        data[guildId][userId] = userEco;
        saveEconomyData(data);
        return message.reply(`🎰 | ${r1} | ${r2} | ${r3} |\n🎉 Incrível! Três iguais! Ganhaste **$${premio}**!`);
      }
      const data = getEconomyData();
      data[guildId][userId] = userEco;
      saveEconomyData(data);
      return message.reply(`🎰 | ${r1} | ${r2} | ${r3} |\n❌ Não foi desta vez, perdeste **$${qtd}**.`);
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
      const targetUser = options.getUser('usuario') || user;
      const targetEco = processBalance(guildId, targetUser.id);
      return interaction.reply({ content: `💰 **Saldo de <@${targetUser.id}>**\n💵 Carteira: **$${targetEco.wallet}**\n🏦 Banco: **$${targetEco.bank}**`, ephemeral: true });
    }
    if (commandName === 'patrimonio') {
      const total = userEco.wallet + userEco.bank;
      return interaction.reply({ content: `💎 O teu patrimônio total é de **$${total}**`, ephemeral: true });
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
    if (commandName === 'minerar') {
      const agora = Date.now();
      if (agora - userEco.lastMine < 1800000) {
        return interaction.reply({ content: '⏳ A picareta está a arrefecer!', ephemeral: true });
      }
      const ganho = Math.floor(Math.random() * 300);
      userEco.wallet += ganho;
      userEco.lastMine = agora;
      const data = getEconomyData();
      data[guildId][userId] = userEco;
      saveEconomyData(data);
      return interaction.reply({ content: `⛏️ Mineraste e ganhaste **$${ganho}**!` });
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
    if (commandName === 'transferir') {
      const alvo = options.getUser('usuario');
      const qtd = options.getInteger('quantia');
      if (alvo.id === userId) return interaction.reply({ content: '❌ Não podes transferir para ti mesmo.', ephemeral: true });
      if (userEco.wallet < qtd) return interaction.reply({ content: '❌ Saldo insuficiente.', ephemeral: true });
      const alvoEco = processBalance(guildId, alvo.id);
      userEco.wallet -= qtd;
      alvoEco.wallet += qtd;
      const data = getEconomyData();
      data[guildId][userId] = userEco;
      data[guildId][alvo.id] = alvoEco;
      saveEconomyData(data);
      return interaction.reply({ content: `💸 Transferiste **$${qtd}** para <@${alvo.id}>!` });
    }
    if (commandName === 'perfil') {
      const embed = new EmbedBuilder().setColor(0x00AE86).setTitle(`💳 Perfil`).addFields({ name: 'Carteira', value: `$${userEco.wallet}`, inline: true }, { name: 'Banco', value: `$${userEco.bank}`, inline: true });
      return interaction.reply({ embeds: [embed], ephemeral: true });
    }
    if (commandName === 'rank') {
      const data = getEconomyData();
      const guildData = data[guildId] || {};
      const sorted = Object.entries(guildData).map(([id, eco]) => ({ id, total: eco.wallet + eco.bank })).sort((a, b) => b.total - a.total).slice(0, 10);
      const desc = sorted.map((u, i) => `${i + 1}. <@${u.id}> — **$${u.total}**`).join('\n');
      const embed = new EmbedBuilder().setColor(0xF1C40F).setTitle('🏆 Top 10 Mais Ricos').setDescription(desc || 'Vazio');
      return interaction.reply({ embeds: [embed] });
    }
    if (commandName === 'extrato') {
      return interaction.reply({ content: `📄 Carteira: $${userEco.wallet} | Banco: $${userEco.bank}`, ephemeral: true });
    }
    if (commandName === 'investir') {
      const qtd = options.getInteger('quantia');
      if (userEco.wallet < qtd) return interaction.reply({ content: '❌ Saldo insuficiente.', ephemeral: true });
      userEco.wallet -= qtd;
      const lucro = Math.random() > 0.4 ? Math.floor(qtd * 1.5) : 0;
      userEco.wallet += lucro;
      const data = getEconomyData();
      data[guildId][userId] = userEco;
      saveEconomyData(data);
      return interaction.reply({ content: lucro > 0 ? `📈 Lucraste e ficaste com **$${lucro}**!` : `📉 O investimento falhou.` });
    }
    if (commandName === 'loteria') {
      const qtd = options.getInteger('quantia');
      if (userEco.wallet < qtd) return interaction.reply({ content: '❌ Saldo insuficiente.', ephemeral: true });
      userEco.wallet -= qtd;
      const ganhou = Math.random() < 0.15;
      if (ganhou) {
        userEco.wallet += qtd * 5;
        const data = getEconomyData();
        data[guildId][userId] = userEco;
        saveEconomyData(data);
        return interaction.reply({ content: `🎉 Ganhaste a loteria!` });
      }
      const data = getEconomyData();
      data[guildId][userId] = userEco;
      saveEconomyData(data);
      return interaction.reply({ content: `😢 Perdeste na loteria.` });
    }
    if (commandName === 'mercado') {
      const embed = new EmbedBuilder()
        .setColor(0x3498DB)
        .setTitle('🛒 Mercado & Lojinha do Servidor')
        .setDescription('Painel de itens disponíveis para compra no servidor:')
        .addFields(
          { name: '🎟️ VIP Semanal', value: 'Preço: **$5000**', inline: true },
          { name: '⛏️ Picareta de Ouro', value: 'Preço: **$2500**', inline: true }
        );
      return interaction.reply({ embeds: [embed], ephemeral: true });
    }
    if (commandName === 'apostar') {
      const qtd = options.getInteger('quantia');
      const escolha = options.getString('escolha');
      if (userEco.wallet < qtd) return interaction.reply({ content: '❌ Saldo insuficiente.', ephemeral: true });
      userEco.wallet -= qtd;
      const resultado = Math.random() < 0.5 ? 'cara' : 'coroa';
      if (escolha === resultado) {
        userEco.wallet += qtd * 2;
        const data = getEconomyData();
        data[guildId][userId] = userEco;
        saveEconomyData(data);
        return interaction.reply({ content: `🪙 Deu **${resultado}**! Ganhaste!` });
      }
      const data = getEconomyData();
      data[guildId][userId] = userEco;
      saveEconomyData(data);
      return interaction.reply({ content: `🪙 Deu **${resultado}**! Perdeste.` });
    }
    if (commandName === 'slots') {
      const qtd = options.getInteger('quantia');
      if (userEco.wallet < qtd) return interaction.reply({ content: '❌ Saldo insuficiente.', ephemeral: true });
      userEco.wallet -= qtd;
      const emojis = ['🍎', '🍋', '🍒', '💎', '7️⃣'];
      const r1 = emojis[Math.floor(Math.random() * emojis.length)];
      const r2 = emojis[Math.floor(Math.random() * emojis.length)];
      const r3 = emojis[Math.floor(Math.random() * emojis.length)];
      if (r1 === r2 && r2 === r3) {
        userEco.wallet += qtd * 10;
        const data = getEconomyData();
        data[guildId][userId] = userEco;
        saveEconomyData(data);
        return interaction.reply({ content: `🎰 | ${r1} | ${r2} | ${r3} |\n🎉 Três iguais! Ganhaste!` });
      }
      const data = getEconomyData();
      data[guildId][userId] = userEco;
      saveEconomyData(data);
      return interaction.reply({ content: `🎰 | ${r1} | ${r2} | ${r3} |\n❌ Não foi desta vez.` });
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
