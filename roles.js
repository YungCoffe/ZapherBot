'use strict';

/**
 * Painel de cargo personalizado.
 *   1) Staff envia o painel com /painel-cargos
 *   2) A pessoa clica em "Criar meu cargo": o preço é debitado automaticamente da conta
 *   3) Abre uma janela para escolher NOME e COR; o bot cria o cargo e entrega
 * Permissões do cargo: simples e seguras (inclui enviar imagens/arquivos).
 *
 * O pagamento fica guardado: se a janela for fechada ou der erro, ao clicar de novo
 * a pessoa continua de onde parou, SEM pagar outra vez.
 */

const {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, ModalBuilder, TextInputBuilder, TextInputStyle,
  PermissionFlagsBits, PermissionsBitField, SlashCommandBuilder
} = require('discord.js');
const { EPHEMERAL, CURRENCY_NAME, eph, normalize, respond, parseColor, placeRoleBelow, describeError } = require('./utils');
const { getUserAccount, saveEcoData, chargeUser, fmt } = require('./economy');
const { getGuildConfig, ensureGuildConfig, saveConfig } = require('./ticket');
const { checkAccess } = require('./perms');

const ROLE_PRICE = Number(process.env.CUSTOM_ROLE_PRICE) || 1000000;
const MAX_GUILD_ROLES = 245; // o Discord limita a 250 cargos por servidor

/** Permissões "normais": ver, escrever, mandar imagens/arquivos e links, reagir, falar em voz. */
const BASIC_PERMISSIONS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.SendMessagesInThreads,
  PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.AttachFiles,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.AddReactions,
  PermissionFlagsBits.UseExternalEmojis,
  PermissionFlagsBits.UseExternalStickers,
  PermissionFlagsBits.Connect,
  PermissionFlagsBits.Speak,
  PermissionFlagsBits.UseVAD,
  PermissionFlagsBits.Stream,
  PermissionFlagsBits.ChangeNickname
];

const BASIC_BITFIELD = new PermissionsBitField(BASIC_PERMISSIONS).bitfield;
/** Nomes que imitariam a staff ou chamariam atenção indevida. */
const BLOCKED_WORDS = ['admin', 'administrador', 'adm', 'moderador', 'mod', 'staff', 'dono', 'owner', 'everyone', 'here', 'suporte', 'bot'];

/* ============================================================
 *  PAINEL
 * ============================================================ */
const rolesSlashCommands = [
  new SlashCommandBuilder().setName('painel-cargos').setDescription('Envia o painel para criar cargo personalizado (staff)')
    .addRoleOption(o => o.setName('abaixo_de').setDescription('Os cargos criados ficam logo abaixo deste cargo').setRequired(false))
];

function panelMessage() {
  const embed = new EmbedBuilder()
    .setColor(0xE91E63)
    .setTitle('🎨 Cargo Personalizado')
    .setDescription([
      'Crie o **seu próprio cargo**, com o nome e a cor que quiser!',
      '',
      `💰 **Preço:** ${fmt(ROLE_PRICE)} ${CURRENCY_NAME}`,
      '> Ao clicar no botão, o valor é **debitado automaticamente** da sua conta (carteira e, se faltar, banco).',
      '',
      '**Como funciona**',
      '1️⃣ Clique em **Criar meu cargo**',
      '2️⃣ Escolha o **nome** e a **cor** (ex.: `#FF8800`, `azul`, `roxo`)',
      '3️⃣ Pronto! O cargo é criado e entregue na hora',
      '',
      '**Permissões do cargo:** simples e seguras — ler e escrever, **enviar imagens e arquivos**, links, reações, emojis, entrar e falar em canais de voz.',
      '🔒 Você só consegue mexer no **seu próprio cargo** (nome e cor). Ele nunca recebe permissão de administração.'
    ].join('\n'))
    .setFooter({ text: 'Cada pessoa pode ter 1 cargo personalizado • Editar nome/cor é grátis' });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('role_create').setLabel(`Criar meu cargo (${fmt(ROLE_PRICE)})`).setStyle(ButtonStyle.Success).setEmoji('🎨'),
    new ButtonBuilder().setCustomId('role_edit').setLabel('Editar meu cargo').setStyle(ButtonStyle.Secondary).setEmoji('✏️'),
    new ButtonBuilder().setCustomId('role_delete').setLabel('Apagar meu cargo').setStyle(ButtonStyle.Danger).setEmoji('🗑️')
  );
  return { embeds: [embed], components: [row] };
}

