'use strict';

const { EmbedBuilder, SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { JsonStore } = require('./storage');
const { EPHEMERAL, eph, truncate, fmtDate, unix, randInt, respond } = require('./utils');

// ID do dono do bot (opcional). Defina a variável de ambiente CREATOR_ID no Render.
const CREATOR_ID = process.env.CREATOR_ID || '';

/* ============================================================
 *  AJUSTES DA ECONOMIA (mexe só aqui para balancear)
 * ============================================================ */
const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
const MAX_BALANCE = 1e15;

const ECONOMY = {
  startWallet: 150000,
  startBank: 500000,
  daily: 10000,
  weekly: 75000,
  workCooldown: 2 * MINUTE,
  workMin: 4000,
  workMax: 9999,
  levelUpChance: 0.25,
  levelBonus: 0.05,          // +5% de ganhos por nível de trabalho
  rendaUpgradeBonus: 0.2,    // "Upgrade Renda Nv2": +20% de ganhos
  gamble: { winChance: 0.48, coinflipChance: 0.49, luckBonus: 0.03 },
  lottery: { price: 5000, chance: 0.02, prize: 200000 },
  loan: { base: 500000, perLevel: 100000, interest: 0.2 },
  crime: { cooldown: 3 * MINUTE, baseChance: 0.45, min: 15000, max: 60000, fineMin: 10000, fineMax: 25000 },
  rob: { cooldown: 5 * MINUTE, baseChance: 0.4, minTarget: 5000, minPct: 0.1, maxPct: 0.3, cap: 150000, fineMin: 8000, fineMax: 20000 }
};

const ACTIVITIES = {
  minerar: { cooldown: MINUTE, min: 3000, max: 10999, emoji: '⛏️', frases: ['Desceste às minas e encontraste minérios raros', 'Uma veia de ouro apareceu na tua picareta', 'Escavaste fundo e vendeste cristais valiosos'] },
  pescar: { cooldown: MINUTE, min: 3000, max: 10999, emoji: '🎣', frases: ['Fisgaste um peixe enorme no rio', 'A rede voltou cheia de peixes frescos', 'Pescaste um peixe raro e vendeste no mercado'] },
  cacar: { cooldown: MINUTE, min: 3000, max: 10999, emoji: '🏹', frases: ['Caçaste um javali na floresta', 'A tua armadilha apanhou uma boa presa', 'Vendeste peles de qualidade na cidade'] },
  farmar: { cooldown: MINUTE, min: 3000, max: 10999, emoji: '🌾', frases: ['A colheita foi farta este ciclo', 'Vendeste uma carga de legumes frescos', 'A tua plantação rendeu bem'] }
};

const RED_NUMBERS = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
const SLOT_SYMBOLS = [
  { emoji: '🍒', retorno: 4 },
  { emoji: '🍋', retorno: 6 },
  { emoji: '🔔', retorno: 8 },
  { emoji: '⭐', retorno: 12 },
  { emoji: '💎', retorno: 25 },
  { emoji: '7️⃣', retorno: 50 }
];
const INVESTMENTS = {
  crypto: { nome: 'Criptomoedas', custo: 50000, chance: 0.4, ganho: 2.6, perda: 0.2 },
  tesouro: { nome: 'Tesouro Direto', custo: 20000, chance: 0.92, ganho: 1.2, perda: 0.8 },
  acoes: { nome: 'Ações da Bolsa', custo: 35000, chance: 0.55, ganho: 1.7, perda: 0.6 }
};

/* ============================================================
 *  CATÁLOGO DA LOJA
 * ============================================================ */
const CATALOG = {
  veiculos: {
    titulo: '🚗 **Escolhe o teu veículo de sonho:**', style: ButtonStyle.Primary, itens: [
      { id: 'moto', nome: 'Moto Esportiva', preco: 350000, label: 'Moto (R$ 350k)' },
      { id: 'desportivo', nome: 'Carro Desportivo', preco: 1200000, label: 'Desportivo (R$ 1.2M)' },
      { id: 'supercarro', nome: 'Supercarro Luxo', preco: 4500000, label: 'Supercarro (R$ 4.5M)' }
    ]
  },
  casas: {
    titulo: '🏡 **Escolhe o teu imóvel:**', style: ButtonStyle.Primary, itens: [
      { id: 'kitnet', nome: 'Kitnet Central', preco: 250000, label: 'Kitnet (R$ 250k)' },
      { id: 'apartamento', nome: 'Apartamento de Luxo', preco: 1800000, label: 'Apartamento (R$ 1.8M)' },
      { id: 'mansao', nome: 'Mansao com Piscina', preco: 12000000, label: 'Mansão (R$ 12M)' }
    ]
  },
  celulares: {
    titulo: '📱 **Escolhe o teu telemóvel:**', style: ButtonStyle.Primary, itens: [
      { id: 'basico', nome: 'Smartphone Basico', preco: 15000, label: 'Básico (R$ 15k)' },
      { id: 'promax', nome: 'Smartphone Pro Max', preco: 85000, label: 'Pro Max (R$ 85k)' },
      { id: 'gold', nome: 'Edicao Limitada Ouro', preco: 300000, label: 'Gold (R$ 300k)' }
    ]
  },
  cargos: {
    titulo: '👑 **Escolhe o teu cargo VIP:**', style: ButtonStyle.Success, itens: [
      { id: 'vipbronze', nome: 'VIP Bronze (30d)', preco: 500000, label: 'VIP Bronze (R$ 500k)', vip: true },
      { id: 'vipprata', nome: 'VIP Prata (30d)', preco: 1500000, label: 'VIP Prata (R$ 1.5M)', vip: true },
      { id: 'vipouro', nome: 'VIP Ouro (30d)', preco: 5000000, label: 'VIP Ouro (R$ 5M)', vip: true }
    ]
  },
  upgrades: {
    titulo: '⚡ **Escolhe o teu upgrade:**', style: ButtonStyle.Success, itens: [
      { id: 'renda', nome: 'Upgrade Renda Nv2', preco: 200000, label: 'Renda Nv2 (R$ 200k)', unico: true },
      { id: 'fuga', nome: 'Kit Fuga Rapida', preco: 450000, label: 'Kit Fuga (R$ 450k)', unico: true },
      { id: 'sorte', nome: 'Amuleto da Sorte', preco: 800000, label: 'Sorte (R$ 800k)', unico: true }
    ]
  },
  armamento: {
    titulo: '🔫 **Escolhe o teu armamento:**', style: ButtonStyle.Danger, itens: [
      { id: 'kitleve', nome: 'Kit Tatico Leve', preco: 150000, label: 'Kit Leve (R$ 150k)', unico: true },
      { id: 'kitpesado', nome: 'Kit Tatico Pesado', preco: 600000, label: 'Kit Pesado (R$ 600k)', unico: true }
    ]
  }
};

const ITEMS = {};
for (const [categoria, cat] of Object.entries(CATALOG)) {
  for (const item of cat.itens) ITEMS[item.id] = { ...item, categoria };
}

/* ============================================================
 *  COMANDOS SLASH
 * ============================================================ */
const valorOpt = (desc = 'Valor') => (o) => o.setName('valor').setDescription(desc).setRequired(true).setMinValue(1);

const economySlashCommands = [
  new SlashCommandBuilder().setName('saldo').setDescription('Consulta o teu património e extrato').addUserOption(o => o.setName('usuario').setDescription('Membro').setRequired(false)),
  new SlashCommandBuilder().setName('patrimonio').setDescription('Consulta o teu património e saldo total'),
  new SlashCommandBuilder().setName('depositar').setDescription('Guarda dinheiro no banco').addIntegerOption(valorOpt('Quantia')),
  new SlashCommandBuilder().setName('sacar').setDescription('Saca dinheiro do banco').addIntegerOption(valorOpt('Quantia')),
  new SlashCommandBuilder().setName('transferir').setDescription('Faz Pix/Transferência para outro membro').addUserOption(o => o.setName('usuario').setDescription('Destinatário').setRequired(true)).addIntegerOption(valorOpt()),
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
  new SlashCommandBuilder().setName('apostar').setDescription('Aposta dinheiro num jogo rápido de sorte').addIntegerOption(valorOpt()),
  new SlashCommandBuilder().setName('coinflip').setDescription('Joga cara ou coroa apostando').addStringOption(o => o.setName('escolha').setDescription('cara ou coroa').setRequired(true).addChoices({ name: 'Cara', value: 'cara' }, { name: 'Coroa', value: 'coroa' })).addIntegerOption(valorOpt()),
  new SlashCommandBuilder().setName('slots').setDescription('Joga na máquina caça-níqueis').addIntegerOption(valorOpt()),
  new SlashCommandBuilder().setName('roleta').setDescription('Aposta na roleta da sorte').addStringOption(o => o.setName('cor').setDescription('vermelho, preto ou verde').setRequired(true).addChoices({ name: 'Vermelho', value: 'vermelho' }, { name: 'Preto', value: 'preto' }, { name: 'Verde', value: 'verde' })).addIntegerOption(valorOpt()),

  new SlashCommandBuilder().setName('loja').setDescription('Mostra a lojinha do servidor'),
  new SlashCommandBuilder().setName('mercado').setDescription('Envia o painel interativo fixo da lojinha e mercado no canal'),
  new SlashCommandBuilder().setName('painel-economia').setDescription('Envia o painel interativo fixo da lojinha e mercado no canal'),
  new SlashCommandBuilder().setName('inventario').setDescription('Mostra os itens que tens guardados'),

  new SlashCommandBuilder().setName('investir').setDescription('Aplica dinheiro em fundos de investimento variados').addStringOption(o => o.setName('opcao').setDescription('Tipo de investimento').setRequired(true).addChoices(
    { name: 'Criptomoedas (Alto Risco) - R$ 50.000', value: 'crypto' },
    { name: 'Tesouro Direto (Baixo Risco) - R$ 20.000', value: 'tesouro' },
    { name: 'Ações da Bolsa (Médio Risco) - R$ 35.000', value: 'acoes' }
  )),
  new SlashCommandBuilder().setName('emprestimo').setDescription('Pede um empréstimo ao banco').addIntegerOption(valorOpt()),
  new SlashCommandBuilder().setName('pagar').setDescription('Paga a tua dívida do empréstimo').addIntegerOption(valorOpt('Quanto pagar')),
  new SlashCommandBuilder().setName('loteria').setDescription('Compra um bilhete de loteria por R$ 5.000'),

  new SlashCommandBuilder().setName('addmoney').setDescription('[DONO] Adiciona dinheiro a um usuário').addUserOption(o => o.setName('usuario').setDescription('Alvo').setRequired(true)).addIntegerOption(valorOpt()),
  new SlashCommandBuilder().setName('removemoney').setDescription('[DONO] Remove dinheiro de um usuário').addUserOption(o => o.setName('usuario').setDescription('Alvo').setRequired(true)).addIntegerOption(valorOpt())
];

/* ============================================================
 *  DADOS
 * ============================================================ */
const ecoStore = new JsonStore('economy_data.json');
const data = ecoStore.data;
const saveEcoData = () => ecoStore.save();

const ACCOUNT_TEMPLATE = {
  wallet: ECONOMY.startWallet,
  bank: ECONOMY.startBank,
  jobLevel: 1,
  lastDaily: 0,
  lastWeekly: 0,
  lastWork: 0,
  inventory: [],
  extrato: [],
  investimento: 0,
  debt: 0,
  cooldowns: {},
  vips: []
};

function getUserAccount(userId) {
  let acc = data[userId];
  if (!acc) acc = data[userId] = {};
  for (const key in ACCOUNT_TEMPLATE) {
    if (acc[key] === undefined) acc[key] = structuredClone(ACCOUNT_TEMPLATE[key]);
  }
  return acc;
}

function addExtrato(acc, texto) {
  acc.extrato.unshift(`[${fmtDate()}] ${texto}`);
  if (acc.extrato.length > 10) acc.extrato.length = 10;
}

const fmt = (n) => `R$ ${Math.floor(n).toLocaleString('pt-BR')}`;
const credit = (acc, value) => { acc.wallet = Math.min(MAX_BALANCE, acc.wallet + Math.floor(value)); };
const has = (acc, nome) => acc.inventory.includes(nome);
const luck = (acc) => (has(acc, 'Amuleto da Sorte') ? ECONOMY.gamble.luckBonus : 0);
const netWorth = (acc) => (acc.wallet || 0) + (acc.bank || 0) - (acc.debt || 0);

function incomeMultiplier(acc) {
  return 1 + (acc.jobLevel - 1) * ECONOMY.levelBonus + (has(acc, 'Upgrade Renda Nv2') ? ECONOMY.rendaUpgradeBonus : 0);
}

/** Tempo que falta (ms) para o cooldown acabar; 0 se já pode usar. */
const cdLeft = (acc, key, ms, now) => Math.max(0, (acc.cooldowns[key] || 0) + ms - now);
const startCd = (acc, key, now) => { acc.cooldowns[key] = now; };
const waitMsg = (ms) => `⏳ Calma! Podes tentar de novo <t:${unix(Date.now() + ms)}:R>.`;

/* ============================================================
 *  PAINEL DO MERCADO
 * ============================================================ */
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

function categoryRow(cat) {
  return new ActionRowBuilder().addComponents(
    cat.itens.map((item) => new ButtonBuilder().setCustomId(`buy_${item.id}`).setLabel(item.label).setStyle(cat.style))
  );
}

/* ============================================================
 *  VIPs (cargo temporário de 30 dias)
 * ============================================================ */
const VIP_DURATION = 30 * DAY;
const vipRoleName = (item) => item.nome.replace(/\s*\(30d\)\s*$/, '');

async function grantVip(interaction, item, acc) {
  const guild = interaction.guild;
  const nome = vipRoleName(item);
  let role = guild.roles.cache.find((r) => r.name === nome);
  if (!role) role = await guild.roles.create({ name: nome, mentionable: false, reason: 'Cargo VIP da loja do bot' });
  await interaction.member.roles.add(role, 'Compra de VIP na loja');

  const existente = acc.vips.find((v) => v.guildId === guild.id && v.roleId === role.id);
  if (existente) existente.expiresAt = Math.max(existente.expiresAt, Date.now()) + VIP_DURATION;
  else acc.vips.push({ guildId: guild.id, roleId: role.id, userId: interaction.user.id, expiresAt: Date.now() + VIP_DURATION });
}

let ecoSchedulerTimer = null;

async function sweepVips(client) {
  const now = Date.now();
  let mudou = false;
  for (const [userId, acc] of Object.entries(data)) {
    if (!acc.vips?.length) continue;
    const vencidos = acc.vips.filter((v) => v.expiresAt <= now);
    for (const vip of vencidos) {
      try {
        const guild = client.guilds.cache.get(vip.guildId);
        const membro = guild ? await guild.members.fetch(userId).catch(() => null) : null;
        if (membro) await membro.roles.remove(vip.roleId, 'VIP expirado').catch(() => {});
      } catch (_) { /* ignora */ }
    }
    if (vencidos.length) {
      acc.vips = acc.vips.filter((v) => v.expiresAt > now);
      mudou = true;
    }
  }
  if (mudou) saveEcoData();
}

function startEconomyScheduler(client) {
  if (ecoSchedulerTimer) return;
  ecoSchedulerTimer = setInterval(() => sweepVips(client).catch((err) => console.error('[vip]', err.message)), MINUTE);
  sweepVips(client).catch(() => {});
}

/* ============================================================
 *  BOTÕES
 * ============================================================ */
function claimDaily(acc, now, origem = '') {
  if (now - acc.lastDaily < DAY) return false;
  credit(acc, ECONOMY.daily);
  acc.lastDaily = now;
  addExtrato(acc, `Resgatou o Daily${origem} (${fmt(ECONOMY.daily)})`);
  saveEcoData();
  return true;
}

async function buyItem(interaction, acc, itemId) {
  const item = ITEMS[itemId];
  if (!item) return interaction.reply(eph('❌ Este menu expirou. Abre o `/mercado` novamente.'));

  if (item.unico && has(acc, item.nome)) return interaction.reply(eph(`❌ Já tens **${item.nome}**!`));
  if (item.vip && !interaction.guild) return interaction.reply(eph('❌ Cargos VIP só podem ser comprados dentro de um servidor.'));
  if (acc.wallet < item.preco) {
    return interaction.reply(eph(`❌ Dinheiro insuficiente na carteira! Precisas de **${fmt(item.preco)}**, mas só tens **${fmt(acc.wallet)}**.`));
  }

  acc.wallet -= item.preco;
  acc.inventory.push(item.nome);
  addExtrato(acc, `Comprou ${item.nome} por ${fmt(item.preco)}`);
  saveEcoData();

  let extra = '';
  if (item.vip) {
    try {
      await interaction.deferReply({ flags: EPHEMERAL });
      await grantVip(interaction, item, acc);
      extra = '\n👑 O cargo VIP foi atribuído e dura **30 dias**.';
      saveEcoData();
    } catch (err) {
      // Não conseguiu dar o cargo: devolve o dinheiro
      acc.wallet = Math.min(MAX_BALANCE, acc.wallet + item.preco);
      const idx = acc.inventory.lastIndexOf(item.nome);
      if (idx !== -1) acc.inventory.splice(idx, 1);
      addExtrato(acc, `Reembolso de ${item.nome} (${fmt(item.preco)})`);
      saveEcoData();
      return respond(interaction, eph('❌ Não consegui atribuir o cargo VIP (preciso da permissão **Gerir Cargos** e de estar acima do cargo). O teu dinheiro foi devolvido.'));
    }
  }

  return respond(interaction, eph(`✅ **Compra efetuada com sucesso!** Adquiriste **${item.nome}** por **${fmt(item.preco)}**. Consulta o teu inventário com \`/perfil\` ou \`/inventario\`.${extra}`));
}

async function handleButton(interaction) {
  const id = interaction.customId;
  if (!id.startsWith('eco_') && !id.startsWith('buy_')) return;

  const acc = getUserAccount(interaction.user.id);
  const now = Date.now();

  if (id.startsWith('buy_')) return buyItem(interaction, acc, id.slice(4));

  if (id.startsWith('eco_cat_')) {
    const cat = CATALOG[id.slice('eco_cat_'.length)];
    if (!cat) return;
    return interaction.reply({ content: cat.titulo, components: [categoryRow(cat)], flags: EPHEMERAL });
  }

  if (id === 'eco_btn_saldo') {
    return interaction.reply(eph(`💳 **Saldo:** Carteira: ${fmt(acc.wallet)} | Banco: ${fmt(acc.bank)}${acc.debt > 0 ? ` | Dívida: ${fmt(acc.debt)}` : ''} | Total: ${fmt(netWorth(acc))}`));
  }
  if (id === 'eco_btn_poupanca') {
    return interaction.reply(eph(`🏦 **Poupança:** Tens ${fmt(acc.bank)} guardados no banco.`));
  }
  if (id === 'eco_btn_daily') {
    if (!claimDaily(acc, now, ' via Painel')) return interaction.reply(eph(`⏳ Já resgataste o teu daily hoje! Volta <t:${unix(acc.lastDaily + DAY)}:R>.`));
    return interaction.reply(eph(`🎁 Resgataste o teu daily de **${fmt(ECONOMY.daily)}**!`));
  }
}

/* ============================================================
 *  COMANDOS
 * ============================================================ */
function activityCommand(name) {
  const act = ACTIVITIES[name];
  return async (interaction, acc, now) => {
    const rest = cdLeft(acc, name, act.cooldown, now);
    if (rest > 0) return interaction.reply(eph(waitMsg(rest)));
    startCd(acc, name, now);
    const ganho = Math.floor(randInt(act.min, act.max) * incomeMultiplier(acc));
    credit(acc, ganho);
    addExtrato(acc, `${name}: +${fmt(ganho)}`);
    saveEcoData();
    const frase = act.frases[randInt(0, act.frases.length - 1)];
    return interaction.reply(`${act.emoji} ${frase} e obtiveste um lucro de **${fmt(ganho)}**!`);
  };
}

const COMMANDS = {
  async mercado(interaction) {
    return interaction.reply({ embeds: [getMarketPanelEmbed()], components: getMarketPanelButtons() });
  },

  async addmoney(interaction) { return adminMoney(interaction, true); },
  async removemoney(interaction) { return adminMoney(interaction, false); },

  async saldo(interaction) {
    const alvo = interaction.options.getUser('usuario') || interaction.user;
    const alvoAcc = getUserAccount(alvo.id);
    const embed = new EmbedBuilder()
      .setColor(0x2ECC71)
      .setTitle(`💳 Património de ${alvo.tag}`)
      .addFields(
        { name: '💵 Carteira', value: fmt(alvoAcc.wallet), inline: true },
        { name: '🏦 Banco', value: fmt(alvoAcc.bank), inline: true }
      );
    if (alvoAcc.debt > 0) embed.addFields({ name: '📉 Dívida', value: fmt(alvoAcc.debt), inline: true });
    embed.addFields({ name: '💎 Total', value: fmt(netWorth(alvoAcc)), inline: false });
    return interaction.reply({ embeds: [embed] });
  },

  async depositar(interaction, acc) {
    const valor = interaction.options.getInteger('valor');
    if (valor <= 0 || valor > acc.wallet) return interaction.reply(eph('❌ Valor inválido.'));
    acc.wallet -= valor;
    acc.bank = Math.min(MAX_BALANCE, acc.bank + valor);
    addExtrato(acc, `Depositou ${fmt(valor)} no banco.`);
    saveEcoData();
    return interaction.reply(`✅ Depositaste **${fmt(valor)}** no banco.`);
  },

  async sacar(interaction, acc) {
    const valor = interaction.options.getInteger('valor');
    if (valor <= 0 || valor > acc.bank) return interaction.reply(eph('❌ Valor inválido.'));
    acc.bank -= valor;
    credit(acc, valor);
    addExtrato(acc, `Sacou ${fmt(valor)} do banco.`);
    saveEcoData();
    return interaction.reply(`✅ Sacaste **${fmt(valor)}** do banco.`);
  },

  async transferir(interaction, acc) {
    const alvo = interaction.options.getUser('usuario');
    const valor = interaction.options.getInteger('valor');
    if (alvo.id === interaction.user.id) return interaction.reply(eph('❌ Não podes transferir para ti próprio.'));
    if (alvo.bot) return interaction.reply(eph('❌ Não podes transferir dinheiro para um bot.'));
    if (valor <= 0 || valor > acc.wallet) return interaction.reply(eph('❌ Saldo insuficiente na carteira.'));

    const alvoAcc = getUserAccount(alvo.id);
    acc.wallet -= valor;
    credit(alvoAcc, valor);
    addExtrato(acc, `Pix enviado de ${fmt(valor)} para ${alvo.tag}`);
    addExtrato(alvoAcc, `Pix recebido de ${fmt(valor)} de ${interaction.user.tag}`);
    saveEcoData();
    return interaction.reply({ content: `💸 Pix efetuado! Transferiste **${fmt(valor)}** para <@${alvo.id}>.`, allowedMentions: { users: [alvo.id] } });
  },

  async perfil(interaction, acc) {
    const embed = new EmbedBuilder()
      .setColor(0x9B59B6)
      .setTitle(`👤 Perfil — ${interaction.user.tag}`)
      .addFields(
        { name: '📈 Nível', value: `Nível ${acc.jobLevel}`, inline: true },
        { name: '💎 Património', value: fmt(netWorth(acc)), inline: true },
        { name: '🎒 Inventário & Bens', value: truncate(inventoryText(acc), 1024), inline: false }
      );
    if (acc.debt > 0) embed.addFields({ name: '📉 Dívida', value: fmt(acc.debt), inline: true });
    return interaction.reply({ embeds: [embed] });
  },

  async inventario(interaction, acc) {
    const embed = new EmbedBuilder().setColor(0x9B59B6).setTitle('🎒 O teu inventário').setDescription(truncate(inventoryText(acc), 4000));
    return interaction.reply({ embeds: [embed], flags: EPHEMERAL });
  },

  async rank(interaction) {
    const sorted = Object.entries(data)
      .map(([id, a]) => ({ id, total: netWorth(a) }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 10);
    if (sorted.length === 0) return interaction.reply(eph('📊 Sem registros.'));
    const desc = sorted.map((item, i) => {
      const med = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `**#${i + 1}**`;
      return `${med} <@${item.id}> — **${fmt(item.total)}**`;
    }).join('\n');
    return interaction.reply({ embeds: [new EmbedBuilder().setColor(0xF1C40F).setTitle('🏆 Top 10 Mais Ricos').setDescription(desc)], allowedMentions: { parse: [] } });
  },

  async extrato(interaction, acc) {
    const hist = acc.extrato.length ? acc.extrato.join('\n') : 'Sem movimentações.';
    return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x3498DB).setTitle('📄 Extrato').setDescription(hist)], flags: EPHEMERAL });
  },

  async daily(interaction, acc, now) {
    if (!claimDaily(acc, now)) return interaction.reply(eph(`⏳ Já resgataste o teu daily hoje! Volta <t:${unix(acc.lastDaily + DAY)}:R>.`));
    return interaction.reply(`🎁 Resgataste o teu daily de **${fmt(ECONOMY.daily)}**!`);
  },

  async weekly(interaction, acc, now) {
    const semana = 7 * DAY;
    if (now - acc.lastWeekly < semana) return interaction.reply(eph(`⏳ Já resgataste o teu bónus semanal! Volta <t:${unix(acc.lastWeekly + semana)}:R>.`));
    credit(acc, ECONOMY.weekly);
    acc.lastWeekly = now;
    addExtrato(acc, `Resgatou o Weekly (${fmt(ECONOMY.weekly)})`);
    saveEcoData();
    return interaction.reply(`🎁 Resgataste o teu bónus semanal de **${fmt(ECONOMY.weekly)}**!`);
  },

  async trabalhar(interaction, acc, now) {
    const rest = Math.max(0, acc.lastWork + ECONOMY.workCooldown - now);
    if (rest > 0) return interaction.reply(eph(`⏳ Descansa um pouco. ${waitMsg(rest)}`));
    acc.lastWork = now;
    const ganho = Math.floor(randInt(ECONOMY.workMin, ECONOMY.workMax) * incomeMultiplier(acc));
    credit(acc, ganho);
    let extra = '';
    if (Math.random() < ECONOMY.levelUpChance) {
      acc.jobLevel += 1;
      extra = `\n📈 Subiste para o **nível ${acc.jobLevel}** de trabalho! (+${Math.round(ECONOMY.levelBonus * 100)}% de ganhos)`;
    }
    addExtrato(acc, `Trabalhou e ganhou ${fmt(ganho)}`);
    saveEcoData();
    return interaction.reply(`💼 Trabalhaste afincadamente e ganhaste **${fmt(ganho)}**!${extra}`);
  },

  async roubar(interaction, acc, now) {
    const alvo = interaction.options.getUser('usuario');
    if (alvo.id === interaction.user.id) return interaction.reply(eph('❌ Não podes roubar a ti próprio.'));
    if (alvo.bot) return interaction.reply(eph('❌ Bots não têm carteira para roubar.'));
    const rest = cdLeft(acc, 'roubar', ECONOMY.rob.cooldown, now);
    if (rest > 0) return interaction.reply(eph(waitMsg(rest)));

    const alvoAcc = getUserAccount(alvo.id);
    if (alvoAcc.wallet < ECONOMY.rob.minTarget) return interaction.reply(eph(`❌ ${alvo.tag} tem a carteira quase vazia, não compensa.`));
    startCd(acc, 'roubar', now);

    const chance = ECONOMY.rob.baseChance + (has(acc, 'Kit Tatico Leve') ? 0.05 : 0) + (has(acc, 'Kit Tatico Pesado') ? 0.12 : 0) + luck(acc);
    if (Math.random() < chance) {
      const pct = ECONOMY.rob.minPct + Math.random() * (ECONOMY.rob.maxPct - ECONOMY.rob.minPct);
      const roubado = Math.min(ECONOMY.rob.cap, Math.max(1, Math.floor(alvoAcc.wallet * pct)));
      alvoAcc.wallet -= roubado;
      credit(acc, roubado);
      addExtrato(acc, `Roubou ${fmt(roubado)} de ${alvo.tag}`);
      addExtrato(alvoAcc, `Foi roubado em ${fmt(roubado)} por ${interaction.user.tag}`);
      saveEcoData();
      return interaction.reply({ content: `🥷 Sucesso! Roubaste **${fmt(roubado)}** de <@${alvo.id}>!`, allowedMentions: { users: [alvo.id] } });
    }

    let multa = Math.min(acc.wallet, randInt(ECONOMY.rob.fineMin, ECONOMY.rob.fineMax));
    if (has(acc, 'Kit Fuga Rapida')) multa = Math.floor(multa / 2);
    acc.wallet -= multa;
    credit(alvoAcc, multa);
    addExtrato(acc, `Falhou ao roubar ${alvo.tag} e pagou ${fmt(multa)}`);
    saveEcoData();
    return interaction.reply({ content: `🚔 Foste apanhado a tentar roubar <@${alvo.id}> e pagaste **${fmt(multa)}** de indemnização!`, allowedMentions: { users: [alvo.id] } });
  },

  async crime(interaction, acc, now) {
    const c = ECONOMY.crime;
    const rest = cdLeft(acc, 'crime', c.cooldown, now);
    if (rest > 0) return interaction.reply(eph(waitMsg(rest)));
    startCd(acc, 'crime', now);

    const chance = c.baseChance + (has(acc, 'Kit Tatico Leve') ? 0.07 : 0) + (has(acc, 'Kit Tatico Pesado') ? 0.13 : 0) + luck(acc);
    if (Math.random() < chance) {
      const ganho = randInt(c.min, c.max);
      credit(acc, ganho);
      addExtrato(acc, `Crime bem-sucedido: +${fmt(ganho)}`);
      saveEcoData();
      return interaction.reply(`🦹 O assalto correu bem! Fugiste com **${fmt(ganho)}**.`);
    }
    let multa = Math.min(acc.wallet, randInt(c.fineMin, c.fineMax));
    if (has(acc, 'Kit Fuga Rapida')) multa = Math.floor(multa / 2);
    acc.wallet -= multa;
    addExtrato(acc, `Crime falhado: -${fmt(multa)}`);
    saveEcoData();
    return interaction.reply(`🚔 A polícia apanhou-te! Pagaste uma multa de **${fmt(multa)}**.`);
  },

  async apostar(interaction, acc) {
    const valor = interaction.options.getInteger('valor');
    if (valor <= 0 || valor > acc.wallet) return interaction.reply(eph('❌ Saldo insuficiente na carteira.'));
    if (Math.random() < ECONOMY.gamble.winChance + luck(acc)) {
      credit(acc, valor);
      saveEcoData();
      return interaction.reply(`🎲 **Vitória!** A sorte esteve do teu lado e ganhaste **${fmt(valor)}**.`);
    }
    acc.wallet -= valor;
    saveEcoData();
    return interaction.reply(`🎲 **Derrota!** A banca recolheu os teus **${fmt(valor)}**.`);
  },

  async coinflip(interaction, acc) {
    const escolha = interaction.options.getString('escolha');
    const valor = interaction.options.getInteger('valor');
    if (valor <= 0 || valor > acc.wallet) return interaction.reply(eph('❌ Saldo insuficiente na carteira.'));
    const ganhou = Math.random() < ECONOMY.gamble.coinflipChance + luck(acc);
    const resultado = ganhou ? escolha : (escolha === 'cara' ? 'coroa' : 'cara');
    if (ganhou) credit(acc, valor); else acc.wallet -= valor;
    saveEcoData();
    return interaction.reply(`🪙 Saiu **${resultado}**! ${ganhou ? `🎉 Ganhaste **${fmt(valor)}**.` : `💸 Perdeste **${fmt(valor)}**.`}`);
  },

  async slots(interaction, acc) {
    const valor = interaction.options.getInteger('valor');
    if (valor <= 0 || valor > acc.wallet) return interaction.reply(eph('❌ Saldo insuficiente na carteira.'));
    const rolos = [0, 1, 2].map(() => SLOT_SYMBOLS[randInt(0, SLOT_SYMBOLS.length - 1)]);
    const linha = `🎰 | ${rolos.map((r) => r.emoji).join(' | ')} |`;
    const iguais = new Set(rolos.map((r) => r.emoji)).size;

    if (iguais === 1) {
      const lucro = valor * (rolos[0].retorno - 1);
      credit(acc, lucro);
      saveEcoData();
      return interaction.reply(`${linha}\n💎 **JACKPOT!** Três iguais! Ganhaste **${fmt(lucro)}**!`);
    }
    if (iguais === 2) {
      saveEcoData();
      return interaction.reply(`${linha}\n😅 Dois iguais! Recuperaste a tua aposta de **${fmt(valor)}**.`);
    }
    acc.wallet -= valor;
    saveEcoData();
    return interaction.reply(`${linha}\n💸 Nada desta vez. Perdeste **${fmt(valor)}**.`);
  },

  async roleta(interaction, acc) {
    const cor = interaction.options.getString('cor');
    const valor = interaction.options.getInteger('valor');
    if (valor <= 0 || valor > acc.wallet) return interaction.reply(eph('❌ Saldo insuficiente na carteira.'));
    const numero = randInt(0, 36);
    const saiu = numero === 0 ? 'verde' : RED_NUMBERS.has(numero) ? 'vermelho' : 'preto';
    const emoji = saiu === 'verde' ? '🟢' : saiu === 'vermelho' ? '🔴' : '⚫';

    if (saiu === cor) {
      const lucro = cor === 'verde' ? valor * 35 : valor;
      credit(acc, lucro);
      saveEcoData();
      return interaction.reply(`🎡 Saiu ${emoji} **${numero}** (${saiu})! 🎉 Ganhaste **${fmt(lucro)}**!`);
    }
    acc.wallet -= valor;
    saveEcoData();
    return interaction.reply(`🎡 Saiu ${emoji} **${numero}** (${saiu}). 💸 Perdeste **${fmt(valor)}**.`);
  },

  async investir(interaction, acc) {
    const inv = INVESTMENTS[interaction.options.getString('opcao')];
    if (!inv) return interaction.reply(eph('❌ Opção de investimento inválida.'));
    if (acc.wallet < inv.custo) return interaction.reply(eph(`❌ Não tens dinheiro suficiente na carteira para este investimento (Custo: ${fmt(inv.custo)}).`));

    acc.wallet -= inv.custo;
    const retorno = Math.floor(inv.custo * (Math.random() < inv.chance ? inv.ganho : inv.perda));
    credit(acc, retorno);
    addExtrato(acc, `Investiu ${fmt(inv.custo)} em ${inv.nome} e obteve retorno de ${fmt(retorno)}`);
    saveEcoData();
    return interaction.reply(`📈 **Investimento Concluído!** Aplicaste ${fmt(inv.custo)} em ${inv.nome}. O retorno foi de **${fmt(retorno)}** (${retorno >= inv.custo ? '🎉 Lucro!' : '📉 Prejuízo'}).`);
  },

  async emprestimo(interaction, acc) {
    const valor = interaction.options.getInteger('valor');
    const limite = ECONOMY.loan.base + acc.jobLevel * ECONOMY.loan.perLevel;
    if (acc.debt > 0) return interaction.reply(eph(`❌ Ainda deves **${fmt(acc.debt)}** ao banco. Usa \`/pagar\` primeiro.`));
    if (valor <= 0 || valor > limite) return interaction.reply(eph(`❌ O teu limite de empréstimo é de **${fmt(limite)}**.`));

    const divida = Math.ceil(valor * (1 + ECONOMY.loan.interest));
    credit(acc, valor);
    acc.debt = divida;
    addExtrato(acc, `Empréstimo de ${fmt(valor)} (dívida de ${fmt(divida)})`);
    saveEcoData();
    return interaction.reply(`🏦 Empréstimo aprovado! Recebeste **${fmt(valor)}** e agora deves **${fmt(divida)}** (juros de ${Math.round(ECONOMY.loan.interest * 100)}%). Usa \`/pagar\` para quitar.`);
  },

  async pagar(interaction, acc) {
    const valor = interaction.options.getInteger('valor');
    if (acc.debt <= 0) return interaction.reply(eph('✅ Não tens nenhuma dívida!'));
    const pagamento = Math.min(valor, acc.debt);
    if (acc.wallet < pagamento) return interaction.reply(eph(`❌ Precisas de **${fmt(pagamento)}** na carteira para pagar isto.`));
    acc.wallet -= pagamento;
    acc.debt -= pagamento;
    addExtrato(acc, `Pagou ${fmt(pagamento)} da dívida`);
    saveEcoData();
    return interaction.reply(acc.debt > 0 ? `💳 Pagaste **${fmt(pagamento)}**. Ainda deves **${fmt(acc.debt)}**.` : `🎉 Dívida quitada! Pagaste **${fmt(pagamento)}**.`);
  },

  async loteria(interaction, acc) {
    const { price, chance, prize } = ECONOMY.lottery;
    if (acc.wallet < price) return interaction.reply(eph(`❌ Cada bilhete de loteria custa ${fmt(price)}.`));
    acc.wallet -= price;

    if (Math.random() < chance + luck(acc) / 3) {
      credit(acc, prize);
      addExtrato(acc, `Ganhou na Loteria (${fmt(prize)})`);
      saveEcoData();
      return interaction.reply(`🎰 **JACKPOT! ACERTASTE NA LOTERIA!** Levaste o prémio máximo de **${fmt(prize)}** para casa!`);
    }
    saveEcoData();
    return interaction.reply('🎟️ Compraste o bilhete de loteria, mas infelizmente não foi desta vez que saíste premiado.');
  }
};

