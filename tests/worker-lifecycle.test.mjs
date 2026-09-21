import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as profiles from '../lib/local/network-profiles.mjs';
import * as identity from '../lib/local/wallet-identity.mjs';
import * as connection from '../lib/local/connection.mjs';
const filename = new URL('../lib/local/wallet.worker.mjs', import.meta.url).pathname;
const source=fs.readFileSync(filename,'utf8').replace(/^import .*;\n/gm,'');

// Exercise the actual worker message/lifecycle code, replacing only native I/O
// and engine internals. No real seed, network connection or wallet is created.
function fixture(){
  const files=new Map(),results=[],engines=[],routes=[],transports=[];
  let failConnection=false,failClose=false,failNextStart=false,cleared=0,vaultClosed=0;
  const initial={id:'test-wallet',network:'mainnet',lfbw:{enabled:true,primaryUri:'old-primary'},electrum:{host:'bitkit.to',port:9999,tls:true}};
  files.set('/wallet/registry.json',new TextEncoder().encode(JSON.stringify({record:initial,mnemonic:'synthetic fixture string'})));
  const volume={read:p=>files.get(p)||null,write:(p,b)=>files.set(p,b),remove:p=>files.delete(p),rename:(a,b)=>{files.set(b,files.get(a));files.delete(a)},list:p=>[...files.keys()].filter(x=>x.startsWith(p)),clearMemory(){cleared++}};
  const context=vm.createContext({console,TextEncoder,TextDecoder,URL,Error,setTimeout:()=>1,clearTimeout(){},fetch(){},self:{location:{origin:'http://localhost:8787'},postMessage:r=>results.push(r)},...profiles,...identity,...connection,
    openBrowserStore:async()=>({close(){}}),unlockVault:async()=>({close(){vaultClosed++}}),inspectVault(){},createVolume:()=>volume,
    automaticConnection:async(_origin,_fetch,profile)=>{if(failConnection)throw new Error('provisioning failed');routes.push(structuredClone(profile));return {...profile,managed:true,electrumUrl:'ws://localhost:8787/transport/electrum',peerUrl:'ws://localhost:8787/transport/peer',token:'a'.repeat(32),expiresAt:Date.now()+300000}},sameConnection:()=>true,
    createSqlJsDatabaseFactory:async()=>()=>{},createTransport:config=>{transports.push(structuredClone(config));return {socketFactory:()=>{},close(){}}},createPortableRuntime:async options=>{
      const raw=options.volume.read('/wallet/registry.json');
      let registry=raw && JSON.parse(new TextDecoder().decode(raw));
      let record=registry?.record;
      const engine={get record(){return record},started:false,closed:false,calls:[],async close(){if(failClose)throw new Error('durability failure');this.closed=true},async request(req){
        this.calls.push(req);
        if(req.path==='/api/wallets'&&req.method==='GET')return record?[structuredClone({...record,status:this.started?'running':'stopped'})]:[];
        if(req.path==='/api/wallets'&&req.method==='POST'){
          assert.equal(record,undefined,'Existing identities must never be overwritten');
          record={id:req.body.network+'-wallet',network:req.body.network,lfbw:structuredClone(req.body.lfbw),electrum:options.electrum};
          registry={record,mnemonic:req.body.mnemonic || 'new synthetic fixture phrase'};
          options.volume.write('/wallet/registry.json',new TextEncoder().encode(JSON.stringify(registry)));
          return structuredClone(registry);
        }
        if(req.method==='PATCH'){
          record.lfbw=structuredClone(req.body.lfbw);
          options.volume.write('/wallet/registry.json',new TextEncoder().encode(JSON.stringify(registry)));
        }
        if(req.path.endsWith('/start')||req.method==='PATCH'){
          if(failNextStart){failNextStart=false;throw new Error('new route failed')}
          this.started=true;
        }
        return structuredClone(record);
      }};engines.push(engine);return engine;
    },
  });
  vm.runInContext(source,context,{filename});
  let id=0;
  const call=async(operation,payload)=>{await context.self.onmessage({data:{id:++id,operation,payload}});return results.at(-1)};
  return {call,engines,routes,transports,initial,files,setFailConnection:v=>failConnection=v,setFailClose:v=>failClose=v,setFailNextStart:v=>failNextStart=v,counts:()=>({cleared,vaultClosed})};
}
const profile=primaryUri=>({network:'mainnet',primaryUri,electrum:{host:'bitkit.to',port:9999,tls:true}});
async function open(f){await f.call('unlock',{password:'',automatic:true});await f.call('request',{path:'/api/wallets/test-wallet/start',method:'POST'})}