/* ============================================================
 *  VALIDAÇÃO
 * ============================================================ */
const sanitizeName = (text) => String(text ?? '').replace(/[@`\n\r]/g, '').replace(/\s+/g, ' ').trim();

function validate(guild, nome, cor, ignoreRoleId = null) {
  if (nome.length < 2 || nome.length > 32) return '❌ O nome precisa ter entre 2 e 32 caracteres (sem @).';
  if (cor === null) return '❌ Cor inválida. Use um código (`#FF8800`) ou o nome de uma cor (`vermelho`, `azul`, `roxo`, `rosa`...).';
  if (normalize(nome).split(/[^a-z0-9]+/).some((w) => BLOCKED_WORDS.includes(w))) return '❌ Esse nome não é permitido (parece um cargo da staff ou do sistema). Escolha outro.';
  const igual = guild.roles.cache.find((r) => r.id !== ignoreRoleId && normalize(r.name) === normalize(nome));
  if (igual) return '❌ Já existe um cargo com esse nome. Escolha outro.';
  return null;
}

const hexOf = (n) => `#${n.toString(16).padStart(6, '0').toUpperCase()}`;

function buildModal(customId, title, nome = '', cor = '') {
  const nomeInput = new TextInputBuilder()
    .setCustomId('ti_nome').setLabel('Nome do cargo').setStyle(TextInputStyle.Short)
    .setMinLength(2).setMaxLength(32).setRequired(true).setPlaceholder('Ex.: Rei do Churrasco');
  const corInput = new TextInputBuilder()
    .setCustomId('ti_cor').setLabel('Cor (código ou nome)').setStyle(TextInputStyle.Short)
    .setMinLength(3).setMaxLength(20).setRequired(true).setPlaceholder('#FF8800 ou vermelho, azul, roxo, rosa...');
  if (nome) nomeInput.setValue(nome);
  if (cor) corInput.setValue(cor);
  return new ModalBuilder().setCustomId(customId).setTitle(title)
    .addComponents(new ActionRowBuilder().addComponents(nomeInput), new ActionRowBuilder().addComponents(corInput));
}

/** Cargo personalizado atual da pessoa neste servidor (ou null se não existir mais). */
function ownRole(guild, acc, member = null) {
  const id = acc.customRoles[guild.id];
  const role = id ? guild.roles.cache.get(id) : null;
  if (role) return role;
  if (id) { delete acc.customRoles[guild.id]; saveEcoData(); }

  // Recuperação: se o registro se perdeu (ex.: dados apagados numa atualização) mas a pessoa ainda tem
  // um cargo com exatamente as permissões que o bot dá, e só ela o usa, ele é o cargo dela.
  const candidato = [...(member?.roles?.cache?.values?.() ?? [])].find((r) => !r.managed && r.id !== guild.id && r.permissions?.bitfield === BASIC_BITFIELD && r.members?.size === 1);
  if (candidato) { acc.customRoles[guild.id] = candidato.id; saveEcoData(); return candidato; }
  return null;
}

/* ============================================================
 *  BOTÕES
 * ============================================================ */
async function onCreateClick(interaction) {
  const { guild, user } = interaction;
  if (!guild) return interaction.reply(eph('❌ Isto só funciona dentro de um servidor.'));
  const acc = getUserAccount(user.id);

  const atual = ownRole(guild, acc, interaction.member);
  if (atual) return interaction.reply({ content: `❌ Você já tem um cargo personalizado: <@&${atual.id}>. Use **✏️ Editar meu cargo** para mudar nome ou cor.`, flags: EPHEMERAL, allowedMentions: { parse: [] } });

  if (!acc.rolePasses[guild.id]) {
    if (!guild.members.me?.permissions.has(PermissionFlagsBits.ManageRoles)) {
      return interaction.reply(eph('❌ Eu preciso da permissão **Gerir Cargos** para criar cargos. Avise a staff.'));
    }
    if (guild.roles.cache.size >= MAX_GUILD_ROLES) return interaction.reply(eph('❌ O servidor chegou ao limite de cargos. Avise a staff.'));

    if (!chargeUser(user.id, ROLE_PRICE, 'Cargo personalizado')) {
      return interaction.reply(eph(`❌ Você precisa de **${fmt(ROLE_PRICE)} ${CURRENCY_NAME}** (carteira + banco) e tem **${fmt(acc.wallet + acc.bank)}**.`));
    }
    acc.rolePasses[guild.id] = Date.now();
    saveEcoData();
  }
  return interaction.showModal(buildModal('role_modal_create', 'Pago! Escolha nome e cor'));
}

async function onEditClick(interaction) {
  const { guild, user } = interaction;
  if (!guild) return interaction.reply(eph('❌ Isto só funciona dentro de um servidor.'));
  const role = ownRole(guild, getUserAccount(user.id), interaction.member);
  if (!role) return interaction.reply(eph('❌ Você ainda não tem um cargo personalizado. Clique em **Criar meu cargo**.'));
  return interaction.showModal(buildModal('role_modal_edit', 'Editar meu cargo', role.name, hexOf(role.color)));
}

async function onDeleteClick(interaction) {
  const { guild, user } = interaction;
  if (!guild) return interaction.reply(eph('❌ Isto só funciona dentro de um servidor.'));
  const role = ownRole(guild, getUserAccount(user.id), interaction.member);
  if (!role) return interaction.reply(eph('❌ Você não tem um cargo personalizado neste servidor.'));
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('role_delete_yes').setLabel('Sim, apagar meu cargo').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('role_delete_no').setLabel('Cancelar').setStyle(ButtonStyle.Secondary)
  );
  return interaction.reply({ content: `⚠️ Apagar <@&${role.id}>? **Não há reembolso** e, para ter outro cargo, será preciso pagar ${fmt(ROLE_PRICE)} de novo.`, components: [row], flags: EPHEMERAL, allowedMentions: { parse: [] } });
}

