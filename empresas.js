'use strict';

/**
 * /empresa — o dono cria uma empresa, contrata pessoas e divide o lucro.
 *
 *   criar <nome>     paga o preço e abre a empresa
 *   contratar @pessoa   a pessoa recebe um convite e precisa ACEITAR
 *   trabalhar        (dono ou funcionário) gera receita a cada 10 min:
 *                      • funcionário recebe o seu % de salário na hora
 *                      • o resto vai para o COFRE da empresa
 *   coletar          o dono retira o cofre para a própria carteira
 *   salario <5-70>   % da receita que cada funcionário recebe
 *   melhorar         +vaga de funcionário e +receita
 *   demitir / sair / info / fechar
 */

const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, SlashCommandBuilder } = require('discord.js');
const { JsonStore } = require('./storage');
const { CURRENCY_NAME, eph, normalize, truncate, unix, randInt, respond, describeError } = require('./utils');
const { chargeUser, earnMoney, getUserAccount, fmt } = require('./economy');

const CFG = {
  createCost: 5_000_000,
  upgradeCost: 3_000_000,   // x nível atual
  baseCap: 3,               // funcionários no nível 1
  capPerLevel: 2,
  maxLevel: 10,
  workCooldown: 10 * 60_000,
  revenueMin: 15_000,
  revenueMax: 40_000,
  revenuePerLevel: 0.15,    // +15% de receita por nível
  defaultSalary: 30,
  minSalary: 5,
  maxSalary: 70,
  inviteTTL: 60_000
};

/** { [donoId]: { nome, criadoEm, nivel, salario, cofre, receitaTotal, empregados: [ids], lastWork: { [id]: ts } } } */
const store = new JsonStore('companies.json', { pretty: false });
const companies = store.data;