COMMANDS['painel-economia'] = COMMANDS.mercado;
COMMANDS.loja = COMMANDS.mercado;
COMMANDS.patrimonio = COMMANDS.saldo;
for (const name of Object.keys(ACTIVITIES)) COMMANDS[name] = activityCommand(name);

// Comandos que não precisam de conta (não cria registro à toa)
const NO_ACCOUNT = new Set(['mercado', 'painel-economia', 'loja', 'addmoney', 'removemoney', 'saldo', 'patrimonio', 'rank']);

const handledCommands = Object.keys(COMMANDS);

function inventoryText(acc) {
  if (!acc.inventory.length) return 'Nenhum bem adquirido';
  const contagem = new Map();
  for (const nome of acc.inventory) contagem.set(nome, (contagem.get(nome) || 0) + 1);
  return [...contagem].map(([nome, qtd]) => (qtd > 1 ? `${nome} ×${qtd}` : nome)).join(', ');
}

async function adminMoney(interaction, adicionar) {
  const { user, options } = interaction;
  const isAdmin = interaction.memberPermissions?.has('Administrator');
  if ((!CREATOR_ID || user.id !== CREATOR_ID) && !isAdmin) {
    return interaction.reply(eph('❌ Apenas o criador do bot ou administradores podem usar este comando.'));
  }
  const alvo = options.getUser('usuario');
  const valor = options.getInteger('valor');
  if (valor <= 0) return interaction.reply(eph('❌ Valor inválido.'));
  const alvoAcc = getUserAccount(alvo.id);

  if (adicionar) {
    credit(alvoAcc, valor);
    addExtrato(alvoAcc, `Recebeu ${fmt(valor)} de um Admin.`);
    saveEcoData();
    return interaction.reply({ content: `✅ Adicionados **${fmt(valor)}** à carteira de <@${alvo.id}>.`, allowedMentions: { parse: [] } });
  }
  alvoAcc.wallet = Math.max(0, alvoAcc.wallet - valor);
  addExtrato(alvoAcc, `Foram removidos ${fmt(valor)} por um Admin.`);
  saveEcoData();
  return interaction.reply({ content: `✅ Removidos **${fmt(valor)}** da carteira de <@${alvo.id}>.`, allowedMentions: { parse: [] } });
}

async function handleCommand(interaction) {
  const name = interaction.commandName;
  if (!Object.hasOwn(COMMANDS, name)) return;
  const acc = NO_ACCOUNT.has(name) ? null : getUserAccount(interaction.user.id);
  return COMMANDS[name](interaction, acc, Date.now());
}

async function handleEconomyInteraction(interaction) {
  try {
    if (interaction.isButton()) return await handleButton(interaction);
    if (interaction.isChatInputCommand()) return await handleCommand(interaction);
  } catch (err) {
    console.error('[interação/economia]', err);
    try { await respond(interaction, eph('❌ Ocorreu um erro inesperado ao executar isso.')); } catch (_) { /* ignora */ }
  }
}

module.exports = { economySlashCommands, handledCommands, handleEconomyInteraction, startEconomyScheduler };