async function onDeleteConfirm(interaction) {
  const { guild, user } = interaction;
  if (interaction.customId === 'role_delete_no') return interaction.update({ content: '👍 Seu cargo foi mantido.', components: [] });
  const acc = getUserAccount(user.id);
  const role = ownRole(guild, acc, interaction.member); // só o próprio cargo da pessoa, nunca o de outra
  if (!role) return interaction.update({ content: '❌ Você não tem um cargo personalizado.', components: [] });
  try {
    await role.delete(`Cargo personalizado apagado por ${user.tag}`);
    delete acc.customRoles[guild.id];
    saveEcoData();
    return interaction.update({ content: '🗑️ Seu cargo foi apagado.', components: [] });
  } catch (err) {
    console.error('[cargo personalizado] apagar:', err);
    return interaction.update({ content: '❌ Não consegui apagar o cargo agora.', components: [] });
  }
}

/* ============================================================
 *  JANELAS (MODAIS)
 * ============================================================ */
async function onCreateSubmit(interaction) {
  const { guild, user } = interaction;
  if (!guild) return;
  const acc = getUserAccount(user.id);
  if (!acc.rolePasses[guild.id]) {
    return interaction.reply(eph('❌ Não encontrei nenhum pagamento seu pendente. Clique em **Criar meu cargo** novamente.'));
  }

  const nome = sanitizeName(interaction.fields.getTextInputValue('ti_nome'));
  const cor = parseColor(interaction.fields.getTextInputValue('ti_cor'));
  const erro = validate(guild, nome, cor);
  if (erro) return interaction.reply(eph(`${erro}\n💡 Seu pagamento está guardado: clique em **Criar meu cargo** de novo para tentar outra vez, **sem pagar novamente**.`));

  await interaction.deferReply({ flags: EPHEMERAL });
  let role = null;
  try {
    role = await guild.roles.create({
      name: nome,
      color: cor,
      permissions: BASIC_PERMISSIONS,
      hoist: false,
      mentionable: false,
      reason: `Cargo personalizado de ${user.tag}`
    });

    const ancora = guild.roles.cache.get(getGuildConfig(guild.id).customRoleAnchor);
    if (ancora) await placeRoleBelow(guild, role, ancora);

    const membro = interaction.member || await guild.members.fetch(user.id);
    await membro.roles.add(role, 'Cargo personalizado comprado');

    acc.customRoles[guild.id] = role.id;
    delete acc.rolePasses[guild.id];
    saveEcoData();
    return interaction.editReply({ content: `✅ Cargo criado e entregue: <@&${role.id}>!\nVocê pode mudar nome e cor quando quiser em **✏️ Editar meu cargo** (grátis).`, allowedMentions: { parse: [] } });
  } catch (err) {
    console.error('[cargo personalizado] criar:', err);
    if (role) await role.delete('Falha ao entregar o cargo').catch(() => {});
    return interaction.editReply({ content: '❌ Não consegui criar o cargo agora (verifique se tenho **Gerir Cargos**). **Seu pagamento continua guardado**: clique em **Criar meu cargo** de novo para tentar outra vez, sem pagar de novo.' });
  }
}

