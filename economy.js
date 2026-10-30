'use strict';

const { EmbedBuilder, SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { JsonStore } = require('./storage');
const { checkAccess } = require('./perms');
const { EPHEMERAL, ALL_AMOUNT, HALF_AMOUNT, eph, truncate, normalize, fmtDate, unix, randInt, respond, describeError } = require('./utils');

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
  gamble: { winChance: 0.46, coinflipChance: 0.46, luckBonus: 0.03 }, // com o Amuleto (+3%) o máximo é 49%: a banca sempre ganha no longo prazo
  lottery: { price: 5000, chance: 0.02, prize: 200000 },
  loan: { base: 500000, perLevel: 100000, interest: 0.2, garnish: 0.3 }, // garnish: % dos ganhos que vai direto para a dívida
  crime: { cooldown: 3 * MINUTE, baseChance: 0.45, min: 15000, max: 60000, fineMin: 10000, fineMax: 25000 },
  rob: { cooldown: 5 * MINUTE, baseChance: 0.4, minTarget: 5000, minPct: 0.1, maxPct: 0.3, cap: 150000, fineMin: 8000, fineMax: 20000 },
  sellRate: 0.5,             // /vender devolve 50% do preço
  caixa: { price: 50000 },
  business: { max: 3, capHours: 24 }
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
      { id: 'moto', nome: 'Moto Esportiva', preco: 350000, label: 'Moto (🪙 350k)' },
      { id: 'desportivo', nome: 'Carro Desportivo', preco: 1200000, label: 'Desportivo (🪙 1.2M)' },
      { id: 'supercarro', nome: 'Supercarro Luxo', preco: 4500000, label: 'Supercarro (🪙 4.5M)' }
    ]
  },
  casas: {
    titulo: '🏡 **Escolhe o teu imóvel:**', style: ButtonStyle.Primary, itens: [
      { id: 'kitnet', nome: 'Kitnet Central', preco: 250000, label: 'Kitnet (🪙 250k)' },
      { id: 'apartamento', nome: 'Apartamento de Luxo', preco: 1800000, label: 'Apartamento (🪙 1.8M)' },
      { id: 'mansao', nome: 'Mansao com Piscina', preco: 12000000, label: 'Mansão (🪙 12M)' }
    ]
  },
  celulares: {
    titulo: '📱 **Escolhe o teu telemóvel:**', style: ButtonStyle.Primary, itens: [
      { id: 'basico', nome: 'Smartphone Basico', preco: 15000, label: 'Básico (🪙 15k)' },
      { id: 'promax', nome: 'Smartphone Pro Max', preco: 85000, label: 'Pro Max (🪙 85k)' },
      { id: 'gold', nome: 'Edicao Limitada Ouro', preco: 300000, label: 'Gold (🪙 300k)' }
    ]
  },
  cargos: {
    titulo: '👑 **Escolhe o teu cargo VIP:**', style: ButtonStyle.Success, itens: [
      { id: 'vipbronze', nome: 'VIP Bronze (30d)', preco: 500000, label: 'VIP Bronze (🪙 500k)', vip: true },
      { id: 'vipprata', nome: 'VIP Prata (30d)', preco: 1500000, label: 'VIP Prata (🪙 1.5M)', vip: true },
      { id: 'vipouro', nome: 'VIP Ouro (30d)', preco: 5000000, label: 'VIP Ouro (🪙 5M)', vip: true }
    ]
  },
  upgrades: {
    titulo: '⚡ **Escolhe o teu upgrade:**', style: ButtonStyle.Success, itens: [
      { id: 'renda', nome: 'Upgrade Renda Nv2', preco: 200000, label: 'Renda Nv2 (🪙 200k)', unico: true },
      { id: 'fuga', nome: 'Kit Fuga Rapida', preco: 450000, label: 'Kit Fuga (🪙 450k)', unico: true },
      { id: 'sorte', nome: 'Amuleto da Sorte', preco: 800000, label: 'Sorte (🪙 800k)', unico: true }
    ]
  },
  armamento: {
    titulo: '🔫 **Escolhe o teu armamento:**', style: ButtonStyle.Danger, itens: [
      { id: 'kitleve', nome: 'Kit Tatico Leve', preco: 150000, label: 'Kit Leve (🪙 150k)', unico: true },
      { id: 'kitpesado', nome: 'Kit Tatico Pesado', preco: 600000, label: 'Kit Pesado (🪙 600k)', unico: true }
    ]
  }
};

const ITEMS = {};
for (const [categoria, cat] of Object.entries(CATALOG)) {
  for (const item of cat.itens) ITEMS[item.id] = { ...item, categoria };
}

const PROFESSIONS = {
  entregador: { nome: 'Entregador', emoji: '🛵', nivel: 1, mult: 1.0 },
  vendedor: { nome: 'Vendedor', emoji: '🛍️', nivel: 3, mult: 1.2 },
  programador: { nome: 'Programador', emoji: '💻', nivel: 6, mult: 1.5 },
  medico: { nome: 'Médico', emoji: '🩺', nivel: 10, mult: 1.9 },
  empresario: { nome: 'Empresário', emoji: '🕴️', nivel: 15, mult: 2.4 }
};

const BUSINESSES = {
  barraca: { nome: 'Barraca de Lanches', emoji: '🌭', preco: 800000, renda: 8000 },
  lanchonete: { nome: 'Lanchonete', emoji: '🍔', preco: 3000000, renda: 35000 },
  loja: { nome: 'Loja de Roupas', emoji: '👕', preco: 12000000, renda: 150000 },
  fabrica: { nome: 'Fábrica', emoji: '🏭', preco: 50000000, renda: 650000 }
};