test('failed provisioning preserves the currently running wallet',async()=>{
  const f=fixture();await open(f);f.setFailConnection(true);
  const response=await f.call('switch-network',profile('old-primary'));
  assert.ok(response.error);
  assert.equal(f.engines.length,1);
  assert.equal(f.engines[0].closed,false);
  assert.equal(f.engines[0].started,true);
});
test('explicit reconnect updates stored primary before starting the changed route',async()=>{
  const f=fixture();await open(f);
  const response=await f.call('switch-network',profile('new-primary'));
  assert.equal(response.error,undefined);
  assert.equal(f.engines[1].record.lfbw.primaryUri,'new-primary');
  assert.equal(response.result.wallet.lfbw.primaryUri,'new-primary');
  assert.equal(f.engines[1].started,true);
});
test('failed runtime shutdown retains vault and lease for retry',async()=>{
  const f=fixture();await open(f);f.setFailClose(true);
  const response=await f.call('close');
  assert.ok(response.error);
  assert.equal(f.engines[0].closed,false);
  assert.deepEqual(f.counts(),{cleared:0,vaultClosed:0});
  f.setFailClose(false);await f.call('close');
  assert.deepEqual(f.counts(),{cleared:1,vaultClosed:1});
});
test('failure after switching restores and starts the previous wallet and primary',async()=>{
  const f=fixture();await open(f);f.setFailNextStart(true);
  const response=await f.call('switch-network',{...profile('new-primary'),electrum:{host:'bad-server.example',port:9998,tls:true}});
  assert.ok(response.error);
  assert.equal(f.engines.length,3);
  assert.equal(f.engines[2].record.lfbw.primaryUri,'old-primary');
  assert.equal(f.engines[2].started,true);
  await f.call('close');await f.call('unlock',{password:'',automatic:true});
  assert.equal(f.routes.at(-1).electrum.host,'bitkit.to');
  assert.equal(f.routes.at(-1).electrum.port,9999);
  assert.equal(f.routes.at(-1).primaryUri,'old-primary');
});
test('saving a primary default cannot silently retarget an existing wallet during ordinary reopen',async()=>{
  const f=fixture();await open(f);
  await f.call('save-network',profile('new-default'));
  await f.call('close');
  await f.call('unlock',{password:'',automatic:true});
  assert.equal(f.routes.at(-1).primaryUri,'old-primary');
});

test('first switch reuses the original phrase without returning another backup, and restart retains both identities',async()=>{
  const f=fixture();await open(f);
  const original=f.files.get('/wallet/registry.json').slice();
  const switched=await f.call('switch-network',{...profile('test-primary'),network:'testnet'});
  assert.equal(switched.error,undefined);
  assert.equal(switched.result.wallet.network,'testnet');
  assert.equal(switched.result.mnemonic,undefined);
  const saved=JSON.parse(new TextDecoder().decode(f.files.get('/networks/testnet/wallet/registry.json')));
  assert.equal(saved.mnemonic,'synthetic fixture string');
  assert.deepEqual(f.files.get('/wallet/registry.json'),original);
  await f.call('close');await f.call('unlock',{password:'',automatic:true});
  const back=await f.call('switch-network',profile('old-primary'));
  assert.equal(back.result.wallet.id,'test-wallet');
  assert.equal(f.engines.at(-1).started,true);
  assert.equal(f.engines.filter(e=>e.calls.some(c=>c.path==='/api/wallets'&&c.method==='POST')).length,1);
});