async function onEditSubmit(interaction) {
  const { guild, user } = interaction;
  if (!guild) return;
  const role = ownRole(guild, getUserAccount(user.id), interaction.member);
  if (!role) return interaction.reply(eph('❌ Você não tem um cargo personalizado neste servidor.'));

  const nome = sanitizeName(interaction.fields.getTextInputValue('ti_nome'));
  const cor = parseColor(interaction.fields.getTextInputValue('ti_cor'));
  const erro = validate(guild, nome, cor, role.id);
  if (erro) return interaction.reply(eph(erro));

  await interaction.deferReply({ flags: EPHEMERAL });
  try {
    await role.edit({ name: nome, color: cor, reason: `Cargo personalizado editado por ${user.tag}` });
    return interaction.editReply({ content: `✅ Cargo atualizado: <@&${role.id}>`, allowedMentions: { parse: [] } });
  } catch (err) {
    console.error('[cargo personalizado] editar:', err);
    return interaction.editReply({ content: '❌ Não consegui editar o cargo agora.' });
  }
}

/* ============================================================
 *  ENTRADA
 * ============================================================ */
const handledCommands = ['painel-cargos'];

async function handleRolesInteraction(interaction) {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName !== 'painel-cargos') return;
      if (!interaction.guild) return interaction.reply(eph('❌ Este comando só funciona dentro de um servidor.'));
      const negado = checkAccess(interaction, { strict: true });
      if (negado) return interaction.reply(eph(negado));
      const ancora = interaction.options.getRole('abaixo_de');
      if (ancora) {
        ensureGuildConfig(interaction.guild.id).customRoleAnchor = ancora.id;
        saveConfig();
      }
      await interaction.channel.send(panelMessage());
      return interaction.reply(eph(`✅ Painel de cargos enviado!${ancora ? ` Os cargos serão criados logo abaixo de <@&${ancora.id}>.` : ''}`));
    }

    if (interaction.isButton()) {
      if (interaction.customId === 'role_create') return await onCreateClick(interaction);
      if (interaction.customId === 'role_edit') return await onEditClick(interaction);
      if (interaction.customId === 'role_delete') return await onDeleteClick(interaction);
      if (interaction.customId === 'role_delete_yes' || interaction.customId === 'role_delete_no') return await onDeleteConfirm(interaction);
      return;
    }

    if (interaction.isModalSubmit()) {
      if (interaction.customId === 'role_modal_create') return await onCreateSubmit(interaction);
      if (interaction.customId === 'role_modal_edit') return await onEditSubmit(interaction);
    }
  } catch (err) {
    console.error('[interação/cargos]', err);
    try { const aviso = describeError(err); if (aviso) await respond(interaction, eph(aviso)); } catch (_) { /* ignora */ }
  }
}

module.exports = { rolesSlashCommands, handledCommands, handleRolesInteraction, ROLE_PRICE };