const capacity = (c) => CFG.baseCap + (c.nivel - 1) * CFG.capPerLevel;
const sanitizeName = (t) => String(t ?? '').replace(/[@`\n\r*_~|>]/g, '').replace(/\s+/g, ' ').trim();

/** Em qual empresa a pessoa está? { ownerId, company, dono } ou null */
function membershipOf(userId) {
  if (companies[userId]) return { ownerId: userId, company: companies[userId], dono: true };
  for (const [ownerId, company] of Object.entries(companies)) {
    if (company.empregados.includes(userId)) return { ownerId, company, dono: false };
  }
  return null;
}

/* ============================================================
 *  COMANDO
 * ============================================================ */
const empresasSlashCommands = [
  new SlashCommandBuilder().setName('empresa').setDescription('Crie uma empresa, contrate pessoas e divida os lucros')
    .addStringOption(o => o.setName('acao').setDescription('O que fazer').setRequired(true).addChoices(
      { name: 'Criar empresa', value: 'criar' },
      { name: 'Ver informações', value: 'info' },
      { name: 'Contratar alguém (dono)', value: 'contratar' },
      { name: 'Demitir alguém (dono)', value: 'demitir' },
      { name: 'Sair da empresa', value: 'sair' },
      { name: 'Trabalhar na empresa', value: 'trabalhar' },
      { name: 'Coletar o cofre (dono)', value: 'coletar' },
      { name: 'Definir % de salário (dono)', value: 'salario' },
      { name: 'Melhorar a empresa (dono)', value: 'melhorar' },
      { name: 'Fechar a empresa (dono)', value: 'fechar' }
    ))
    .addUserOption(o => o.setName('usuario').setDescription('Pessoa (para contratar, demitir ou ver a empresa dela)').setRequired(false))
    .addIntegerOption(o => o.setName('valor').setDescription('% de salário dos funcionários (5 a 70), ao usar "salario"').setRequired(false).setMinValue(1).setMaxValue(100))
    .addStringOption(o => o.setName('nome').setDescription('Nome da empresa, ao usar "criar"').setRequired(false).setMaxLength(30))
];

const ownerOnly = (m) => (!m ? '❌ Você não tem uma empresa. Crie uma com `/empresa criar`.' : !m.dono ? '❌ Só o dono da empresa pode fazer isso.' : null);

const ACTIONS = {
  async criar(interaction) {
    const nome = sanitizeName(interaction.options.getString('nome'));
    if (nome.length < 3 || nome.length > 30) return interaction.reply(eph('❌ Informe o nome da empresa (3 a 30 caracteres). Ex.: `/empresa criar nome:Minha Loja`'));
    if (membershipOf(interaction.user.id)) return interaction.reply(eph('❌ Você já faz parte de uma empresa. Saia dela antes de criar outra.'));
    if (Object.values(companies).some((c) => normalize(c.nome) === normalize(nome))) return interaction.reply(eph('❌ Já existe uma empresa com esse nome.'));

    if (!chargeUser(interaction.user.id, CFG.createCost, `Abriu a empresa ${nome}`)) {
      const acc = getUserAccount(interaction.user.id);
      return interaction.reply(eph(`❌ Abrir uma empresa custa **${fmt(CFG.createCost)} ${CURRENCY_NAME}** (carteira + banco) e você tem **${fmt(acc.wallet + acc.bank)}**.`));
    }
    companies[interaction.user.id] = { nome, criadoEm: Date.now(), nivel: 1, salario: CFG.defaultSalary, cofre: 0, receitaTotal: 0, empregados: [], lastWork: {} };
    store.save();
    return interaction.reply(`🏢 **${nome}** foi aberta! Contrate pessoas com \`/empresa contratar\` e use \`/empresa trabalhar\` para gerar receita.`);
  },

  async info(interaction) {
    const alvo = interaction.options.getUser('usuario') || interaction.user;
    const m = membershipOf(alvo.id);
    if (!m) return interaction.reply(eph(alvo.id === interaction.user.id ? '❌ Você não faz parte de nenhuma empresa.' : `❌ ${alvo.tag} não faz parte de nenhuma empresa.`));
    const c = m.company;
    const lista = c.empregados.length ? c.empregados.map((id) => `<@${id}>`).join(', ') : '*ninguém ainda*';
    const embed = new EmbedBuilder().setColor(0x2980B9).setTitle(`🏢 ${c.nome}`)
      .addFields(
        { name: '👑 Dono', value: `<@${m.ownerId}>`, inline: true },
        { name: '📈 Nível', value: `${c.nivel}/${CFG.maxLevel}`, inline: true },
        { name: '💼 Salário', value: `${c.salario}% da receita`, inline: true },
        { name: `👥 Funcionários (${c.empregados.length}/${capacity(c)})`, value: truncate(lista, 1000) },
        { name: '💰 Cofre', value: fmt(c.cofre), inline: true },
        { name: '📊 Receita total', value: fmt(c.receitaTotal), inline: true }
      );
    const meu = membershipOf(interaction.user.id);
    if (meu && meu.ownerId === m.ownerId) {
      const prox = (c.lastWork[interaction.user.id] || 0) + CFG.workCooldown;
      embed.setFooter({ text: prox > Date.now() ? 'Você poderá trabalhar de novo em alguns minutos' : 'Você já pode trabalhar na empresa!' });
    }
    return interaction.reply({ embeds: [embed], allowedMentions: { parse: [] } });
  },

  async contratar(interaction) {
    const m = membershipOf(interaction.user.id);
    const erro = ownerOnly(m);
    if (erro) return interaction.reply(eph(erro));
    const alvo = interaction.options.getUser('usuario');
    if (!alvo) return interaction.reply(eph('❌ Marque quem você quer contratar: `/empresa contratar usuario:@pessoa`'));
    if (alvo.id === interaction.user.id) return interaction.reply(eph('❌ Você já é o dono.'));
    if (alvo.bot) return interaction.reply(eph('❌ Bots não trabalham em empresas.'));
    if (membershipOf(alvo.id)) return interaction.reply(eph(`❌ ${alvo.tag} já faz parte de uma empresa.`));
    if (m.company.empregados.length >= capacity(m.company)) {
      return interaction.reply(eph(`❌ A empresa está lotada (${capacity(m.company)} vagas). Use \`/empresa melhorar\` para abrir mais vagas.`));
    }

    const dados = `${interaction.user.id}:${alvo.id}`;
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`emp_y:${dados}`).setLabel('Aceitar').setEmoji('✅').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`emp_n:${dados}`).setLabel('Recusar').setStyle(ButtonStyle.Secondary)
    );
    await interaction.reply({
      content: `💼 <@${alvo.id}>, <@${interaction.user.id}> quer contratar você na empresa **${m.company.nome}** (salário: ${m.company.salario}% da receita que você gerar). Aceita?`,
      components: [row],
      allowedMentions: { users: [alvo.id] }
    });
    const msg = await interaction.fetchReply().catch(() => null);
    if (msg) setTimeout(() => { if (!done.has(msg.id)) { done.add(msg.id); msg.edit({ content: '⌛ O convite de contratação expirou.', components: [] }).catch(() => {}); } }, CFG.inviteTTL);
  },

  async demitir(interaction) {
    const m = membershipOf(interaction.user.id);
    const erro = ownerOnly(m);
    if (erro) return interaction.reply(eph(erro));
    const alvo = interaction.options.getUser('usuario');
    if (!alvo) return interaction.reply(eph('❌ Marque quem você quer demitir: `/empresa demitir usuario:@pessoa`'));
    if (!m.company.empregados.includes(alvo.id)) return interaction.reply(eph(`❌ ${alvo.tag} não trabalha na sua empresa.`));
    m.company.empregados = m.company.empregados.filter((id) => id !== alvo.id);
    delete m.company.lastWork[alvo.id];
    store.save();
    return interaction.reply({ content: `📤 <@${alvo.id}> foi demitido(a) de **${m.company.nome}**.`, allowedMentions: { parse: [] } });
  },

  async sair(interaction) {
    const m = membershipOf(interaction.user.id);
    if (!m) return interaction.reply(eph('❌ Você não faz parte de nenhuma empresa.'));
    if (m.dono) return interaction.reply(eph('❌ Você é o dono. Use `/empresa fechar` para encerrar a empresa.'));
    m.company.empregados = m.company.empregados.filter((id) => id !== interaction.user.id);
    delete m.company.lastWork[interaction.user.id];
    store.save();
    return interaction.reply(`👋 Você saiu da empresa **${m.company.nome}**.`);
  },

  async trabalhar(interaction) {
    const m = membershipOf(interaction.user.id);
    if (!m) return interaction.reply(eph('❌ Você não faz parte de nenhuma empresa. Crie uma (`/empresa criar`) ou peça para alguém contratar você.'));
    const c = m.company;
    const agora = Date.now();
    const libera = (c.lastWork[interaction.user.id] || 0) + CFG.workCooldown;
    if (libera > agora) return interaction.reply(eph(`⏳ Você já trabalhou há pouco. Volte <t:${unix(libera)}:R>.`));

    c.lastWork[interaction.user.id] = agora;
    const receita = Math.floor(randInt(CFG.revenueMin, CFG.revenueMax) * (1 + CFG.revenuePerLevel * (c.nivel - 1)));
    let texto;
    if (m.dono) {
      c.cofre += receita;
      texto = `🏢 Você trabalhou na sua empresa e gerou **${fmt(receita)}** para o cofre.`;
    } else {
      const salario = Math.floor(receita * (c.salario / 100));
      const pago = earnMoney(interaction.user.id, salario, `Salário (${c.nome})`);
      c.cofre += receita - salario;
      texto = `💼 Você trabalhou na **${c.nome}**, gerou **${fmt(receita)}** e recebeu **${fmt(salario)}** de salário!${pago > 0 ? `\n🏦 ${fmt(pago)} foram direto para pagar a sua dívida.` : ''}`;
    }
    c.receitaTotal += receita;
    store.save();
    return interaction.reply(texto);
  },

  async coletar(interaction) {
    const m = membershipOf(interaction.user.id);
    const erro = ownerOnly(m);
    if (erro) return interaction.reply(eph(erro));
    if (m.company.cofre < 1) return interaction.reply(eph('❌ O cofre está vazio. Os funcionários precisam trabalhar (`/empresa trabalhar`).'));
    const valor = m.company.cofre;
    m.company.cofre = 0;
    earnMoney(interaction.user.id, valor, `Cofre da empresa ${m.company.nome}`);
    store.save();
    return interaction.reply(`💰 Você retirou **${fmt(valor)}** do cofre da **${m.company.nome}**!`);
  },

  async salario(interaction) {
    const m = membershipOf(interaction.user.id);
    const erro = ownerOnly(m);
    if (erro) return interaction.reply(eph(erro));
    const pct = interaction.options.getInteger('valor');
    if (pct === null || pct < CFG.minSalary || pct > CFG.maxSalary) {
      return interaction.reply(eph(`❌ Informe um percentual entre **${CFG.minSalary}** e **${CFG.maxSalary}**. Ex.: \`/empresa salario valor:40\` (atual: ${m.company.salario}%).`));
    }
    m.company.salario = pct;
    store.save();
    return interaction.reply(`💼 Agora cada funcionário recebe **${pct}%** da receita que gerar.`);
  },

  async melhorar(interaction) {
    const m = membershipOf(interaction.user.id);
    const erro = ownerOnly(m);
    if (erro) return interaction.reply(eph(erro));
    const c = m.company;
    if (c.nivel >= CFG.maxLevel) return interaction.reply(eph('✅ Sua empresa já está no nível máximo!'));
    const custo = CFG.upgradeCost * c.nivel;
    if (!chargeUser(interaction.user.id, custo, `Melhorou a empresa ${c.nome}`)) {
      return interaction.reply(eph(`❌ Melhorar para o nível ${c.nivel + 1} custa **${fmt(custo)}** (carteira + banco).`));
    }
    c.nivel += 1;
    store.save();
    return interaction.reply(`📈 **${c.nome}** subiu para o **nível ${c.nivel}**! Agora tem **${capacity(c)} vagas** e a receita é maior.`);
  },

  async fechar(interaction) {
    const m = membershipOf(interaction.user.id);
    const erro = ownerOnly(m);
    if (erro) return interaction.reply(eph(erro));
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`emp_close:${interaction.user.id}`).setLabel('Sim, fechar a empresa').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`emp_keep:${interaction.user.id}`).setLabel('Cancelar').setStyle(ButtonStyle.Secondary)
    );
    return interaction.reply({
      content: `⚠️ Fechar **${m.company.nome}** demite todos os funcionários e **não devolve** o preço da abertura (o cofre de ${fmt(m.company.cofre)} vai para você). Confirma?`,
      components: [row],
      flags: 64
    });
  }
};

