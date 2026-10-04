import { SlashCommandBuilder } from 'discord.js';
export const command = new SlashCommandBuilder().setName('notifications').setDescription('Manage NitroSniper DM notifications')
    .addSubcommand(c => c.setName('link').setDescription('Connect this account or rotate its notification key'))
    .addSubcommand(c => c.setName('status').setDescription('Check connection and delivery status'))
    .addSubcommand(c => c.setName('test').setDescription('Send yourself a test notification'))
    .addSubcommand(c => c.setName('disconnect').setDescription('Revoke your key and cancel pending notifications'));
