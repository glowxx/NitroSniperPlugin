import { build } from 'esbuild';
export async function loadTS(file, mocks = {}) {
    const result = await build({ entryPoints: [file], bundle: true, write: false, platform: 'node', format: 'esm', target: 'node22',
        plugins: [{ name: 'mocks', setup(builder) {
            builder.onResolve({ filter: /.*/ }, args => Object.hasOwn(mocks, args.path) ? { path: args.path, namespace: 'mock' } : undefined);
            builder.onLoad({ filter: /.*/, namespace: 'mock' }, args => ({ contents: mocks[args.path], loader: 'js' }));
        } }] });
    return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
}
