'use strict';

/**
 * /novidades — mostra o histórico de atualizações do bot (da mais nova para a mais antiga).
 * Para registrar uma atualização nova: adicione um item NO INÍCIO da lista CHANGELOG
 * e aumente a "version" no package.json.
 */

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, SlashCommandBuilder } = require('discord.js');
const { eph, respond, describeError } = require('./utils');

const CHANGELOG = [
  {
    version: '2.4.0', data: '27/10/2026', titulo: 'Dados seguros, empresas e mais controle',
    itens: [
      '💾 **Backup automático no Discord**: saldo, níveis, empresas, cargos e configurações não somem mais quando o bot atualiza ou reinicia (o dono ativa uma vez com `?backup configurar`).',
      '🏢 **/empresa**: crie uma empresa, contrate pessoas (elas aceitam o convite), os funcionários trabalham e ganham uma parte, e o resto vai para o seu cofre.',
      '🤖 **IA agora usa o Gemini** (`gemini-3.1-flash-lite`): gasta bem menos (respostas curtas e cache de perguntas repetidas), os erros dizem o motivo e `?ia` mostra se está ligada ou desligada.',
      '🔔 **Logs**: `?logs` mostra para onde cada log vai, testa os canais, e agora registra bans e silenciamentos feitos direto no Discord.',
      '🎨 **Cargo personalizado**: você só consegue editar (ou apagar) o SEU cargo, e ele não ganha nenhuma permissão de administração.',
      '📰 **/novidades**: este histórico de atualizações.'
    ]
  },
  {
    version: '2.3.0', data: '26/10/2026', titulo: 'Permissões automáticas e bot público',
    itens: [
      '🔐 **Permissões automáticas**: quem tem *Banir Membros* usa `/ban`, quem tem *Silenciar Membros* usa `/mute`... Ninguém precisa mais cadastrar cargo. Quem tem Administrador usa tudo.',
      '🌐 **Qualquer um pode adicionar o bot** no próprio servidor (botão no `/botinfo`).',
      '🔕 **Menos barulho**: avisos de nível só nos marcos, `/clear` não entra no log, anti-flood no automod.',
      '⚔️ **Duelo**: `/apostar valor @pessoa` desafia alguém (50/50).',
      '🛡️ Escudo de 10 min depois de ser roubado, ganhos pagam parte do empréstimo e jogos rebalanceados.'
    ]
  },
  {
    version: '2.2.0', data: '25/10/2026', titulo: 'Ajuda nova, níveis e cargos',
    itens: [
      '📖 **/help** automático, com menu e detalhes de cada comando.',
      '⭐ **Níveis** com cargos coloridos criados pelo bot (`/cargosnivel criar`).',
      '🎨 **Painel de cargo personalizado** por 🪙 1.000.000 ZapherCoin.',
      '😀 **/criaremoji** e **/criarfigurinha**.',
      '🪙 A moeda agora é a **ZapherCoin**.'
    ]
  },
  {
    version: '2.1.0', data: '24/10/2026', titulo: 'Prefixo, IA e economia',
    itens: [
      '⌨️ Todos os comandos funcionam com `/` **e** com o prefixo `?`.',
      '🧠 **IA** que responde perguntas (`/perguntar` ou marcando o bot).',
      '🃏 Blackjack, negócios, profissões, caixa misteriosa, `/vender` e `/cooldowns`.'
    ]
  },
  {
    version: '2.0.0', data: '23/10/2026', titulo: 'Reescrita completa',
    itens: [
      '🛠️ Correção de dezenas de bugs, tickets melhores, sorteios e banimentos temporários que sobrevivem a reinícios.',
      '⚡ Armazenamento otimizado e conexão mais estável no Render.'
    ]
  }
];

const currentVersion = () => { try { return require('./package.json').version; } catch (_) { return CHANGELOG[0].version; } };

const changelogSlashCommands = [
  new SlashCommandBuilder().setName('novidades').setDescription('Mostra as últimas atualizações do bot')
];

function buildPage(index) {
  const i = Math.max(0, Math.min(index, CHANGELOG.length - 1));
  const r = CHANGELOG[i];
  const embed = new EmbedBuilder()
    .setColor(0x9B59B6)
    .setTitle(`📰 Versão ${r.version} — ${r.titulo}`)
    .setDescription(r.itens.map((t) => `• ${t}`).join('\n\n'))
    .setFooter({ text: `${r.data} • Atualização ${i + 1} de ${CHANGELOG.length} • Versão em execução: ${currentVersion()}` });
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`novidades_${Math.max(0, i - 1)}`).setLabel('Mais nova').setEmoji('◀️').setStyle(ButtonStyle.Primary).setDisabled(i === 0),
    new ButtonBuilder().setCustomId(`novidades_${Math.min(CHANGELOG.length - 1, i + 1)}`).setLabel('Mais antiga').setEmoji('▶️').setStyle(ButtonStyle.Primary).setDisabled(i >= CHANGELOG.length - 1)
  );
  return { embeds: [embed], components: [row] };
}

const handledCommands = ['novidades'];

async function handleChangelogInteraction(interaction) {
  try {
    if (interaction.isButton() && interaction.customId.startsWith('novidades_')) {
      return await interaction.update(buildPage(parseInt(interaction.customId.slice('novidades_'.length), 10) || 0));
    }
    if (interaction.isChatInputCommand() && interaction.commandName === 'novidades') {
      return await interaction.reply(buildPage(0));
    }
  } catch (err) {
    console.error('[interação/novidades]', err);
    try { const aviso = describeError(err); if (aviso) await respond(interaction, eph(aviso)); } catch (_) { /* ignora */ }
  }
}

module.exports = { changelogSlashCommands, handledCommands, handleChangelogInteraction, CHANGELOG, buildPage };