const CAIXA_PRIZES = [
  { chance: 0.55, min: 8000, max: 20000, texto: 'Só uns trocados...' },
  { chance: 0.28, min: 25000, max: 45000, texto: 'Nada mal!' },
  { chance: 0.12, min: 50000, max: 90000, texto: 'Boa sorte hoje! 🍀' },
  { chance: 0.045, min: 120000, max: 250000, texto: 'Que achado! 💰' },
  { chance: 0.005, min: 1000000, max: 1000000, texto: '🌟 **PRÊMIO LENDÁRIO!** 🌟' }
];

/* ============================================================
 *  COMANDOS SLASH
 * ============================================================ */
const valorOpt = (desc = 'Valor') => (o) => o.setName('valor').setDescription(desc).setRequired(true).setMinValue(1);

const economySlashCommands = [
  new SlashCommandBuilder().setName('saldo').setDescription('Consulta o teu património e extrato').addUserOption(o => o.setName('usuario').setDescription('Membro').setRequired(false)),
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
  new SlashCommandBuilder().setName('apostar').setDescription('Aposta dinheiro na sorte (ou desafie alguém para um duelo 50/50)').addIntegerOption(valorOpt()).addUserOption(o => o.setName('usuario').setDescription('Desafiar esta pessoa para um duelo valendo o mesmo valor').setRequired(false)),
  new SlashCommandBuilder().setName('coinflip').setDescription('Joga cara ou coroa apostando').addStringOption(o => o.setName('escolha').setDescription('cara ou coroa').setRequired(true).addChoices({ name: 'Cara', value: 'cara' }, { name: 'Coroa', value: 'coroa' })).addIntegerOption(valorOpt()),
  new SlashCommandBuilder().setName('slots').setDescription('Joga na máquina caça-níqueis').addIntegerOption(valorOpt()),
  new SlashCommandBuilder().setName('roleta').setDescription('Aposta na roleta da sorte').addStringOption(o => o.setName('cor').setDescription('vermelho, preto ou verde').setRequired(true).addChoices({ name: 'Vermelho', value: 'vermelho' }, { name: 'Preto', value: 'preto' }, { name: 'Verde', value: 'verde' })).addIntegerOption(valorOpt()),

  new SlashCommandBuilder().setName('loja').setDescription('Mostra o painel interativo da lojinha e do mercado'),
  new SlashCommandBuilder().setName('inventario').setDescription('Mostra os itens que tens guardados'),

  new SlashCommandBuilder().setName('investir').setDescription('Aplica dinheiro em fundos de investimento variados').addStringOption(o => o.setName('opcao').setDescription('Tipo de investimento').setRequired(true).addChoices(
    { name: 'Criptomoedas (Alto Risco) - 🪙 50.000', value: 'crypto' },
    { name: 'Tesouro Direto (Baixo Risco) - 🪙 20.000', value: 'tesouro' },
    { name: 'Ações da Bolsa (Médio Risco) - 🪙 35.000', value: 'acoes' }
  )),
  new SlashCommandBuilder().setName('emprestimo').setDescription('Pede um empréstimo ao banco').addIntegerOption(valorOpt()),
  new SlashCommandBuilder().setName('pagar').setDescription('Paga a tua dívida do empréstimo').addIntegerOption(valorOpt('Quanto pagar')),
  new SlashCommandBuilder().setName('loteria').setDescription('Compra um bilhete de loteria por 🪙 5.000'),

  new SlashCommandBuilder().setName('addmoney').setDescription('[DONO] Adiciona dinheiro a um usuário').addUserOption(o => o.setName('usuario').setDescription('Alvo').setRequired(true)).addIntegerOption(valorOpt()),
  new SlashCommandBuilder().setName('removemoney').setDescription('[DONO] Remove dinheiro de um usuário').addUserOption(o => o.setName('usuario').setDescription('Alvo').setRequired(true)).addIntegerOption(valorOpt()),

  // ---- Novidades da economia ----
  new SlashCommandBuilder().setName('vender').setDescription('Vende um item do teu inventário por 50% do preço').addStringOption(o => o.setName('item').setDescription('Item a vender').setRequired(true).setAutocomplete(true)),
  new SlashCommandBuilder().setName('cooldowns').setDescription('Mostra quando podes usar cada comando de ganho'),
  new SlashCommandBuilder().setName('profissao').setDescription('Escolhe a tua profissão (mais nível = mais ganhos)').addStringOption(o => o.setName('escolha').setDescription('Nova profissão (vazio = ver a lista)').setRequired(false).addChoices(
    ...Object.entries(PROFESSIONS).map(([id, p]) => ({ name: `${p.nome} (nível ${p.nivel}+)`, value: id }))
  )),
  new SlashCommandBuilder().setName('negocios').setDescription('Compra negócios que rendem dinheiro por hora'),
  new SlashCommandBuilder().setName('coletar').setDescription('Coleta o rendimento acumulado dos teus negócios'),
  new SlashCommandBuilder().setName('caixa').setDescription('Abre uma caixa misteriosa por 🪙 50.000'),
  new SlashCommandBuilder().setName('blackjack').setDescription('Joga blackjack contra o dealer').addIntegerOption(valorOpt('Aposta'))
];

/* ============================================================
 *  DADOS
 * ============================================================ */
const ecoStore = new JsonStore('economy_data.json', { pretty: false });
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
  vips: [],
  customRoles: {},
  rolePasses: {},
  profession: 'entregador',
  businesses: {},
  lastCollect: 0,
  protectedUntil: 0
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

