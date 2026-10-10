import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

for (const mode of ['login-error', 'sigterm']) {
test(`the bot entrypoint drains resources and exits despite an SDK background timer: ${mode}`, { timeout: 8_000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nitrosniper-shutdown-'));
    const path = join(dir, 'bot.mjs');
    try {
        const mocks = {
            './config.mjs': 'export const config=()=>({database:":memory:",token:"no-network",publicUrl:"https://notify.example.com",port:0,host:"127.0.0.1"});',
            'discord.js': `import {EventEmitter} from 'node:events';
export const GatewayIntentBits={Guilds:1}, MessageFlags={Ephemeral:64}, Routes={};
export class MessagePayload{}
export class Client extends EventEmitter {
  constructor(){super();this.users={};}
  isReady(){return false;}
  async login(){
    setInterval(()=>{},60000);
    if(process.env.NITROSNIPER_SHUTDOWN_TEST==='sigterm'){
      this.emit('clientReady');setTimeout(()=> (process.platform === 'win32' ? process.emit('SIGTERM') : process.kill(process.pid,'SIGTERM')),50);return 'no-network';
    }
    throw new Error('offline login failure');
  }
  async destroy(){await new Promise(setImmediate);console.log('CLIENT_DESTROYED');}
}`
        };
        await build({ entryPoints: ['bot/index.mjs'], outfile: path, bundle: true, format: 'esm', platform: 'node', target: 'node22',
            plugins: [{ name: 'offline-boundaries', setup(builder) {
                builder.onResolve({ filter: /.*/ }, args => Object.hasOwn(mocks, args.path) ? { path: args.path, namespace: 'mock' } : undefined);
                builder.onLoad({ filter: /.*/, namespace: 'mock' }, args => ({ contents: mocks[args.path], loader: 'js' }));
            } }] });
        const result = await new Promise(resolve => execFile(process.execPath, [path], { timeout: 3_000, killSignal: 'SIGKILL', env: { ...process.env, NITROSNIPER_SHUTDOWN_TEST: mode } }, (error, stdout, stderr) => resolve({ error, stdout, stderr })));
        assert.equal(result.error?.code, mode === 'login-error' ? 1 : undefined, 'The drained shutdown must exit with its requested code, not hang until killed');
        assert.match(result.stdout, /CLIENT_DESTROYED/, 'Client destruction must be awaited before process exit');
        if (mode === 'login-error') assert.match(result.stderr, /Bot login failed/);
        else assert.match(result.stdout, /notification bot ready/);
    } finally { await rm(dir, { recursive: true, force: true }); }
});
}
