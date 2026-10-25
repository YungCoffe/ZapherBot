const { Client, GatewayIntentBits } = require('discord.js');
const http = require('http');

// Importações dos módulos do Bot
const { 
  allSlashCommands, 
  handleInteraction, 
  handleMessage, 
  handleMessageDelete, 
  handleGuildMemberAdd, 
  handleGuildMemberRemove 
} = require('./ticket.js');

const { 
  economySlashCommands, 
  handleEconomyMessage, 
  handleEconomyInteraction 
} = require('./economy.js');

// 1. Servidor HTTP para satisfazer o Web Service do Render
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Bot e Servidor HTTP estão online!');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor HTTP do Render rodando na porta ${PORT}`);
});

// 2. Instância do Client do Discord
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ]
});

// 3. Registo de Comandos Slash ao Iniciar
client.once('ready', async () => {
  console.log(`🤖 Bot ${client.user.tag} iniciado com sucesso!`);
  try {
    const totalCommands = [...allSlashCommands, ...economySlashCommands];
    await client.application.commands.set(totalCommands);
    console.log('✅ Todos os comandos Slash (Moderação, Tickets e Economia) foram registrados!');
  } catch (error) {
    console.error('❌ Erro ao registrar comandos Slash:', error);
  }
});

// 4. Ouvinte de Mensagens para Comandos por Prefixo (?)
client.on('messageCreate', async (message) => {
  try {
    await handleMessage(message);
    await handleEconomyMessage(message);
  } catch (err) {
    console.error('Erro ao processar mensagem por prefixo:', err);
  }
});

// 5. Ouvinte de Apagamento de Mensagens (Logs)
client.on('messageDelete', handleMessageDelete);

// 6. Ouvinte de Interações (Comandos por / e Botões/Modais)
client.on('interactionCreate', async (interaction) => {
  try {
    await handleInteraction(interaction);
    await handleEconomyInteraction(interaction);
  } catch (err) {
    console.error('Erro ao processar interação:', err);
  }
});

// 7. Eventos de Entradas e Saídas de Membros
client.on('guildMemberAdd', handleGuildMemberAdd);
client.on('guildMemberRemove', handleGuildMemberRemove);

// Login do Bot no Discord
client.login(process.env.DISCORD_TOKEN);