const fmt = (n) => `🪙 ${Math.floor(n).toLocaleString('pt-BR')}`;
const credit = (acc, value) => { acc.wallet = Math.min(MAX_BALANCE, acc.wallet + Math.floor(value)); };
const has = (acc, nome) => acc.inventory.includes(nome);
const luck = (acc) => (has(acc, 'Amuleto da Sorte') ? ECONOMY.gamble.luckBonus : 0);
const netWorth = (acc) => (acc.wallet || 0) + (acc.bank || 0) - (acc.debt || 0);
const ITEM_LIST = Object.values(ITEMS);

/** Recebe um ganho; se há dívida, uma parte vai direto para pagá-la. Devolve quanto foi para a dívida. */
function earn(acc, valor) {
  const pago = acc.debt > 0 ? Math.min(acc.debt, Math.floor(valor * ECONOMY.loan.garnish)) : 0;
  if (pago > 0) acc.debt -= pago;
  credit(acc, valor - pago);
  return pago;
}
/** Dá um ganho a um usuário (parte vai para a dívida, se houver). Devolve quanto foi para a dívida. */
function earnMoney(userId, valor, nota) {
  const acc = getUserAccount(userId);
  const pago = earn(acc, valor);
  if (nota) addExtrato(acc, `${nota} (+${fmt(valor)})`);
  saveEcoData();
  return pago;
}
const debtNote = (pago) => (pago > 0 ? `\n🏦 ${fmt(pago)} (${Math.round(ECONOMY.loan.garnish * 100)}%) foram direto para pagar a sua dívida.` : '');

/** Debita da carteira e, se faltar, do banco. Devolve false se o total não chega. */
function chargeUser(userId, valor, nota) {
  const acc = getUserAccount(userId);
  if (acc.wallet + acc.bank < valor) return false;
  const daCarteira = Math.min(acc.wallet, valor);
  acc.wallet -= daCarteira;
  acc.bank -= valor - daCarteira;
  if (nota) addExtrato(acc, `${nota} (-${fmt(valor)})`);
  saveEcoData();
  return true;
}

/** Lê o "valor" do comando. Pelo prefixo aceita "tudo" e "metade" (relativos a `max`). */
function resolveAmount(interaction, max) {
  const v = interaction.options.getInteger('valor');
  if (v === ALL_AMOUNT) return max;
  if (v === HALF_AMOUNT) return Math.floor(max / 2);
  return v;
}

/** Dá dinheiro a alguém (usado por outros módulos, ex.: bónus de nível). */
function giveMoney(userId, valor, nota) {
  const acc = getUserAccount(userId);
  credit(acc, valor);
  if (nota) addExtrato(acc, `${nota} (+${fmt(valor)})`);
  saveEcoData();
}

const businessRate = (acc) => Object.entries(acc.businesses || {}).reduce((sum, [id, n]) => sum + (BUSINESSES[id]?.renda || 0) * n, 0);

