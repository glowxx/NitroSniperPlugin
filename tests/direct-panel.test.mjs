import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTS } from './helpers.mjs';
const user = '123456789012345678';
const token = 'never-persist-this-token-in-settings';
const info = { credentialId: '12345678-1234-1234-1234-123456789012', botId: '234567890123456789', botName: 'MyBot' };
globalThis.nsPanel = {};
const { DirectBotPanel } = await loadTS('directBotPanel.tsx', {
    '@webpack/common': `export const Button='button'; export const UserStore={getCurrentUser:()=>({id:globalThis.nsPanel.user})}; export const Toasts={Type:{SUCCESS:1}}; export const showToast=()=>{};
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
const settle=async()=>{for(let i=0;i<5;i++)await new Promise(setImmediate);};
test('Connect clears the password field immediately and saves only public metadata; disconnect removes it', async () => {
    let resolve, args;
    reset((...values)=>{args=values;return new Promise(done=>{resolve=done;});});
    let tree=render();input(tree).props.onChange({currentTarget:{value:token}});tree=render();
    assert.equal(input(tree).props.type,'password');button(tree,'Connect bot').props.onClick();
    tree=render();assert.equal(input(tree).props.value,'');assert.equal(input(tree).props.disabled,true);
    assert.deepEqual(args,[user,token]);resolve(info);await settle();tree=render();
    assert.equal(input(tree).props.value,'');assert.equal(input(tree).props.placeholder,'Token saved — hidden');
    assert.equal(globalThis.nsPanel.settings.botNotificationsEnabled,true);
    assert.deepEqual(JSON.parse(globalThis.nsPanel.settings.botDirectAccounts)[user],info);
    assert.equal(JSON.stringify(globalThis.nsPanel.settings).includes(token),false);
    button(tree,'Disconnect').props.onClick();await settle();tree=render();
    assert.equal(input(tree).props.value,'');assert.equal(globalThis.nsPanel.settings.botNotificationsEnabled,false);
    assert.deepEqual(JSON.parse(globalThis.nsPanel.settings.botDirectAccounts),{});
});
test('failed verification clears the pasted token and does not activate notifications',async()=>{
    reset(async()=>{throw new Error('Bot token could not be verified');});
    let tree=render();input(tree).props.onChange({currentTarget:{value:token}});tree=render();button(tree,'Connect bot').props.onClick();await settle();tree=render();
    assert.equal(input(tree).props.value,'');assert.equal(globalThis.nsPanel.settings.botNotificationsEnabled,false);
    assert.equal(globalThis.nsPanel.settings.botDirectAccounts,'');
    assert.ok(nodes(tree).some(node=>node.props?.role==='alert'&&/could not be verified/.test(node.props.children)));
});
test('a late connection for an old account cannot enable the newly logged-in account',async()=>{
    let resolve;reset(()=>new Promise(done=>{resolve=done;}));
    let tree=render();input(tree).props.onChange({currentTarget:{value:token}});tree=render();button(tree,'Connect bot').props.onClick();
    globalThis.nsPanel.user='345678901234567890';resolve(info);await settle();tree=render();
    assert.equal(globalThis.nsPanel.settings.botNotificationsEnabled,false);
    assert.equal(JSON.parse(globalThis.nsPanel.settings.botDirectAccounts)[user].botName,'MyBot');
    assert.equal(JSON.parse(globalThis.nsPanel.settings.botDirectAccounts)[globalThis.nsPanel.user],undefined);
    assert.equal(input(tree).props.value,'');
});
