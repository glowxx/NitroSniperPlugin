import { REST, Routes } from 'discord.js';
import { config } from './config.mjs';
import { command } from './commands.mjs';
const options = config();
const rest = new REST({ version: '10' }).setToken(options.token);
// Upsert only this command; never replace another bot's entire command collection.
await rest.post(options.guildId ? Routes.applicationGuildCommands(options.applicationId, options.guildId) : Routes.applicationCommands(options.applicationId), { body: command.toJSON() });
console.log('Registered /notifications.');