function pendingBusiness(acc, now) {
  const rate = businessRate(acc);
  if (!rate || !acc.lastCollect) return 0;
  const horas = Math.min(ECONOMY.business.capHours, (now - acc.lastCollect) / (60 * MINUTE));
  return Math.floor(rate * Math.max(0, horas));
}

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
/** Devolve null se ainda não deu 24h; senão, quanto do prémio foi para a dívida (0 se não há dívida). */
function claimDaily(acc, now, origem = '') {
  if (now - acc.lastDaily < DAY) return null;
  const pago = earn(acc, ECONOMY.daily);
  acc.lastDaily = now;
  addExtrato(acc, `Resgatou o Daily${origem} (${fmt(ECONOMY.daily)})`);
  saveEcoData();
  return pago;
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
  if (!['eco_', 'buy_', 'bj_', 'biz_', 'duel_'].some((prefix) => id.startsWith(prefix))) return;

  const acc = getUserAccount(interaction.user.id);
  const now = Date.now();

  if (id.startsWith('duel_')) return handleDuelButton(interaction);
  if (id.startsWith('bj_')) return handleBlackjackButton(interaction);
  if (id.startsWith('biz_')) return buyBusiness(interaction, acc, id.slice(4), now);
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
    const pago = claimDaily(acc, now, ' via Painel');
    if (pago === null) return interaction.reply(eph(`⏳ Você já resgatou o daily hoje! Volte <t:${unix(acc.lastDaily + DAY)}:R>.`));
    return interaction.reply(eph(`🎁 Você resgatou o daily de **${fmt(ECONOMY.daily)}**!${debtNote(pago)}`));
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
    const pago = earn(acc, ganho);
    addExtrato(acc, `${name}: +${fmt(ganho)}`);
    saveEcoData();
    const frase = act.frases[randInt(0, act.frases.length - 1)];
    return interaction.reply(`${act.emoji} ${frase} e obteve um lucro de **${fmt(ganho)}**!${debtNote(pago)}`);
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
      .setTitle(`💳 Património de ${alvo.tag} (ZapherCoin)`)
      .addFields(
        { name: '💵 Carteira', value: fmt(alvoAcc.wallet), inline: true },
        { name: '🏦 Banco', value: fmt(alvoAcc.bank), inline: true }
      );
    if (alvoAcc.debt > 0) embed.addFields({ name: '📉 Dívida', value: fmt(alvoAcc.debt), inline: true });
    embed.addFields({ name: '💎 Total', value: fmt(netWorth(alvoAcc)), inline: false });
    return interaction.reply({ embeds: [embed] });
  },

  async depositar(interaction, acc) {
    const valor = resolveAmount(interaction, acc.wallet);
    if (valor <= 0 || valor > acc.wallet) return interaction.reply(eph('❌ Valor inválido.'));
    acc.wallet -= valor;
    acc.bank = Math.min(MAX_BALANCE, acc.bank + valor);
    addExtrato(acc, `Depositou ${fmt(valor)} no banco.`);
    saveEcoData();
    return interaction.reply(`✅ Depositaste **${fmt(valor)}** no banco.`);
  },

  async sacar(interaction, acc) {
    const valor = resolveAmount(interaction, acc.bank);
    if (valor <= 0 || valor > acc.bank) return interaction.reply(eph('❌ Valor inválido.'));
    acc.bank -= valor;
    credit(acc, valor);
    addExtrato(acc, `Sacou ${fmt(valor)} do banco.`);
    saveEcoData();
    return interaction.reply(`✅ Sacaste **${fmt(valor)}** do banco.`);
  },

  async transferir(interaction, acc) {
    const alvo = interaction.options.getUser('usuario');
    const valor = resolveAmount(interaction, acc.wallet);
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
        { name: '💼 Profissão', value: `${(PROFESSIONS[acc.profession] || PROFESSIONS.entregador).emoji} ${(PROFESSIONS[acc.profession] || PROFESSIONS.entregador).nome}`, inline: true },
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
    const ordenados = Object.entries(data)
      .map(([id, a]) => ({ id, total: netWorth(a) }))
      .sort((a, b) => b.total - a.total);

    let sorted = ordenados.slice(0, 10);
    if (interaction.guild) {
      // A economia é global entre servidores: mostra só quem está NESTE servidor
      await interaction.deferReply();
      sorted = [];
      for (let i = 0; i < ordenados.length && i < 250 && sorted.length < 10; i += 25) {
        const lote = ordenados.slice(i, i + 25);
        const membros = await interaction.guild.members.fetch({ user: lote.map((x) => x.id) }).catch(() => null);
        for (const item of lote) if (membros?.has(item.id) && sorted.length < 10) sorted.push(item);
      }
    }
    if (sorted.length === 0) return respond(interaction, eph('📊 Sem registros.'));
    const desc = sorted.map((item, i) => {
      const med = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `**#${i + 1}**`;
      return `${med} <@${item.id}> — **${fmt(item.total)}**`;
    }).join('\n');
    return respond(interaction, { embeds: [new EmbedBuilder().setColor(0xF1C40F).setTitle('🏆 Top 10 Mais Ricos').setDescription(desc)], allowedMentions: { parse: [] } });
  },

  async extrato(interaction, acc) {
    const hist = acc.extrato.length ? acc.extrato.join('\n') : 'Sem movimentações.';
    return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x3498DB).setTitle('📄 Extrato').setDescription(hist)], flags: EPHEMERAL });
  },

  async daily(interaction, acc, now) {
    const pago = claimDaily(acc, now);
    if (pago === null) return interaction.reply(eph(`⏳ Você já resgatou o daily hoje! Volte <t:${unix(acc.lastDaily + DAY)}:R>.`));
    return interaction.reply(`🎁 Você resgatou o daily de **${fmt(ECONOMY.daily)}**!${debtNote(pago)}`);
  },

  async weekly(interaction, acc, now) {
    const semana = 7 * DAY;
    if (now - acc.lastWeekly < semana) return interaction.reply(eph(`⏳ Já resgataste o teu bónus semanal! Volta <t:${unix(acc.lastWeekly + semana)}:R>.`));
    const pago = earn(acc, ECONOMY.weekly);
    acc.lastWeekly = now;
    addExtrato(acc, `Resgatou o Weekly (${fmt(ECONOMY.weekly)})`);
    saveEcoData();
    return interaction.reply(`🎁 Você resgatou o bônus semanal de **${fmt(ECONOMY.weekly)}**!${debtNote(pago)}`);
  },

  async trabalhar(interaction, acc, now) {
    const rest = Math.max(0, acc.lastWork + ECONOMY.workCooldown - now);
    if (rest > 0) return interaction.reply(eph(`⏳ Descansa um pouco. ${waitMsg(rest)}`));
    acc.lastWork = now;
    const prof = PROFESSIONS[acc.profession] || PROFESSIONS.entregador;
    const ganho = Math.floor(randInt(ECONOMY.workMin, ECONOMY.workMax) * incomeMultiplier(acc) * prof.mult);
    const pago = earn(acc, ganho);
    let extra = '';
    if (Math.random() < ECONOMY.levelUpChance) {
      acc.jobLevel += 1;
      extra = `\n📈 Subiste para o **nível ${acc.jobLevel}** de trabalho! (+${Math.round(ECONOMY.levelBonus * 100)}% de ganhos)`;
    }
    addExtrato(acc, `Trabalhou e ganhou ${fmt(ganho)}`);
    saveEcoData();
    return interaction.reply(`${prof.emoji} Você trabalhou como **${prof.nome}** e ganhou **${fmt(ganho)}**!${extra}${debtNote(pago)}`);
  },

  async roubar(interaction, acc, now) {
    const alvo = interaction.options.getUser('usuario');
    if (alvo.id === interaction.user.id) return interaction.reply(eph('❌ Não podes roubar a ti próprio.'));
    if (alvo.bot) return interaction.reply(eph('❌ Bots não têm carteira para roubar.'));
    const rest = cdLeft(acc, 'roubar', ECONOMY.rob.cooldown, now);
    if (rest > 0) return interaction.reply(eph(waitMsg(rest)));

    const alvoAcc = getUserAccount(alvo.id);
    if (alvoAcc.protectedUntil > now) return interaction.reply(eph(`🛡️ ${alvo.tag} foi roubado há pouco e está protegido <t:${unix(alvoAcc.protectedUntil)}:R>.`));
    if (alvoAcc.wallet < ECONOMY.rob.minTarget) return interaction.reply(eph(`❌ ${alvo.tag} está com a carteira quase vazia, não compensa.`));
    startCd(acc, 'roubar', now);

    const chance = ECONOMY.rob.baseChance + (has(acc, 'Kit Tatico Leve') ? 0.05 : 0) + (has(acc, 'Kit Tatico Pesado') ? 0.12 : 0) + luck(acc);
    if (Math.random() < chance) {
      const pct = ECONOMY.rob.minPct + Math.random() * (ECONOMY.rob.maxPct - ECONOMY.rob.minPct);
      const roubado = Math.min(ECONOMY.rob.cap, Math.max(1, Math.floor(alvoAcc.wallet * pct)));
      alvoAcc.wallet -= roubado;
      alvoAcc.protectedUntil = now + 10 * MINUTE;
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
    const valor = resolveAmount(interaction, acc.wallet);
    if (valor <= 0 || valor > acc.wallet) return interaction.reply(eph('❌ Saldo insuficiente na carteira.'));
    const oponente = interaction.options.getUser('usuario');
    if (oponente) return startDuel(interaction, acc, oponente, valor); // /apostar valor @pessoa = duelo 50/50
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
    const valor = resolveAmount(interaction, acc.wallet);
    if (valor <= 0 || valor > acc.wallet) return interaction.reply(eph('❌ Saldo insuficiente na carteira.'));
    const ganhou = Math.random() < ECONOMY.gamble.coinflipChance + luck(acc);
    const resultado = ganhou ? escolha : (escolha === 'cara' ? 'coroa' : 'cara');
    if (ganhou) credit(acc, valor); else acc.wallet -= valor;
    saveEcoData();
    return interaction.reply(`🪙 Saiu **${resultado}**! ${ganhou ? `🎉 Ganhaste **${fmt(valor)}**.` : `💸 Perdeste **${fmt(valor)}**.`}`);
  },

  async slots(interaction, acc) {
    const valor = resolveAmount(interaction, acc.wallet);
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
    const valor = resolveAmount(interaction, acc.wallet);
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
    const valor = resolveAmount(interaction, acc.debt);
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

    if (Math.random() < chance + luck(acc) / 10) {
      credit(acc, prize);
      addExtrato(acc, `Ganhou na Loteria (${fmt(prize)})`);
      saveEcoData();
      return interaction.reply(`🎰 **JACKPOT! ACERTASTE NA LOTERIA!** Levaste o prémio máximo de **${fmt(prize)}** para casa!`);
    }
    saveEcoData();
    return interaction.reply('🎟️ Compraste o bilhete de loteria, mas infelizmente não foi desta vez que saíste premiado.');
  }
};

