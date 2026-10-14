import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTS } from './helpers.mjs';

const { extractGiftCodes } = await loadTS('claimQueue.ts');
const code = 'aBcDeFgHiJkLmNoP';
const gift = `https://discord.gift/${code}`;
const wrappers = [value => value, value => `**${value}**`, value => `||${value}||`, value => `\`${value}\``, value => `||**${value}**||`, value => `(${value})`, value => `<${value}>`];

test('complete candidates preserve real hosts, code case, formatting, query and fragments', () => {
    for (const host of ['discord.gift', 'DISCORD.GIFT', 'discord.com/gifts', 'DISCORDAPP.COM/gifts', 'discord.com/gift']) {
        for (const scheme of ['', 'http://', 'https://', 'HTTPS://']) {
            for (const suffix of ['', '?ref=gift', '#gift', '?ref=gift#gift', '?next=(https://example.com/path)']) {
                for (const wrap of wrappers) {
                    const content = `Gift: ${wrap(`${scheme}${host}/${code}${suffix}`)}!`;
                    assert.deepEqual(extractGiftCodes(content), [code], content);
                }
            }
        }
    }
    assert.deepEqual(extractGiftCodes(`${gift} discord.gift/${code} https://discord.com/gifts/qrstuvwxyzABCDEF`), [code, 'qrstuvwxyzABCDEF']);
});

test('nested gift-shaped paths, queries and fragments remain part of their hostile complete candidate', () => {
    for (const nested of [gift, `discord.gift/${code}`, `https://discord.com/gifts/${code}`, `discordapp.com/gifts/${code}`]) {
        for (const surround of [value => value, value => `(${value})`, value => `**${value}**`, value => `||${value}||`, value => `<${value}>`, value => `\`${value}\``]) {
            for (const prefix of ['https://evil.example/', 'https://evil.example/?next=', 'https://evil.example/#', 'evil.example/path/', 'ftp://evil.example/']) {
                for (const wrap of wrappers) {
                    const content = wrap(`${prefix}${surround(nested)}`);
                    assert.deepEqual(extractGiftCodes(content), [], content);
                }
            }
        }
    }
});

test('strict raw authority/path validation rejects normalization, spoofing and truncation attacks', () => {
    const attacks = [
        `https://evil-discord.gift/${code}`, `https://discord.gift.evil.example/${code}`,
        `https://discord.gift@evil.example/${code}`, `https://evil.example@discord.gift/${code}`,
        `https://discord.gift./${code}`, `https://%64iscord.gift/${code}`,
        `https://dіscord.gift/${code}`, `https://ＤＩＳＣＯＲＤ.gift/${code}`,
        `https://discord。gift/${code}`, `https://discord.gift\\@evil.example/${code}`,
        `https:///discord.gift/${code}`, `//discord.gift/${code}`,
        `https://discord.gift/a/../${code}`, `https://discord.com/gifts/a/../${code}`,
        `https://discord.gift/${code}/`, `https://discord.gift/${code}/extra`,
        `https://discord.gift/${code}%2fextra`, `https://discord.gift/${code}_extra`,
        `https://discord.gift/${code}-extra`, `https://discord.gift/${code}@evil.example`,
        `https://discord.gift/${code}=extra`, `https://discord.gift/${code}123456789`,
        `**${gift}_**`, `||${gift}**||`, `**${gift}**/extra`, `(${gift})/extra`,
        `${gift}#x\u200b`, `https://discord.\u200bgift/${code}`, `${gift}\u200bextra`,
        `${gift}\ufeffextra`, `\ufeff${gift}`, `${gift}\u200cextra`, `${gift}\u200dextra`,
        `https://discord.gift/${code.slice(0, 15)}`, `https://discord.gift/${code.slice(0, 8)}_${code.slice(8)}`
    ];
    for (const attack of attacks) for (const wrap of wrappers) assert.deepEqual(extractGiftCodes(wrap(attack)), [], wrap(attack));
});

test('a rejected complete hostile candidate does not hide independent legitimate links', () => {
    assert.deepEqual(extractGiftCodes(`https://evil.example/?next=(${gift})\n||${gift}||`), [code]);
});
