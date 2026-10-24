cat << 'EOF' > economy.js
const { EmbedBuilder, SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const fs = require('fs');

const ECO_FILE = './economy_data.json';
const CREATOR_ID = 'O_TEU_ID_DO_DISCORD_AQUI'; // Podes colocar o teu ID de dono aqui

function getEcoData() {
  try {
    if (fs.existsSync(ECO_FILE)) {
      return JSON.parse(fs.readFileSync(ECO_FILE, 'utf8'));
    }
  } catch (e) {}
  return {};
}

function saveEcoData(data) {
  try {
    fs.writeFileSync(ECO_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {}
}

const economySlashCommands = [
  new SlashCommandBuilder().setName('saldo').setDescription('Consulta o teu património e extrato').addUserOption(o => o.setName('usuario').setDescription('Membro').setRequired(false)),
  new SlashCommandBuilder().setName('patrimonio').setDescription('Consulta o teu património e saldo total'),
  new SlashCommandBuilder().setName('depositar').setDescription('Guarda dinheiro no banco').addIntegerOption(o => o.setName('valor').setDescription('Quantia').setRequired(true)),
  new SlashCommandBuilder().setName('sacar').setDescription('Saca dinheiro do banco').addIntegerOption(o => o.setName('valor').setDescription('Quantia').setRequired(true)),
  new SlashCommandBuilder().setName('transferir').setDescription('Faz Pix/Transferência para outro membro').addUserOption(o => o.setName('usuario').setDescription('Destinatário').setRequired(true)).addIntegerOption(o => o.setName('valor').setDescription('Valor').setRequired(true)),
  new SlashCommandBuilder().setName('perfil').setDescription('Mostra o teu cartão de cidadão e inventário'),
  new SlashCommandBuilder().setName('rank').setDescription('Mostra o top 10 mais ricos do servidor'),
  new SlashCommandBuilder().setName('extrato').setDescription('Mostra as últimas movimentações da tua conta'),
  
  new SlashCommandBuilder().setName('daily').setDescription('Resgata o teu prémio diário'),
  new SlashCommandBuilder().setName('weekly').setDescription('Resgata o teu bónus semanal'),
  new SlashCommandBuilder().setName('trabalhar').setDescription('Trabalha para ganhar dinheiro e subir de nível'),
  new SlashCommandBuilder().setName('minerar').setDescription('Vai às minas procurar minérios valiosos'),
  new SlashCommandBuilder().setName('pescar').setDescription('Vai pescar no rio'),
  new SlashCommandBuilder().setName('cacar').setDescription('Vai caçar na floresta'),
  new SlashCommandBuilder().setName('farmar').setDescription('Cultiva a terra para colher lucros'),
  
  new SlashCommandBuilder().setName('roubar').setDescription('Tenta roubar outro membro').addUserOption(o => o.setName('usuario').setDescription('Alvo').setRequired(true)),
  new SlashCommandBuilder().setName('crime').setDescription('Comete um crime arriscado na cidade'),
  new SlashCommandBuilder().setName('apostar').setDescription('Aposta dinheiro num jogo rápido de sorte').addIntegerOption(o => o.setName('valor').setDescription('Valor').setRequired(true)),
  new SlashCommandBuilder().setName('coinflip').setDescription('Joga cara ou coroa apostando').addStringOption(o => o.setName('escolha').setDescription('cara ou coroa').setRequired(true).addChoices({name: 'Cara', value: 'cara'}, {name: 'Coroa', value: 'coroa'})).addIntegerOption(o => o.setName('valor').setDescription('Valor').setRequired(true)),
  new SlashCommandBuilder().setName('slots').setDescription('Joga na máquina caça-níqueis').addIntegerOption(o => o.setName('valor').setDescription('Valor').setRequired(true)),
  new SlashCommandBuilder().setName('roleta').setDescription('Aposta na roleta da sorte').addStringOption(o => o.setName('cor').setDescription('vermelho, preto ou verde').setRequired(true).addChoices({name: 'Vermelho', value: 'vermelho'}, {name: 'Preto', value: 'preto'}, {name: 'Verde', value: 'verde'})).addIntegerOption(o => o.setName('valor').setDescription('Valor').setRequired(true)),
  
  new SlashCommandBuilder().setName('loja').setDescription('Mostra a lojinha do servidor'),
  new SlashCommandBuilder().setName('mercado').setDescription('Envia o painel interativo fixo da lojinha e mercado no canal'),
  new SlashCommandBuilder().setName('painel-economia').setDescription('Envia o painel interativo fixo da lojinha e mercado no canal'),
  new SlashCommandBuilder().setName('inventario').setDescription('Mostra os itens que tens guardados'),
  
  new SlashCommandBuilder().setName('investir').setDescription('Aplica dinheiro em fundos de investimento variados').addStringOption(o => o.setName('opcao').setDescription('Tipo de investimento').setRequired(true).addChoices(
    { name: 'Criptomoedas (Alto Risco) - R$ 50.000', value: 'crypto' },
    { name: 'Tesouro Direto (Baixo Risco) - R$ 20.000', value: 'tesouro' },
    { name: 'Ações da Bolsa (Médio Risco) - R$ 35.000', value: 'acoes' }
  )),
  new SlashCommandBuilder().setName('emprestimo').setDescription('Pede um empréstimo ao banco').addIntegerOption(o => o.setName('valor').setDescription('Valor').setRequired(true)),
  new SlashCommandBuilder().setName('loteria').setDescription('Compra um bilhete de loteria por R$ 5.000'),
  
  new SlashCommandBuilder().setName('addmoney').setDescription('[DONO] Adiciona dinheiro a um usuário').addUserOption(o => o.setName('usuario').setDescription('Alvo').setRequired(true)).addIntegerOption(o => o.setName('valor').setDescription('Valor').setRequired(true)),
  new SlashCommandBuilder().setName('removemoney').setDescription('[DONO] Remove dinheiro de um usuário').addUserOption(o => o.setName('usuario').setDescription('Alvo').setRequired(true)).addIntegerOption(o => o.setName('valor').setDescription('Valor').setRequired(true))
];

function getUserAccount(data, userId) {
  if (!data[userId]) {
    data[userId] = { 
      wallet: 150000, 
      bank: 500000, 
      jobLevel: 1, 
      lastDaily: 0, 
      lastWeekly: 0, 
      lastWork: 0, 
      inventory: [],
      extrato: [],
      investimento: 0
    };
  }
  return data[userId];
}

function addExtrato(userAcc, texto) {
  if (!userAcc.extrato) userAcc.extrato = [];
  userAcc.extrato.unshift(`[${new Date().toLocaleDateString()}] ${texto}`);
  if (userAcc.extrato.length > 10) userAcc.extrato.pop();
}

function getMarketPanelEmbed() {
  return new EmbedBuilder()
    .setColor(0x900C3F)
    .setTitle('💰 Mercado & Lojinha Interativa Completa')
    .setDescription(
      'Escolha uma categoria abaixo. O menu vai abrir opções com botões individuais.\n' +
      'Se tiveres saldo suficiente na carteira, o item vai direto para o teu inventário!\n\n' +
      '**🛒 Categorias Disponíveis:**\n' +
      '• **🚗 Veículos** (Motos, Carros Desportivos, Hipercarros)\n' +
      '• **🏡 Casas** (Apartamentos, Mansões, Ilhas)\n' +
      '• **📱 Celulares** (Smartphones de última geração)\n' +
      '• **👑 Cargos** (VIPs exclusivos por 30 dias)\n' +
      '• **⚡ Upgrades** (Multiplicadores de ganho e sorte)\n' +
      '• **🔫 Armamento** (Kits táticos para assaltos)\n' +
      '• **💳 Conta** (Consulta rápida de saldo, poupança e daily)'
    )
    .setFooter({ text: 'Zunder Economy System • Diversidade Máxima' });
}

function getMarketPanelButtons() {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('eco_cat_veiculos').setLabel('🚗 Veículos').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('eco_cat_casas').setLabel('🏡 Casas').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('eco_cat_celulares').setLabel('📱 Celulares').setStyle(ButtonStyle.Primary)
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('eco_cat_cargos').setLabel('👑 Cargos').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('eco_cat_upgrades').setLabel('⚡ Upgrades').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('eco_cat_armamento').setLabel('🔫 Armamento').setStyle(ButtonStyle.Success)
  );

  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('eco_btn_saldo').setLabel('💳 Meu Saldo').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('eco_btn_poupanca').setLabel('🏦 Poupança').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('eco_btn_daily').setLabel('🎁 Daily').setStyle(ButtonStyle.Secondary)
  );

  return [row1, row2, row3];
}

async function handleEconomyInteraction(interaction) {
  const data = getEcoData();
  const agora = Date.now();

  // Tratamento de Interações de Botões do Mercado
  if (interaction.isButton() && interaction.customId.startsWith('eco_')) {
    const userAcc = getUserAccount(data, interaction.user.id);
    const customId = interaction.customId;

    // Abertura de Categorias (Menus em Cascata)
    if (customId === 'eco_cat_veiculos') {
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('buy_Moto Esportiva_350000').setLabel('Moto (R$ 350k)').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('buy_Carro Desportivo_1200000').setLabel('Desportivo (R$ 1.2M)').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('buy_Supercarro Luxo_4500000').setLabel('Supercarro (R$ 4.5M)').setStyle(ButtonStyle.Primary)
      );
      return interaction.reply({ content: '🚗 **Escolhe o teu veículo de sonho:**', components: [row], ephemeral: true });
    }

    if (customId === 'eco_cat_casas') {
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('buy_Kitnet Central_250000').setLabel('Kitnet (R$ 250k)').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('buy_Apartamento de Luxo_1800000').setLabel('Apartamento (R$ 1.8M)').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('buy_Mansao com Piscina_12000000').setLabel('Mansão (R$ 12M)').setStyle(ButtonStyle.Primary)
      );
      return interaction.reply({ content: '🏡 **Escolhe o teu imóvel:**', components: [row], ephemeral: true });
    }

    if (customId === 'eco_cat_celulares') {
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('buy_Smartphone Basico_15000').setLabel('Básico (R$ 15k)').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('buy_Smartphone Pro Max_85000').setLabel('Pro Max (R$ 85k)').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('buy_Edicao Limitada Ouro_300000').setLabel('Gold (R$ 300k)').setStyle(ButtonStyle.Primary)
      );
      return interaction.reply({ content: '📱 **Escolhe o teu telemóvel:**', components: [row], ephemeral: true });
    }

    if (customId === 'eco_cat_cargos') {
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('buy_VIP Bronze (30d)_500000').setLabel('VIP Bronze (R$ 500k)').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('buy_VIP Prata (30d)_1500000').setLabel('VIP Prata (R$ 1.5M)').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('buy_VIP Ouro (30d)_5000000').setLabel('VIP Ouro (R$ 5M)').setStyle(ButtonStyle.Success)
      );
      return interaction.reply({ content: '👑 **Escolhe o teu cargo VIP:**', components: [row], ephemeral: true });
    }

    if (customId === 'eco_cat_upgrades') {
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('buy_Upgrade Renda Nv2_200000').setLabel('Renda Nv2 (R$ 200k)').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('buy_Kit Fuga Rapida_450000').setLabel('Kit Fuga (R$ 450k)').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('buy_Amuleto da Sorte_800000').setLabel('Sorte (R$ 800k)').setStyle(ButtonStyle.Success)
      );
      return interaction.reply({ content: '⚡ **Escolhe o teu upgrade:**', components: [row], ephemeral: true });
    }

    if (customId === 'eco_cat_armamento') {
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('buy_Kit Tatico Leve_150000').setLabel('Kit Leve (R$ 150k)').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('buy_Kit Tatico Pesado_600000').setLabel('Kit Pesado (R$ 600k)').setStyle(ButtonStyle.Danger)
      );
      return interaction.reply({ content: '🔫 **Escolhe o teu armamento:**', components: [row], ephemeral: true });
    }

    // Botões de Ação de Compra Direta por Clique
    if (customId.startsWith('buy_')) {
      const partes = customId.split('_');
      const nomeItem = partes[1];
      const precoItem = parseInt(partes[2]);

      if (userAcc.wallet < precoItem) {
        return interaction.reply({ content: `❌ Dinheiro insuficiente na carteira! Precisas de **R$ ${precoItem.toLocaleString()}**, mas só tens **R$ ${userAcc.wallet.toLocaleString()}**.`, ephemeral: true });
      }

      userAcc.wallet -= precoItem;
      userAcc.inventory.push(nomeItem);
      addExtrato(userAcc, `Comprou ${nomeItem} por R$ ${precoItem.toLocaleString()}`);
      saveEcoData(data);

      return interaction.reply({ content: `✅ **Compra efetuada com sucesso!** Adquiriste **${nomeItem}** por **R$ ${precoItem.toLocaleString()}**. Consulta o teu inventário com \`/perfil\`.`, ephemeral: true });
    }

    // Atalhos Rápidos do Painel
    if (customId === 'eco_btn_saldo') {
      const total = userAcc.wallet + userAcc.bank;
      return interaction.reply({ content: `💳 **Saldo:** Carteira: R$ ${userAcc.wallet.toLocaleString()} | Banco: R$ ${userAcc.bank.toLocaleString()} | Total: R$ ${total.toLocaleString()}`, ephemeral: true });
    }
    if (customId === 'eco_btn_poupanca') {
      return interaction.reply({ content: `🏦 **Poupança:** Tens R$ ${userAcc.bank.toLocaleString()} guardados no banco.`, ephemeral: true });
    }
    if (customId === 'eco_btn_daily') {
      const umDia = 24 * 60 * 60 * 1000;
      if (agora - userAcc.lastDaily < umDia) return interaction.reply({ content: '⏳ Já resgataste o teu daily hoje!', ephemeral: true });
      userAcc.wallet += 10000;
      userAcc.lastDaily = agora;
      addExtrato(userAcc, 'Resgatou o Daily via Painel (R$ 10.000)');
      saveEcoData(data);
      return interaction.reply({ content: '🎁 Resgataste o teu daily de **R$ 10.000**!', ephemeral: true });
    }
  }

  if (!interaction.isChatInputCommand()) return;

  const { commandName, options, user } = interaction;
  const userAcc = getUserAccount(data, user.id);

  if (commandName === 'mercado' || commandName === 'painel-economia' || commandName === 'loja') {
    return interaction.reply({ embeds: [getMarketPanelEmbed()], components: getMarketPanelButtons() });
  }

  if (commandName === 'addmoney' || commandName === 'removemoney') {
    if (user.id !== CREATOR_ID && !interaction.member.permissions.has('Administrator')) {
      return interaction.reply({ content: '❌ Apenas o criador do bot ou administradores podem usar este comando.', ephemeral: true });
    }
    const alvo = options.getUser('usuario');
    const valor = options.getInteger('valor');
    const alvoAcc = getUserAccount(data, alvo.id);

    if (commandName === 'addmoney') {
      alvoAcc.wallet += valor;
      addExtrato(alvoAcc, `Recebeu R$ ${valor.toLocaleString()} de um Admin.`);
      saveEcoData(data);
      return interaction.reply({ content: `✅ Adicionados **R$ ${valor.toLocaleString()}** à carteira de <@${alvo.id}>.` });
    } else {
      alvoAcc.wallet = Math.max(0, alvoAcc.wallet - valor);
      addExtrato(alvoAcc, `Foram removidos R$ ${valor.toLocaleString()} por um Admin.`);
      saveEcoData(data);
      return interaction.reply({ content: `✅ Removidos **R$ ${valor.toLocaleString()}** da carteira de <@${alvo.id}>.` });
    }
  }

  if (commandName === 'saldo' || commandName === 'patrimonio') {
    const alvo = options.getUser('usuario') || user;
    const alvoAcc = getUserAccount(data, alvo.id);
    const total = alvoAcc.wallet + alvoAcc.bank;
    const embed = new EmbedBuilder()
      .setColor(0x2ECC71)
      .setTitle(`💳 Património de ${alvo.tag}`)
      .addFields(
        { name: '💵 Carteira', value: `R$ ${alvoAcc.wallet.toLocaleString()}`, inline: true },
        { name: '🏦 Banco', value: `R$ ${alvoAcc.bank.toLocaleString()}`, inline: true },
        { name: '💎 Total', value: `R$ ${total.toLocaleString()}`, inline: false }
      );
    return interaction.reply({ embeds: [embed] });
  }

  if (commandName === 'depositar') {
    const valor = options.getInteger('valor');
    if (valor <= 0 || valor > userAcc.wallet) return interaction.reply({ content: '❌ Valor inválido.', ephemeral: true });
    userAcc.wallet -= valor;
    userAcc.bank += valor;
    addExtrato(userAcc, `Depositou R$ ${valor.toLocaleString()} no banco.`);
    saveEcoData(data);
    return interaction.reply({ content: `✅ Depositaste **R$ ${valor.toLocaleString()}** no banco.` });
  }

  if (commandName === 'sacar') {
    const valor = options.getInteger('valor');
    if (valor <= 0 || valor > userAcc.bank) return interaction.reply({ content: '❌ Valor inválido.', ephemeral: true });
    userAcc.bank -= valor;
    userAcc.wallet += valor;
    addExtrato(userAcc, `Sacou R$ ${valor.toLocaleString()} do banco.`);
    saveEcoData(data);
    return interaction.reply({ content: `✅ Sacaste **R$ ${valor.toLocaleString()}** do banco.` });
  }

  if (commandName === 'transferir') {
    const alvo = options.getUser('usuario');
    const valor = options.getInteger('valor');
    if (alvo.id === user.id) return interaction.reply({ content: '❌ Não podes transferir para ti próprio.', ephemeral: true });
    if (valor <= 0 || valor > userAcc.wallet) return interaction.reply({ content: '❌ Saldo insuficiente na carteira.', ephemeral: true });

    const alvoAcc = getUserAccount(data, alvo.id);
    userAcc.wallet -= valor;
    alvoAcc.wallet += valor;
    addExtrato(userAcc, `Pix enviado de R$ ${valor.toLocaleString()} para ${alvo.tag}`);
    addExtrato(alvoAcc, `Pix recebido de R$ ${valor.toLocaleString()} de ${user.tag}`);
    saveEcoData(data);
    return interaction.reply({ content: `💸 Pix efetuado! Transferiste **R$ ${valor.toLocaleString()}** para <@${alvo.id}>.` });
  }

  if (commandName === 'perfil') {
    const embed = new EmbedBuilder()
      .setColor(0x9B59B6)
      .setTitle(`👤 Perfil — ${user.tag}`)
      .addFields(
        { name: '📈 Nível', value: `Nível ${userAcc.jobLevel}`, inline: true },
        { name: '🎒 Inventário & Bens', value: `${userAcc.inventory.length ? userAcc.inventory.join(', ') : 'Nenhum bem adquirido'}`, inline: false }
      );
    return interaction.reply({ embeds: [embed] });
  }

  if (commandName === 'rank') {
    const entries = Object.entries(data);
    if (entries.length === 0) return interaction.reply({ content: '📊 Sem registros.', ephemeral: true });
    const sorted = entries.map(([id, acc]) => ({ id, total: (acc.wallet || 0) + (acc.bank || 0) })).sort((a, b) => b.total - a.total).slice(0, 10);
    let desc = '';
    sorted.forEach((item, index) => {
      const med = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `**#${index + 1}**`;
      desc += `${med} <@${item.id}> — **R$ ${item.total.toLocaleString()}**\n`;
    });
    return interaction.reply({ embeds: [new EmbedBuilder().setColor(0xF1C40F).setTitle('🏆 Top 10 Mais Ricos').setDescription(desc)] });
  }

  if (commandName === 'extrato') {
    const hist = userAcc.extrato && userAcc.extrato.length ? userAcc.extrato.join('\n') : 'Sem movimentações.';
    return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x3498DB).setTitle('📄 Extrato').setDescription(hist)], ephemeral: true });
  }

  if (commandName === 'daily') {
    const umDia = 24 * 60 * 60 * 1000;
    if (agora - userAcc.lastDaily < umDia) return interaction.reply({ content: '⏳ Já resgataste o teu daily hoje!', ephemeral: true });
    userAcc.wallet += 10000;
    userAcc.lastDaily = agora;
    addExtrato(userAcc, 'Resgatou o Daily (R$ 10.000)');
    saveEcoData(data);
    return interaction.reply({ content: '🎁 Resgataste o teu daily de **R$ 10.000**!' });
  }

  if (commandName === 'trabalhar') {
    const cd = 2 * 60 * 1000;
    if (agora - userAcc.lastWork < cd) return interaction.reply({ content: '⏳ Descansa um pouco.', ephemeral: true });
    const ganho = Math.floor(Math.random() * 6000) + 4000;
    userAcc.wallet += ganho;
    userAcc.lastWork = agora;
    if (Math.random() > 0.75) userAcc.jobLevel += 1;
    saveEcoData(data);
    return interaction.reply({ content: `💼 Trabalhaste afincadamente e ganhaste **R$ ${ganho.toLocaleString()}**!` });
  }

  if (commandName === 'minerar' || commandName === 'pescar' || commandName === 'cacar' || commandName === 'farmar') {
    const ganho = Math.floor(Math.random() * 8000) + 3000;
    userAcc.wallet += ganho;
    saveEcoData(data);
    return interaction.reply({ content: `✅ Foste ${commandName} e obtiveste um lucro de **R$ ${ganho.toLocaleString()}**!` });
  }

  if (commandName === 'apostar' || commandName === 'slots') {
    const valor = options.getInteger('valor');
    if (valor <= 0 || valor > userAcc.wallet) return interaction.reply({ content: '❌ Saldo insuficiente na carteira.', ephemeral: true });
    if (Math.random() < 0.48) {
      userAcc.wallet += valor;
      saveEcoData(data);
      return interaction.reply({ content: `🎲 **Vitória!** A sorte esteve do teu lado e ganhaste **R$ ${valor.toLocaleString()}**.` });
    } else {
      userAcc.wallet -= valor;
      saveEcoData(data);
      return interaction.reply({ content: `🎲 **Derrota!** A banca recolheu os teus **R$ ${valor.toLocaleString()}**.` });
    }
  }

  if (commandName === 'investir') {
    const opcao = options.getString('opcao');
    let custo = opcao === 'crypto' ? 50000 : opcao === 'acoes' ? 35000 : 20000;
    if (userAcc.wallet < custo) return interaction.reply({ content: `❌ Não tens dinheiro suficiente na carteira para este investimento (Custo: R$ ${custo.toLocaleString()}).`, ephemeral: true });

    userAcc.wallet -= custo;
    const multiplicador = Math.random() < 0.5 ? 1.8 : 0.6; // Risco real
    const retorno = Math.floor(custo * multiplicador);
    userAcc.wallet += retorno;
    addExtrato(userAcc, `Investiu R$ ${custo.toLocaleString()} e obteve retorno de R$ ${retorno.toLocaleString()}`);
    saveEcoData(data);

    const lucroPreju = retorno >= custo;
    return interaction.reply({ content: `📈 **Investimento Concluído!** Aplicaste R$ ${custo.toLocaleString()}. O retorno foi de **R$ ${retorno.toLocaleString()}** (${lucroPreju ? '🎉 Lucro!' : '📉 Prejuízo'}).` });
  }

  if (commandName === 'loteria') {
    const preco = 5000;
    if (userAcc.wallet < preco) return interaction.reply({ content: '❌ Cada bilhete de loteria custa R$ 5.000.', ephemeral: true });
    userAcc.wallet -= preco;
    
    if (Math.random() < 0.08) { // 8% de chance de ganhar o prêmio grosso
      const premioLoteria = 250000;
      userAcc.wallet += premioLoteria;
      addExtrato(userAcc, `Ganhou na Loteria (R$ ${premioLoteria.toLocaleString()})`);
      saveEcoData(data);
      return interaction.reply({ content: `🎰 **JACKPOT! ACERTASTE NA LOTERIA!** Levaste o prémio máximo de **R$ ${premioLoteria.toLocaleString()}** para casa!` });
    } else {
      saveEcoData(data);
      return interaction.reply({ content: '🎟️ Compraste o bilhete de loteria, mas infelizmente não foi desta vez que saíste premiado.' });
    }
  }
}

module.exports = { economySlashCommands, handleEconomyInteraction };
EOF