/* ============================================================
 *  NOVIDADES: vender, cooldowns, profissão, negócios, caixa e blackjack
 * ============================================================ */
const blackjackGames = new Map(); // userId -> jogo em andamento
const BJ_TIMEOUT = 60 * 1000;

const cardLabel = (c) => (c === 1 ? 'A' : c > 10 ? ['J', 'Q', 'K'][c - 11] : String(c));
const drawCard = () => randInt(1, 13);
const showHand = (hand) => hand.map((c) => `\`${cardLabel(c)}\``).join(' ');

function handValue(hand) {
  let total = 0;
  let aces = 0;
  for (const c of hand) {
    if (c === 1) { aces++; total += 11; } else total += Math.min(c, 10);
  }
  while (total > 21 && aces > 0) { total -= 10; aces--; }
  return total;
}

function bjEmbed(game, { reveal = false, resultado = null, color = 0x2C3E50 } = {}) {
  const dealer = reveal ? `${showHand(game.dealer)} (${handValue(game.dealer)})` : `${showHand([game.dealer[0]])} \`?\``;
  const embed = new EmbedBuilder().setColor(color).setTitle('🃏 Blackjack').addFields(
    { name: `Tua mão (${handValue(game.player)})`, value: showHand(game.player), inline: true },
    { name: 'Dealer', value: dealer, inline: true },
    { name: 'Aposta', value: fmt(game.bet), inline: true }
  );
  if (resultado) embed.setDescription(resultado);
  return embed;
}

const bjButtons = () => new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId('bj_hit').setLabel('🃏 Pedir carta').setStyle(ButtonStyle.Primary),
  new ButtonBuilder().setCustomId('bj_stand').setLabel('✋ Parar').setStyle(ButtonStyle.Success)
);

/** Encerra o jogo, paga o prémio e devolve o texto/cor do resultado. */
function bjFinish(userId, game, outcome) {
  clearTimeout(game.timer);
  blackjackGames.delete(userId);
  const acc = getUserAccount(userId);
  const bet = game.bet;
  const resultados = {
    blackjack: { pay: bet + Math.floor(bet * 1.5), texto: `🎉 **BLACKJACK!** Ganhaste **${fmt(Math.floor(bet * 1.5))}**!`, color: 0xF1C40F },
    win: { pay: bet * 2, texto: `🎉 Ganhaste **${fmt(bet)}**!`, color: 0x2ECC71 },
    push: { pay: bet, texto: '🤝 Empate! A tua aposta foi devolvida.', color: 0x95A5A6 },
    lose: { pay: 0, texto: `💸 Perdeste **${fmt(bet)}**.`, color: 0xE74C3C },
    bust: { pay: 0, texto: `💥 Estouraste! Perdeste **${fmt(bet)}**.`, color: 0xE74C3C },
    timeout: { pay: 0, texto: `⌛ Tempo esgotado! Perdeste **${fmt(bet)}**.`, color: 0x7F8C8D }
  };
  const r = resultados[outcome];
  if (r.pay > 0) credit(acc, r.pay);
  addExtrato(acc, `Blackjack (${outcome}): ${r.pay - bet >= 0 ? '+' : '-'}${fmt(Math.abs(r.pay - bet))}`);
  saveEcoData();
  return r;
}

