export function config(env = process.env) {
    for (const key of ['DISCORD_BOT_TOKEN', 'DISCORD_APPLICATION_ID', 'PUBLIC_URL']) if (!env[key]?.trim()) throw new Error(`Missing ${key} in bot/.env`);
    const url = new URL(env.PUBLIC_URL);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('PUBLIC_URL must use HTTPS (except localhost).');
    if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) throw new Error('PUBLIC_URL must contain only the origin.');
    if (!/^\d{17,20}$/.test(env.DISCORD_APPLICATION_ID.trim()) || (env.DISCORD_GUILD_ID?.trim() && !/^\d{17,20}$/.test(env.DISCORD_GUILD_ID.trim()))) throw new Error('Application and guild IDs must be Discord snowflakes.');
    const port = Number(env.PORT ?? 8787);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT.');
    return { token: env.DISCORD_BOT_TOKEN.trim(), applicationId: env.DISCORD_APPLICATION_ID.trim(),
        publicUrl: url.origin, host: env.HOST ?? '127.0.0.1', port,
        database: env.DATABASE_PATH ?? 'bot/data/notifications.sqlite', guildId: env.DISCORD_GUILD_ID?.trim() };
}