test('legacy distinct network wallets retain their phrase and channel state and are identified in settings',async()=>{
  const f=fixture();await open(f);
  const registry=new TextEncoder().encode(JSON.stringify({record:{...f.initial,id:'legacy-test',network:'testnet'},mnemonic:'different legacy fixture phrase'}));
  const channels=new Uint8Array([3,6,9]);
  f.files.set('/networks/testnet/wallet/registry.json',registry);
  f.files.set('/networks/testnet/wallet/channels.sqlite',channels);
  const switched=await f.call('switch-network',{...profile('old-primary'),network:'testnet'});
  assert.equal(switched.error,undefined);
  assert.equal(switched.result.wallet.id,'legacy-test');
  assert.deepEqual(f.files.get('/networks/testnet/wallet/registry.json'),registry);
  assert.deepEqual(f.files.get('/networks/testnet/wallet/channels.sqlite'),channels);
  const settings=await f.call('network-settings');
  assert.deepEqual(settings.result.recovery,{sourceNetwork:'mainnet',separateNetworks:['testnet']});
  assert.ok(!JSON.stringify(settings.result).includes('phrase'));
});

test('a missing referenced seed source prevents creating a replacement and leaves the running wallet open',async()=>{
  const f=fixture();await open(f);
  f.files.set('/browser-wallet-identity.json',new TextEncoder().encode(JSON.stringify({version:1,network:'regtest',walletId:'missing'})));
  const switched=await f.call('switch-network',{...profile('test-primary'),network:'testnet'});
  assert.match(switched.error.message,/original wallet is unavailable/);
  assert.equal(f.engines[0].closed,false);
  assert.equal(f.engines.length,1);
  assert.equal(f.files.has('/networks/testnet/wallet/registry.json'),false);
});

test('a first-run profile with a manual connection starts the engine without the origin transport and keeps the connection through wallet creation',async()=>{
  const f=fixture();
  const connection={mode:'direct',peerUrl:'ws://127.0.0.1:19847',chain:{kind:'electrum-ws',url:'ws://127.0.0.1:60004'}};
  const opened=await f.call('unlock',{password:'',automatic:true,profile:{network:'regtest',primaryUri:'pk@127.0.0.1:19846',electrum:{host:'127.0.0.1',port:60001,tls:false},connection}});
  assert.equal(opened.error,undefined);
  assert.equal(f.routes.length,0,'The origin transport service is never asked');
  assert.deepEqual(f.transports.at(-1).direct,{peerUrl:'ws://127.0.0.1:19847/',chain:{kind:'electrum-ws',url:'ws://127.0.0.1:60004/'}});
  assert.deepEqual(f.transports.at(-1).electrum,{host:'127.0.0.1',port:60004,tls:false},'The engine addresses the chain source by its URL');
  const saved=JSON.parse(new TextDecoder().decode(f.files.get('/networks/regtest/browser-network.json')));
  assert.equal(saved.mode,'direct');
  assert.equal(saved.token,undefined);
  await f.call('request',{method:'POST',path:'/api/wallets',body:{name:'w',network:'regtest',lfbw:{enabled:true,primaryUri:'pk@127.0.0.1:19846'}}});
  const settings=await f.call('network-settings');
  assert.equal(settings.result.activeNetwork,'regtest');
  assert.deepEqual(settings.result.profiles.regtest.connection,{mode:'direct',peerUrl:'ws://127.0.0.1:19847/',chain:{kind:'electrum-ws',url:'ws://127.0.0.1:60004/'}});
  const relay=await f.call('switch-network',{network:'regtest',primaryUri:'pk@127.0.0.1:19846',electrum:{host:'127.0.0.1',port:60001,tls:false},connection:{mode:'relay',url:'ws://127.0.0.1:8790',token:'d'.repeat(43)}});
  assert.equal(relay.error,undefined);
  assert.equal(f.routes.length,0);
  assert.equal(f.transports.at(-1).mode,'relay');
  assert.equal(f.transports.at(-1).peerUrl,'ws://127.0.0.1:8790/peer');
});