function bjStartTimer(userId, game) {
  game.timer = setTimeout(() => {
    if (blackjackGames.get(userId) !== game) return;
    const r = bjFinish(userId, game, 'timeout');
    game.message?.edit({ embeds: [bjEmbed(game, { reveal: true, resultado: r.texto, color: r.color })], components: [] }).catch(() => {});
  }, BJ_TIMEOUT);
}

async function handleBlackjackButton(interaction) {
  const userId = interaction.user.id;
  const game = blackjackGames.get(userId);
  if (!game || (game.message && game.message.id !== interaction.message.id)) {
    return interaction.reply(eph('❌ Este jogo não é teu ou já terminou.'));
  }
  clearTimeout(game.timer);

  if (interaction.customId === 'bj_hit') {
    game.player.push(drawCard());
    const valor = handValue(game.player);
    if (valor > 21) {
      const r = bjFinish(userId, game, 'bust');
      return interaction.update({ embeds: [bjEmbed(game, { reveal: true, resultado: r.texto, color: r.color })], components: [] });
    }
    if (valor < 21) {
      bjStartTimer(userId, game);
      return interaction.update({ embeds: [bjEmbed(game)], components: [bjButtons()] });
    }
    // 21 exato: para automaticamente
  }

  while (handValue(game.dealer) < 17) game.dealer.push(drawCard());
  const p = handValue(game.player);
  const d = handValue(game.dealer);
  const outcome = d > 21 || p > d ? 'win' : p === d ? 'push' : 'lose';
  const r = bjFinish(userId, game, outcome);
  return interaction.update({ embeds: [bjEmbed(game, { reveal: true, resultado: r.texto, color: r.color })], components: [] });
}

async function buyBusiness(interaction, acc, id, now) {
  const b = BUSINESSES[id];
  if (!b) return interaction.reply(eph('❌ Este menu expirou. Usa `/negocios` novamente.'));
  const tem = acc.businesses[id] || 0;
  if (tem >= ECONOMY.business.max) return interaction.reply(eph(`❌ Já tens o máximo de **${ECONOMY.business.max}** ${b.nome}.`));
  if (acc.wallet < b.preco) return interaction.reply(eph(`❌ Precisas de **${fmt(b.preco)}** na carteira (tens ${fmt(acc.wallet)}).`));

  const pendente = pendingBusiness(acc, now); // liquida o que já tinha acumulado antes de mudar a renda
  if (pendente > 0) credit(acc, pendente);
  acc.wallet -= b.preco;
  acc.businesses[id] = tem + 1;
  acc.lastCollect = now;
  addExtrato(acc, `Comprou ${b.nome} por ${fmt(b.preco)}`);
  saveEcoData();
  return interaction.reply(eph(`✅ Compraste **${b.nome}** ${b.emoji} por **${fmt(b.preco)}**!${pendente > 0 ? `\n💰 Também coletei ${fmt(pendente)} que já tinhas acumulado.` : ''}`));
}

/* ---------- Duelo entre jogadores (/apostar valor @pessoa) ---------- */
const DUEL_FEE = 0.05; // 5% do valor some (taxa da casa)
const duelsDone = new Set();

async function startDuel(interaction, acc, oponente, valor) {
  if (oponente.id === interaction.user.id) return interaction.reply(eph('❌ Você não pode duelar contra si mesmo.'));
  if (oponente.bot) return interaction.reply(eph('❌ Bots não duelam.'));
  const alvoAcc = getUserAccount(oponente.id);
  if (alvoAcc.wallet < valor) return interaction.reply(eph(`❌ ${oponente.tag} não tem ${fmt(valor)} na carteira para cobrir a aposta.`));

  const dados = `${interaction.user.id}:${oponente.id}:${valor}`;
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`duel_y:${dados}`).setLabel('Aceitar duelo').setEmoji('⚔️').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`duel_n:${dados}`).setLabel('Recusar').setStyle(ButtonStyle.Secondary)
  );
  await interaction.reply({
    content: `⚔️ <@${oponente.id}>, <@${interaction.user.id}> desafiou você para um duelo valendo **${fmt(valor)}**! (vale por 60 segundos)`,
    components: [row],
    allowedMentions: { users: [oponente.id] }
  });
  const msg = await interaction.fetchReply().catch(() => null);
  if (msg) {
    setTimeout(() => {
      if (duelsDone.has(msg.id)) return;
      duelsDone.add(msg.id);
      msg.edit({ content: '⌛ O duelo expirou.', components: [] }).catch(() => {});
    }, 60000);
  }
}

