// Execute the exact production worker bundle in a browser-like JS realm (no
// Node globals/builtins) with disk-backed OPFS handles and real WS networking.
// This is a runtime integration test, not browser UI or compatibility testing.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { Worker } from 'node:worker_threads';
import { randomBytes } from 'node:crypto';
import { attachRelay } from '../../beignet-relay/relay.js';
const directory = path.resolve('dist/client');
const workerFile = fs.readdirSync(path.join(directory, '_next/static/workers')).find((f) => f.startsWith('wallet.worker-'));
assert.ok(workerFile, 'Build the web app first');
const source = fs.readFileSync(path.join(directory, '_next/static/workers', workerFile), 'utf8');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'beignet-web-worker-'));
const threads = new Set();
let relay, web, call;
const token = randomBytes(32).toString('base64url');
const password = process.env.BEIGNET_TEST_PASSWORDLESS === '1' ? '' : 'disposable regtest passphrase';
const { createHarness, btc, wait, delay } = await import('../../beignet-engine/scripts/regtest-harness.cjs');
const { EmbeddedWalletClient } = await import('../../shared/src/index.js');
const h=await createHarness({prefix:'beignet-web-ffor-',ffor:true});
const primaryUri=h.primaryUri;
let payer;
function worker(origin) {
  const thread = new Worker(new URL('./worker-harness.mjs', import.meta.url), { workerData: { source, origin, workerFile, temp } });
  threads.add(thread);
  const pending = new Map(); let next = 0;
  let readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  thread.on('message', ({ ready: started, id, result, error }) => {
    if (started) { readyResolve(); return; }
    const waiter = pending.get(id); if (!waiter) return;
    pending.delete(id);
    if (error) waiter.reject(Object.assign(new Error(error.message), error)); else waiter.resolve(result);
  });
  thread.on('error', (error) => { readyReject(error); for (const waiter of pending.values()) waiter.reject(error); pending.clear(); });
  return async (operation, payload) => {
    await ready;
    const result = await new Promise((resolve, reject) => {
      const id = ++next;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Worker ${operation} timed out`)); }, 120000);
      pending.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
      thread.postMessage({ id, operation, payload });
    });
    if (operation === 'close') { await thread.terminate(); threads.delete(thread); }
    return result;
  };
}

try {
		payer = await h.BeignetNode.create({
			network: 'regtest',
			dataDir: path.join(h.temp, 'payer'),
			allowMultipleInstances: true,
			electrumHost: '127.0.0.1',
			electrumPort: 60001,
			electrumTls: false,
			autoBootstrap: false,
			autoGossipSync: false,
			logger: { debug() {}, info() {}, warn() {}, error() {} }
		});
        let payerAddress;
        await wait('payer Electrum ready', async()=>{try{payerAddress=await payer.getNewAddress();return true;}catch{return false;}});
        btc('sendtoaddress', payerAddress, '0.02000000');
		btc('-generate', '1');
		await wait('payer funded', async () => {
			await payer.refreshWallet();
			return payer.getBalance().onchain >= 2000000;
		});
		await payer.connectPeer(
			h.primary.getInfo().nodeId,
			'127.0.0.1',
			h.peerPort
		);
		h.primary.addTrustedPeer(payer.getInfo().nodeId);
		payer.addTrustedPeer(h.primary.getInfo().nodeId);
		payer.openChannel(h.primary.getInfo().nodeId, 300000, 0, 2, false, true);
		await wait('payer channel ready', () =>
			payer.listChannels().some((c) => c.htlcUsable)
		);
		btc('-generate', '6');
		await delay(2000);


  const electrum = { host: '127.0.0.1', port: 60001, tls: false };
  let origin;
  web = http.createServer(async (request, response) => {
    if (request.url === '/api/browser-config') {
      assert.equal(request.headers['x-beignet-transport'], '1');
      let text = ''; for await (const chunk of request) text += chunk;
      const profile = text ? JSON.parse(text) : { network: 'regtest', primaryUri, electrum };
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ ...profile, enabled: true, token, expiresAt: Date.now() + 300000,
        peerUrl: origin.replace('http:', 'ws:') + '/transport/peer', electrumUrl: origin.replace('http:', 'ws:') + '/transport/electrum' }));
      return;
    }
    if (request.url !== '/engine/sql-wasm.wasm') { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'Content-Type': 'application/wasm' });
    response.end(fs.readFileSync(path.join(directory, 'engine/sql-wasm.wasm')));
  });
  await new Promise((resolve) => web.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${web.address().port}`;
  relay = attachRelay(web, { host: '127.0.0.1', origins: [origin], token, electrum,
    peer: { host: '127.0.0.1', port: h.peerPort, tls: false } }, {
    authorizeUpgrade: (request, supplied) => request.headers.origin === origin && supplied === token,
  });

  const options={network:'regtest',primaryUri,electrum,token,electrumUrl:origin.replace('http:','ws:')+'/transport/electrum',peerUrl:origin.replace('http:','ws:')+'/transport/peer'};
  call=worker(origin);
  await call('unlock',{password,options});
  let client=new EmbeddedWalletClient({runtime:{request:request=>call('request',request),close:()=>call('close')}});
  const wallet=await client.createWallet({name:'Browser offline receipt',network:'regtest',primaryUri,electrum});
  const request=await client.receive(await client.quoteReceive({amountSats:20000,description:'Browser offline receipt'}));
  assert.equal(request.offlineReceive,true);
  await call('close');
  console.log('PASS production worker stopped with a durable receive request');
  const paid=await payer.payInvoiceSafe(request.bolt11,30000,100);
  assert.equal(paid.status,'COMPLETED',JSON.stringify(paid));
  console.log('PASS payment completed while the web wallet worker was stopped');
  async function reopen(){
    call=worker(origin);await call('unlock',{password,options});
    client=new EmbeddedWalletClient({runtime:{request:request=>call('request',request),close:()=>call('close')},walletId:wallet.id});
    await client.startWallet();
  }
  await reopen();
  await wait('web worker automatic recovery',async()=>{
    const rows=(await client.snapshot()).activity.filter(row=>row.paymentHash===request.paymentHash&&row.status==='completed');
    return rows.length===1&&rows[0].amountSats===20000;
  });
  await call('close');await reopen();
  const rows=(await client.snapshot()).activity.filter(row=>row.paymentHash===request.paymentHash&&row.status==='completed');
  assert.equal(rows.length,1);
  console.log('PASS encrypted web wallet recovery survives another worker restart without duplicates');
}finally{
  if(call)await call('close').catch(()=>{});
  for(const thread of threads)await thread.terminate();
  if(relay)await relay.close();if(web)await new Promise(resolve=>web.close(resolve));
  if(payer)await payer.gracefulShutdown(5000).catch(()=>{});await h.close();
  fs.rmSync(temp,{recursive:true,force:true});
}