/* ============================================================
 *  BOTÕES (aceitar convite / confirmar fechamento)
 * ============================================================ */
const done = new Set(); // convites já resolvidos

async function handleButton(interaction) {
  const [kind, a, b] = interaction.customId.split(':');

  if (kind === 'emp_close' || kind === 'emp_keep') {
    if (interaction.user.id !== a) return interaction.reply(eph('❌ Só o dono pode responder.'));
    if (kind === 'emp_keep') return interaction.update({ content: '👍 Tudo certo, a empresa continua aberta.', components: [] });
    const c = companies[a];
    if (!c) return interaction.update({ content: '❌ Essa empresa não existe mais.', components: [] });
    if (c.cofre > 0) earnMoney(a, c.cofre, `Cofre da empresa ${c.nome} (fechamento)`);
    delete companies[a];
    store.save();
    return interaction.update({ content: `🏚️ **${c.nome}** foi fechada.`, components: [] });
  }

  if (kind === 'emp_y' || kind === 'emp_n') {
    if (interaction.user.id !== b) return interaction.reply(eph('❌ Só quem recebeu o convite pode responder.'));
    if (done.has(interaction.message.id)) return interaction.reply(eph('⌛ Este convite já foi resolvido.'));
    done.add(interaction.message.id);

    if (kind === 'emp_n') return interaction.update({ content: `🏳️ <@${b}> recusou o convite.`, components: [], allowedMentions: { parse: [] } });

    const c = companies[a];
    if (!c) return interaction.update({ content: '❌ Essa empresa não existe mais.', components: [] });
    if (membershipOf(b)) return interaction.update({ content: '❌ Você já faz parte de uma empresa.', components: [] });
    if (c.empregados.length >= capacity(c)) return interaction.update({ content: '❌ A empresa lotou enquanto o convite estava aberto.', components: [] });
    c.empregados.push(b);
    store.save();
    return interaction.update({
      content: `🎉 <@${b}> agora trabalha na **${c.nome}**! Use \`/empresa trabalhar\` a cada 10 minutos para ganhar ${c.salario}% da receita.`,
      components: [],
      allowedMentions: { users: [b] }
    });
  }
}

/* ============================================================
 *  ENTRADA
 * ============================================================ */
const handledCommands = ['empresa'];

async function handleEmpresasInteraction(interaction) {
  try {
    if (interaction.isButton()) {
      if (!/^emp_(y|n|close|keep):/.test(interaction.customId)) return;
      return await handleButton(interaction);
    }
    if (!interaction.isChatInputCommand() || interaction.commandName !== 'empresa') return;
    const acao = interaction.options.getString('acao');
    if (!Object.hasOwn(ACTIONS, acao)) return await interaction.reply(eph('❌ Ação inválida.'));
    await ACTIONS[acao](interaction);
  } catch (err) {
    console.error('[interação/empresa]', err);
    try { const aviso = describeError(err); if (aviso) await respond(interaction, eph(aviso)); } catch (_) { /* ignora */ }
  }
}

module.exports = { empresasSlashCommands, handledCommands, handleEmpresasInteraction, CFG };