async function handleDuelButton(interaction) {
  const [kind, desafianteId, alvoId, valorTxt] = interaction.customId.split(':');
  const valor = Number(valorTxt);
  if (interaction.user.id !== alvoId) return interaction.reply(eph('❌ Só quem foi desafiado pode responder.'));
  if (duelsDone.has(interaction.message.id)) return interaction.reply(eph('⌛ Este duelo já terminou.'));
  duelsDone.add(interaction.message.id);

  if (kind === 'duel_n') return interaction.update({ content: `🏳️ <@${alvoId}> recusou o duelo.`, components: [], allowedMentions: { parse: [] } });

  const a = getUserAccount(desafianteId);
  const b = getUserAccount(alvoId);
  if (a.wallet < valor || b.wallet < valor) {
    return interaction.update({ content: '❌ Alguém não tem mais saldo suficiente. Duelo cancelado.', components: [] });
  }
  const venceuDesafiante = Math.random() < 0.5;
  const [vencedor, perdedor, vencedorId, perdedorId] = venceuDesafiante ? [a, b, desafianteId, alvoId] : [b, a, alvoId, desafianteId];
  const ganho = Math.floor(valor * (1 - DUEL_FEE));
  perdedor.wallet -= valor;
  credit(vencedor, ganho);
  addExtrato(vencedor, `Venceu um duelo: +${fmt(ganho)}`);
  addExtrato(perdedor, `Perdeu um duelo: -${fmt(valor)}`);
  saveEcoData();
  return interaction.update({
    content: `⚔️ **Duelo!** <@${vencedorId}> venceu <@${perdedorId}> e levou **${fmt(ganho)}** (taxa de ${Math.round(DUEL_FEE * 100)}%)!`,
    components: [],
    allowedMentions: { users: [vencedorId, perdedorId] }
  });
}

async function handleAutocomplete(interaction) {
  if (interaction.commandName !== 'vender') return;
  const acc = getUserAccount(interaction.user.id);
  const foco = normalize(interaction.options.getFocused());
  const itens = [...new Set(acc.inventory)]
    .map((nome) => ITEM_LIST.find((i) => i.nome === nome))
    .filter((i) => i && !i.vip && normalize(i.nome).includes(foco))
    .slice(0, 25);
  await interaction.respond(itens.map((i) => ({ name: truncate(`${i.nome} — ${fmt(i.preco * ECONOMY.sellRate)}`, 100), value: i.nome })));
}

