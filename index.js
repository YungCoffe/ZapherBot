cat << 'EOF' > index.js
const { Client, GatewayIntentBits } = require('discord.js');
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
  handleEconomyInteraction 
} = require('./economy.js');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ]
});

client.once('ready', async () => {
  console.log('Bot online com sucesso!');
  try {
    const totalCommands = [...allSlashCommands, ...economySlashCommands];
    await client.application.commands.set(totalCommands);
    console.log('Todos os comandos Slash (Moderação, Tickets e Economia) foram registrados com sucesso!');
  } catch (error) {
    console.error('Erro ao registrar comandos:', error);
  }
});

client.on('messageCreate', handleMessage);
client.on('messageDelete', handleMessageDelete);

client.on('interactionCreate', async (interaction) => {
  try {
    await handleInteraction(interaction);
    await handleEconomyInteraction(interaction);
  } catch (err) {
    console.error('Erro na interação:', err);
  }
});

client.on('guildMemberAdd', handleGuildMemberAdd);
client.on('guildMemberRemove', handleGuildMemberRemove);

client.login(process.env.DISCORD_TOKEN);

