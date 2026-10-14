import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTS } from './helpers.mjs';
const user = '123456789012345678';
const token = 'never-persist-this-token-in-settings';
const info = { credentialId: '12345678-1234-1234-1234-123456789012', botId: '234567890123456789', botName: 'MyBot' };
globalThis.nsPanel = {};
const { DirectBotPanel } = await loadTS('directBotPanel.tsx', {
    '@webpack/common': `export const Button='button'; export const UserStore={getCurrentUser:()=>({id:globalThis.nsPanel.user})}; export const showToast=(text,type)=>{if(type!=="success")throw new Error("invalid current toast variant")};
export const useStateFromStores=(stores,fn)=>fn(); export const useEffect=()=>{};
export function useState(initial){const f=globalThis.nsPanel,i=f.cursor++;if(!(i in f.state))f.state[i]=typeof initial==='function'?initial():initial;return [f.state[i],value=>{f.state[i]=typeof value==='function'?value(f.state[i]):value}];}
export const useRef=initial=>useState({current:initial})[0];`,
    './settings': 'export const settings={get store(){return globalThis.nsPanel.settings},use:()=>globalThis.nsPanel.settings};',
    './notifications': 'export const getNotificationStatus=()=>({message:"Ready",pending:0,unsaved:0});export const sendTestDM=async()=>{};export const subscribeNotifications=()=>()=>{};',
    'react/jsx-runtime': 'export const jsx=(type,props)=>({type,props});export const jsxs=jsx;'
});
function reset(connect = async () => info) {
    globalThis.nsPanel = { user, cursor: 0, state: [], settings: { botNotificationsEnabled:false,botDirectAccounts:'' } };
    globalThis.VencordNative = { pluginHelpers:{ NitroSniper:{ connectDirectBot:connect, disconnectDirectBot:async()=>{} } } };
}
function render(){globalThis.nsPanel.cursor=0;return DirectBotPanel();}
function nodes(tree){return [tree,...(Array.isArray(tree?.props?.children)?tree.props.children:[tree?.props?.children]).filter(x=>x&&typeof x==='object').flatMap(nodes)];}
const input=tree=>nodes(tree).find(node=>node.type==='input');
const button=(tree,label)=>nodes(tree).find(node=>node.type==='button'&&node.props.children===label);
const enabled = id => JSON.parse(globalThis.nsPanel.settings.notificationAccounts).accounts[id]?.botNotificationsEnabled ?? false;
test('Connect clears the password field immediately and saves only public metadata; disconnect removes it', async () => {
    let resolve, args;
    reset((...values)=>{args=values;return new Promise(done=>{resolve=done;});});
    let tree=render();input(tree).props.onChange({currentTarget:{value:token}});tree=render();
    assert.equal(input(tree).props.type,'password');const connecting=button(tree,'Connect bot').props.onClick();
    tree=render();assert.equal(input(tree).props.value,'');assert.equal(input(tree).props.disabled,true);
    assert.deepEqual(args,[user,token]);resolve(info);await connecting;tree=render();
    assert.equal(input(tree).props.value,'');assert.equal(input(tree).props.placeholder,'Token saved — hidden');
    assert.equal(enabled(user),true);
    assert.deepEqual(JSON.parse(globalThis.nsPanel.settings.botDirectAccounts)[user],info);
    assert.equal(JSON.stringify(globalThis.nsPanel.settings).includes(token),false);
    await button(tree,'Disconnect').props.onClick();tree=render();
    assert.equal(input(tree).props.value,'');assert.equal(enabled(globalThis.nsPanel.user),false);
    assert.deepEqual(JSON.parse(globalThis.nsPanel.settings.botDirectAccounts),{});
});
test('failed verification clears the pasted token and does not activate notifications',async()=>{
    reset(async()=>{throw new Error('Bot token could not be verified');});
    let tree=render();input(tree).props.onChange({currentTarget:{value:token}});tree=render();await button(tree,'Connect bot').props.onClick();tree=render();
    assert.equal(input(tree).props.value,'');assert.equal(enabled(globalThis.nsPanel.user),false);
    assert.equal(globalThis.nsPanel.settings.botDirectAccounts,'');
    assert.ok(nodes(tree).some(node=>node.props?.role==='alert'&&/could not be verified/.test(node.props.children)));
});
test('a late connection for an old account cannot enable the newly logged-in account',async()=>{
    let resolve;reset(()=>new Promise(done=>{resolve=done;}));
    let tree=render();input(tree).props.onChange({currentTarget:{value:token}});tree=render();const connecting=button(tree,'Connect bot').props.onClick();
    globalThis.nsPanel.user='345678901234567890';resolve(info);await connecting;tree=render();
    assert.equal(enabled(globalThis.nsPanel.user),false);
    assert.equal(enabled(user),true, 'The completed setup belongs to its original account');
    assert.equal(JSON.parse(globalThis.nsPanel.settings.botDirectAccounts)[user].botName,'MyBot');
    assert.equal(JSON.parse(globalThis.nsPanel.settings.botDirectAccounts)[globalThis.nsPanel.user],undefined);
    assert.equal(input(tree).props.value,'');
});

test('only credential-vault corruption offers credential recovery; cleanup corruption must not reset a healthy vault', async () => {
    for (const [message, offered] of [['Saved test-message cleanup is corrupted.', false], ['Secure credential storage is corrupted.', true]]) {
        reset(async () => { throw new Error(message); });
        let tree = render(); input(tree).props.onChange({ currentTarget: { value: token } }); tree = render();
        await button(tree, 'Connect bot').props.onClick(); tree = render();
        assert.equal(!!button(tree, 'Recover secure storage'), offered);
    }
});

test('saved ciphertext can be disconnected from the UI when native status/decryption is unavailable', async () => {
    for (const publicMetadata of [true, false]) {
        reset(async () => { throw new Error('Secure token storage is unavailable.'); });
        const removals = [];
        globalThis.VencordNative.pluginHelpers.NitroSniper.disconnectDirectBot = async id => { removals.push(id); };
        if (publicMetadata) globalThis.nsPanel.settings.botDirectAccounts = JSON.stringify({ [user]: info });
        let tree = render();
        if (!publicMetadata) {
            input(tree).props.onChange({ currentTarget: { value: token } }); tree = render();
            await button(tree, 'Connect bot').props.onClick(); tree = render();
        }
        assert.equal(button(tree, 'Disconnect').props.disabled, false);
        await button(tree, 'Disconnect').props.onClick();
        assert.deepEqual(removals, [user]); assert.deepEqual(JSON.parse(globalThis.nsPanel.settings.botDirectAccounts), {});
    }
});

test('disconnect finishing after an account switch disables only its original owner configuration', async () => {
    reset(); let tree = render(); input(tree).props.onChange({ currentTarget: { value: token } }); tree = render();
    await button(tree, 'Connect bot').props.onClick(); tree = render();
    let release;
    globalThis.VencordNative.pluginHelpers.NitroSniper.disconnectDirectBot = async () => new Promise(resolve => { release = resolve; });
    const removing = button(tree, 'Disconnect').props.onClick();
    globalThis.nsPanel.user = '345678901234567890'; release({}); await removing; render();
    assert.equal(enabled(user), false); assert.equal(enabled(globalThis.nsPanel.user), false);
    assert.deepEqual(JSON.parse(globalThis.nsPanel.settings.botDirectAccounts), {});
});