Object.assign(COMMANDS, {
  async vender(interaction, acc) {
    const nome = interaction.options.getString('item');
    const item = ITEM_LIST.find((i) => normalize(i.nome) === normalize(nome || ''));
    if (!item || !has(acc, item.nome)) return interaction.reply(eph('❌ Não tens esse item. Vê o teu `/inventario`.'));
    if (item.vip) return interaction.reply(eph('❌ Cargos VIP não podem ser vendidos.'));

    const valor = Math.floor(item.preco * ECONOMY.sellRate);
    acc.inventory.splice(acc.inventory.indexOf(item.nome), 1);
    credit(acc, valor);
    addExtrato(acc, `Vendeu ${item.nome} por ${fmt(valor)}`);
    saveEcoData();
    return interaction.reply(`💰 Vendeste **${item.nome}** por **${fmt(valor)}** (${Math.round(ECONOMY.sellRate * 100)}% do valor).`);
  },

  async cooldowns(interaction, acc, now) {
    const linha = (nome, ate) => (ate <= now ? `✅ **${nome}** — pronto` : `⏳ **${nome}** — <t:${unix(ate)}:R>`);
    const linhas = [
      linha('/daily', acc.lastDaily + DAY),
      linha('/weekly', acc.lastWeekly + 7 * DAY),
      linha('/trabalhar', acc.lastWork + ECONOMY.workCooldown),
      ...Object.entries(ACTIVITIES).map(([nome, a]) => linha(`/${nome}`, (acc.cooldowns[nome] || 0) + a.cooldown)),
      linha('/crime', (acc.cooldowns.crime || 0) + ECONOMY.crime.cooldown),
      linha('/roubar', (acc.cooldowns.roubar || 0) + ECONOMY.rob.cooldown)
    ];
    if (businessRate(acc) > 0) linhas.push(`🏭 **/coletar** — ${fmt(pendingBusiness(acc, now))} acumulados`);
    const embed = new EmbedBuilder().setColor(0x3498DB).setTitle('⏱️ Os teus cooldowns').setDescription(linhas.join('\n'));
    return interaction.reply({ embeds: [embed], flags: EPHEMERAL });
  },

  async profissao(interaction, acc) {
    const escolha = interaction.options.getString('escolha');
    if (!escolha) {
      const lista = Object.entries(PROFESSIONS)
        .map(([id, p]) => `${p.emoji} **${p.nome}** — nível ${p.nivel}+ — ganhos ×${p.mult}${acc.profession === id ? ' ✅ (atual)' : ''}`)
        .join('\n');
      const embed = new EmbedBuilder().setColor(0x9B59B6).setTitle('💼 Profissões')
        .setDescription(`${lista}\n\nO teu nível de trabalho: **${acc.jobLevel}** (sobe com \`/trabalhar\`).\nEscolhe com \`/profissao escolha:...\``);
      return interaction.reply({ embeds: [embed], flags: EPHEMERAL });
    }
    const prof = PROFESSIONS[escolha];
    if (!prof) return interaction.reply(eph('❌ Profissão inválida.'));
    if (acc.jobLevel < prof.nivel) return interaction.reply(eph(`❌ Precisas do nível **${prof.nivel}** de trabalho (tens ${acc.jobLevel}). Sobe com \`/trabalhar\`.`));
    acc.profession = escolha;
    saveEcoData();
    return interaction.reply(`${prof.emoji} Agora és **${prof.nome}**! Os teus ganhos no \`/trabalhar\` são ×${prof.mult}.`);
  },

  async negocios(interaction, acc, now) {
    const linhas = Object.entries(BUSINESSES)
      .map(([id, b]) => `${b.emoji} **${b.nome}** — ${fmt(b.preco)} • rende ${fmt(b.renda)}/h • tens **${acc.businesses[id] || 0}/${ECONOMY.business.max}**`)
      .join('\n');
    const embed = new EmbedBuilder().setColor(0xE67E22).setTitle('🏢 Negócios')
      .setDescription(`${linhas}\n\nO rendimento acumula até **${ECONOMY.business.capHours}h**. Coleta com \`/coletar\`.`)
      .addFields(
        { name: '📈 Renda por hora', value: fmt(businessRate(acc)), inline: true },
        { name: '💰 Acumulado agora', value: fmt(pendingBusiness(acc, now)), inline: true }
      );
    const row = new ActionRowBuilder().addComponents(
      Object.entries(BUSINESSES).map(([id, b]) => new ButtonBuilder().setCustomId(`biz_${id}`).setLabel(`${b.emoji} ${b.nome}`).setStyle(ButtonStyle.Success))
    );
    return interaction.reply({ embeds: [embed], components: [row], flags: EPHEMERAL });
  },

  async coletar(interaction, acc, now) {
    if (businessRate(acc) <= 0) return interaction.reply(eph('❌ Não tens nenhum negócio. Compra um em `/negocios`.'));
    const valor = pendingBusiness(acc, now);
    if (valor < 1) return interaction.reply(eph('⏳ Os teus negócios ainda não produziram nada. Volta daqui a pouco.'));
    const pago = earn(acc, valor);
    acc.lastCollect = now;
    addExtrato(acc, `Coletou ${fmt(valor)} dos negócios`);
    saveEcoData();
    return interaction.reply(`🏭 Você coletou **${fmt(valor)}** dos seus negócios!${debtNote(pago)}`);
  },

  async caixa(interaction, acc) {
    const preco = ECONOMY.caixa.price;
    if (acc.wallet < preco) return interaction.reply(eph(`❌ Uma caixa misteriosa custa ${fmt(preco)}.`));
    acc.wallet -= preco;

    let roll = Math.random();
    let premio = CAIXA_PRIZES[0];
    for (const p of CAIXA_PRIZES) {
      if (roll < p.chance) { premio = p; break; }
      roll -= p.chance;
    }
    const valor = randInt(premio.min, premio.max);
    credit(acc, valor);
    addExtrato(acc, `Abriu uma caixa misteriosa: ${fmt(valor)}`);
    saveEcoData();
    return interaction.reply(`📦 Abriste uma caixa misteriosa e encontraste **${fmt(valor)}**! ${premio.texto}`);
  },

  async blackjack(interaction, acc) {
    const userId = interaction.user.id;
    if (blackjackGames.has(userId)) return interaction.reply(eph('❌ Já tens um jogo de blackjack em andamento.'));
    const valor = resolveAmount(interaction, acc.wallet);
    if (!valor || valor <= 0 || valor > acc.wallet) return interaction.reply(eph('❌ Saldo insuficiente na carteira.'));

    acc.wallet -= valor;
    saveEcoData();
    const game = { bet: valor, player: [drawCard(), drawCard()], dealer: [drawCard(), drawCard()], message: null, timer: null };

    if (handValue(game.player) === 21) {
      const r = bjFinish(userId, game, handValue(game.dealer) === 21 ? 'push' : 'blackjack');
      return interaction.reply({ embeds: [bjEmbed(game, { reveal: true, resultado: r.texto, color: r.color })] });
    }

    blackjackGames.set(userId, game);
    await interaction.reply({ embeds: [bjEmbed(game)], components: [bjButtons()] });
    game.message = await interaction.fetchReply().catch(() => null);
    bjStartTimer(userId, game);
  }
});

COMMANDS.loja = COMMANDS.mercado;
for (const name of Object.keys(ACTIVITIES)) COMMANDS[name] = activityCommand(name);

// Comandos que não precisam de conta (não cria registro à toa)
const NO_ACCOUNT = new Set(['loja', 'addmoney', 'removemoney', 'saldo', 'rank']);

const handledCommands = Object.keys(COMMANDS);

function inventoryText(acc) {
  if (!acc.inventory.length) return 'Nenhum bem adquirido';
  const contagem = new Map();
  for (const nome of acc.inventory) contagem.set(nome, (contagem.get(nome) || 0) + 1);
  return [...contagem].map(([nome, qtd]) => (qtd > 1 ? `${nome} ×${qtd}` : nome)).join(', ');
}

async function adminMoney(interaction, adicionar) {
  const { options } = interaction;
  // A economia é global entre servidores: só o dono do bot pode criar/remover dinheiro
  const negado = checkAccess(interaction, { strict: true });
  if (negado) return interaction.reply(eph(negado));
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
    if (interaction.isAutocomplete()) return await handleAutocomplete(interaction);
    if (interaction.isButton()) return await handleButton(interaction);
    if (interaction.isChatInputCommand()) return await handleCommand(interaction);
  } catch (err) {
    console.error('[interação/economia]', err);
    try { const aviso = describeError(err); if (aviso) await respond(interaction, eph(aviso)); } catch (_) { /* ignora */ }
  }
}

module.exports = { economySlashCommands, handledCommands, handleEconomyInteraction, startEconomyScheduler, giveMoney, earnMoney, chargeUser, getUserAccount, saveEcoData, fmt };
