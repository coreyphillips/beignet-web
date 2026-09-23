// Actual React components and hooks, with synthetic wallet I/O and host-element
// primitives. No browser, user storage, engine, wallet keys or network is used.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { create, act } from 'react-test-renderer';
import ts from 'typescript';
import * as core from '@beignet/wallet-core';
import * as profiles from '../lib/local/network-profiles.mjs';
import * as settingsUpdate from '../lib/settings-update.mjs';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const require = createRequire(import.meta.url);
const rootDir = new URL('..', import.meta.url).pathname;
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const textOf = node => typeof node === 'string' ? node : (node?.children || []).map(textOf).join('');

async function fixture(t, preset = {}) {
  const initial = { id: 'main-wallet', name: 'Settings fixture', network: 'mainnet', status: 'running', lfbw: { enabled: true, primaryUri: 'old-primary', setup: 'ready' } };
  let record = structuredClone(initial), prefs = { activeNetwork: 'mainnet', profiles: profiles.defaultProfiles() };
  prefs.profiles.mainnet.primaryUri = 'old-primary'; prefs.profiles.regtest.primaryUri = 'regtest-primary';
  const calls = { switches: 0, saves: 0, retries: 0, snapshots: 0, quotes: 0, receives: 0, imports: [] };
  const control = { lightningOnly: false, offlineAvailable: true, activity: [], receivableSats: 100000, quoteError: null, importError: null, gate: null, failSnapshot: false, setupFailed: false, snapshotGate: null, receiptGate: null,
    receipt: { phase: 'waiting', receivedSats: 0, confirmedSats: 0, pendingSats: 0, txids: [] }, ...preset };
  class Embedded {
    connection = { url: 'embedded:', token: '', walletId: record.id };
    selectWallet(id) { this.connection.walletId = id; }
    async listWallets() { return [structuredClone(record)]; }
    async snapshot() {
      calls.snapshots++;
      if (control.snapshotGate) { const wait = control.snapshotGate; control.snapshotGate = null; return wait.promise; }
      if (control.failSnapshot) throw Error('Balance unavailable');
      return snapshot();
    }
    async retrySetup() { calls.retries++; await control.gate?.promise; }
    async startWallet() {}
    async getConfig() { return { offlineReceiveAvailable: control.offlineAvailable }; }
    async prepareSend(input) { calls.lastSend = input; throw Error('Stop at the review.'); }
    async quoteReceive({ amountSats, description, mode }) {
      calls.quotes++; calls.lastQuote = { amountSats, description, mode };
      if (control.quoteError) throw control.quoteError;
      await control.gate?.promise;
      return { id: `receive-review-${calls.quotes}`, amountSats, description, feeSats: 0, netSats: amountSats, expiresAt: Date.now() + 60000, warnings: [] };
    }
    async receive(quote) {
      calls.receives++;
      await control.gate?.promise;
      return { ...quote, paymentHash: 'fixture-payment', uri: control.lightningOnly ? 'lnfixture' : 'bitcoin:fixture',
        ...(control.lightningOnly ? { bitcoinTracking: 'lightning-only' } : {}), offlineReceive:true, warnings: [] };
    }
    async importReceiveRequest(uri, expectedHash) {
      calls.imports.push({ uri, expectedHash });
      await control.gate?.promise;
      if (control.importError) throw control.importError;
      const item = control.activity.find(item => item.paymentHash === expectedHash);
      item.receiveRequest = { ...item.receiveRequest, uri, legacy: false };
      return item.receiveRequest;
    }
    async getReceiveStatus() {
      if (control.receiptGate) return control.receiptGate.promise;
      return structuredClone(control.receipt);
    }
  }
  const client = new Embedded();
  const snapshot = () => ({ wallet: structuredClone(record), balance: { totalSats: 54321, availableSats: 54321, pendingSats: 0, receivableSats: control.receivableSats, ...(control.offlineReceivableSats === undefined ? {} : { offlineReceivableSats: control.offlineReceivableSats }) },
    primary: { uri: record.lfbw.primaryUri, connected: record.lfbw.setup !== 'failed', setup: record.lfbw.setup, setupError: record.lfbw.setupError }, activity: structuredClone(control.activity), notes: [], updatedAt: Date.now() });
  const session = {
    networkSettings: async () => structuredClone(prefs),
    async saveNetwork(profile) { calls.saves++; await control.gate?.promise; prefs.profiles[profile.network] = structuredClone(profile); return structuredClone(prefs); },
    async switchNetwork(profile) {
      calls.switches++; await control.gate?.promise;
      record = { ...record, id: profile.network === 'mainnet' ? 'main-wallet' : 'reg-wallet', network: profile.network,
        lfbw: { enabled: true, primaryUri: profile.primaryUri, setup: control.setupFailed ? 'failed' : 'ready', ...(control.setupFailed ? { setupError: 'The primary node refused the connection.' } : {}) } };
      prefs.activeNetwork = profile.network; prefs.profiles[profile.network] = structuredClone(profile); client.selectWallet(record.id);
      return { wallet: structuredClone(record) };
    },
  };
  const intervals = new Map(), listeners = new Map(); let nextTimer = 0;
  const location = { href: 'http://localhost:8787/', origin: 'http://localhost:8787', pathname: '/', hash: '', search: '' };
  const history = { pushState(_state, _title, url) { location.hash = String(url).includes('#') ? String(url).slice(String(url).indexOf('#')) : ''; }, replaceState(...args) { this.pushState(...args); } };
  const window = { location, history, scrollTo() {}, addEventListener(name, callback) { listeners.set(name, callback); }, removeEventListener(name) { listeners.delete(name); } };
  const document = { hidden: false, addEventListener(name, callback) { listeners.set(name, callback); }, removeEventListener(name) { listeners.delete(name); } };
  const moduleCache = new Map();
  const primitive = tag => function Element({ children, ...props }) { return React.createElement(tag, props, children); };
  const context = vm.createContext({ console, URL, URLSearchParams, Date, Error, window, document, location, history, navigator: {}, localStorage: { getItem: () => null, setItem() {} },
    process: { env: { NODE_ENV: 'test' } }, setTimeout, clearTimeout,
    setInterval(callback, ms) { const id = ++nextTimer; intervals.set(id, { callback, ms }); return id; }, clearInterval(id) { intervals.delete(id); } });
  function load(file) {
    if (moduleCache.has(file)) return moduleCache.get(file).exports;
    const module = { exports: {} }; moduleCache.set(file, module);
    const source = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
    const localRequire = name => {
      if (name === '@beignet/wallet-core') return { ...core, EmbeddedWalletClient: Embedded };
      if (name === '@/lib/local/client') return { browserSession: value => value === client ? session : undefined };
      if (name === './local-connection') return { LocalConnection: ({ onConnect }) => React.createElement('button', { onClick: () => onConnect(client) }, 'Open fixture') };
      if (name === '@/components/ui/button') return { Button: primitive('button') };
      if (name === '@/components/ui/input') return { Input: primitive('input') };
      if (name === '@/components/ui/textarea') return { Textarea: primitive('textarea') };
      if (name.endsWith('/network-profiles.mjs')) return profiles;
      if (name.endsWith('/settings-update.mjs')) return settingsUpdate;
      if (name.startsWith('@/') || name.startsWith('./')) {
        const candidate = name.startsWith('@/') ? path.join(rootDir, name.slice(2)) : path.resolve(path.dirname(file), name);
        return load(['', '.tsx', '.ts'].map(ext => candidate + ext).find(p => fs.existsSync(p)));
      }
      return require(name);
    };
    vm.runInContext(`(function(require,module,exports){${source}\n})`, context, { filename: file })(localRequire, module, module.exports);
    return module.exports;
  }
  const Home = load(path.join(rootDir, 'app/page.tsx')).default;
  let tree;
  await act(async () => { tree = create(React.createElement(Home)); });
  t.after(async () => { await act(async () => tree.unmount()); });
  const button = label => tree.root.findAllByType('button').find(node => textOf(node) === label || (node.props.className === 'mode-choice' && textOf(node).startsWith(label)));
  const click = async label => { const node = button(label); assert.ok(node, `Missing button ${label}`); await act(async () => { node.props.onClick(); }); };
  await click('On this browser'); await click('Open fixture'); await click('Settings');
  const primaryInput = () => tree.root.findAllByType('textarea').find(node => !node.props['aria-label']);
  const editPrimary = async (uri = 'new-primary') => { await click('Change primary'); await act(async () => primaryInput().props.onChange({ target: { value: uri } })); };
  const savePrimary = async () => { await act(async () => { tree.root.findByType('form').props.onSubmit({ preventDefault() {} }); }); };
  return { tree, client, calls, control,
    pollSnapshot: async () => { await act(async () => { await [...intervals.values()].find(timer => timer.ms === 10000).callback(); }); }, location, intervals, snapshot, button, click, primaryInput, editPrimary, savePrimary,
    text: () => textOf(tree.toJSON()), settings: () => tree.root.find(node => typeof node.type === 'function' && node.type.name === 'Settings') };
}

test('primary save keeps Settings mounted, shows progress, blocks competing actions, and confirms in place', async t => {
  const f = await fixture(t); await f.editPrimary(); const settings = f.settings();
  f.control.gate = deferred(); await f.savePrimary();
  assert.equal(f.settings(), settings); assert.equal(f.location.hash, '#settings');
  assert.match(f.text(), /Saving primary and connecting/); assert.match(f.text(), /Network & servers/);
  assert.equal(f.button('Save default').props.disabled, true); assert.equal(f.button('Wallet').props.disabled, true);
  await act(async () => f.control.gate.resolve());
  assert.equal(f.settings(), settings); assert.equal(f.location.hash, '#settings');
  assert.match(f.text(), /Primary saved\. Connected to your primary/); assert.match(f.text(), /new-primary/);
  assert.equal(f.tree.root.findAllByType('textarea').find(n => n.props['aria-label'])?.props.value, 'new-primary');
});
test('failed primary change keeps the typed draft and shows an error in Settings', async t => {
  const f = await fixture(t); await f.editPrimary('unreachable-primary'); f.control.gate = deferred(); await f.savePrimary();
  await act(async () => f.control.gate.reject(Error('Provisioning unavailable')));
  assert.equal(f.location.hash, '#settings'); assert.equal(f.primaryInput().props.value, 'unreachable-primary');
  assert.match(f.text(), /update could not finish.*Provisioning unavailable/); assert.equal(f.button('Save primary').props.disabled, false);
});
test('saved primary with a failed connection shows the new address and a warning without redirecting', async t => {
  const f = await fixture(t); await f.editPrimary(); f.control.setupFailed = true; await f.savePrimary();
  assert.equal(f.location.hash, '#settings'); assert.match(f.text(), /Primary saved\. The primary node refused/);
  assert.match(f.text(), /new-primary/); assert.equal(f.calls.switches, 1);
});
test('a post-save snapshot failure preserves Settings and saved identity without rolling back', async t => {
  const f = await fixture(t); await f.editPrimary(); f.control.failSnapshot = true; const settings = f.settings(); await f.savePrimary();
  assert.equal(f.settings(), settings); assert.match(f.text(), /Primary saved/); assert.match(f.text(), /new-primary/);
  assert.equal(f.location.hash, '#settings'); assert.equal(f.client.connection.walletId, 'main-wallet');
});
test('default save shows progress without reconnecting and preserves unsaved server drafts across primary changes', async t => {
  const f = await fixture(t);
  const input = f.tree.root.findAllByType('input').find(n => n.props.id === 'network-electrum');
  await act(async () => input.props.onChange({ target: { value: 'ssl://draft.example:50002' } }));
  await f.editPrimary(); await f.savePrimary();
  assert.equal(f.tree.root.findAllByType('input').find(n => n.props.id === 'network-electrum').props.value, 'ssl://draft.example:50002');
  f.control.gate = deferred(); await f.click('Save default');
  assert.match(f.text(), /Saving your server settings/); assert.equal(f.calls.switches, 1);
  await act(async () => f.control.gate.resolve());
  assert.match(f.text(), /default saved/); assert.equal(f.calls.switches, 1); assert.equal(f.location.hash, '#settings');
});
test('a network switch stays in Settings and never displays the old balance when the new engine is offline', async t => {
  const f = await fixture(t);
  await act(async () => f.tree.root.findByType('select').props.onChange({ target: { value: 'regtest' } }));
  f.control.failSnapshot = true; await f.click('Switch to Local regtest');
  assert.equal(f.location.hash, '#settings'); assert.equal(f.client.connection.walletId, 'reg-wallet');
  assert.match(f.text(), /Switched to Local regtest/); assert.match(f.text(), /regtest-primary/);
  await f.click('Wallet'); assert.doesNotMatch(f.text(), /54,321/); assert.match(f.text(), /Balance unavailable/);
});
test('a late poll from before the save cannot overwrite the applied primary', async t => {
  const f = await fixture(t); const old = f.snapshot(); const delayed = deferred(); f.control.snapshotGate = delayed;
  await act(async () => { [...f.intervals.values()].find(timer => timer.ms === 10000).callback(); });
  await f.editPrimary(); await f.savePrimary();
  await act(async () => delayed.resolve(old));
  assert.match(f.text(), /new-primary/); assert.equal(f.location.hash, '#settings');
});

test('a delayed receive quote shows a spinner, prevents duplicate requests, and retains the draft on failure', async t => {
  const f = await fixture(t); await f.click('Wallet'); await f.click('Receive');
  const amount = () => f.tree.root.findAllByType('input').find(n => n.props.className === 'amount-input');
  const description = () => f.tree.root.findAllByType('input').find(n => n.props.maxLength === 160);
  await act(async () => { amount().props.onChange({ target: { value: '10000' } }); description().props.onChange({ target: { value: 'Test receive' } }); });
  f.control.gate = deferred();
  const submit = () => f.tree.root.findByType('form').props.onSubmit({ preventDefault() {} });
  await act(async () => { void submit(); void submit(); });
  assert.equal(f.calls.quotes, 1); assert.equal(f.calls.receives, 0);
  assert.equal(f.location.hash, '#receive'); assert.equal(amount().props.disabled, true);
  assert.equal(description().props.disabled, true); assert.equal(f.tree.root.findByType('form').props['aria-busy'], true);
  assert.ok(f.tree.root.findAll(n => n.props['data-slot'] === 'spinner').length);
  assert.match(f.text(), /Checking your primary’s receiving capacity/);
  await act(async () => f.control.gate.reject(Error('Your primary did not answer. Check Liquidity provider in Beignet.')));
  assert.match(f.text(), /Check Liquidity provider/); assert.ok(f.button('Try again'));
  assert.equal(amount().props.value, '10000'); assert.equal(description().props.value, 'Test receive');
  assert.equal(amount().props.disabled, false); assert.equal(f.calls.receives, 0);
  f.control.gate = null; await act(async () => { void submit(); });
  assert.match(f.text(), /Your request/); assert.equal(f.calls.quotes, 2); assert.equal(f.calls.receives, 0);
  assert.equal(f.location.hash, '#receive');
});

test('invoice creation holds the reviewed request in place until completion', async t => {
  const f = await fixture(t); await f.click('Wallet'); await f.click('Receive');
  const amount = f.tree.root.findAllByType('input').find(n => n.props.className === 'amount-input');
  await act(async () => amount.props.onChange({ target: { value: '10000' } }));
  await act(async () => { void f.tree.root.findByType('form').props.onSubmit({ preventDefault() {} }); });
  f.control.gate = deferred(); await f.click('Create request');
  assert.equal(f.calls.receives, 1); assert.equal(f.button('Edit request').props.disabled, true);
  assert.ok(f.tree.root.findAll(n => n.props['data-slot'] === 'spinner').length);
  assert.match(f.text(), /Creating request/); assert.equal(f.location.hash, '#receive');
  await act(async () => f.control.gate.reject(Error('Primary connection interrupted')));
  assert.equal(f.location.hash, '#receive'); assert.match(f.text(), /Primary connection interrupted/);
  assert.ok(f.button('Try again')); assert.equal(f.calls.receives, 1);
});

async function receiveFixture(t) {
  const f = await fixture(t); await f.click('Wallet'); await f.click('Receive');
  await act(async () => f.tree.root.findAllByType('input').find(n => n.props.className === 'amount-input').props.onChange({ target: { value: '10000' } }));
  await act(async () => { void f.tree.root.findByType('form').props.onSubmit({ preventDefault() {} }); });
  await f.click('Create request');
  const poll = async () => { await act(async () => { await [...f.intervals.values()].find(timer => timer.ms === 2000).callback(); }); };
  const qr = () => f.tree.root.findAll(n => n.props.className === 'qr-wrap');
  return { ...f, poll, qr };
}
const received = (phase, amount = 10000) => ({ phase, receivedSats: amount,
  confirmedSats: phase === 'completed' ? amount : 0, pendingSats: phase === 'completed' ? 0 : amount,
  method: 'bitcoin', txids: ['fixture-transaction'] });

test('a Bitcoin payment replaces the QR immediately with awaiting confirmation, then celebrates once confirmed', async t => {
  const f = await receiveFixture(t); assert.equal(f.qr().length, 1);
  f.control.receipt = received('pending'); await f.poll();
  assert.equal(f.qr().length, 0); assert.equal(f.button('Share'), undefined);
  assert.equal(f.tree.root.findAllByType('textarea').length, 0);
  assert.match(f.text(), /Payment detected.*10,000.*Awaiting confirmation/);
  assert.doesNotMatch(f.text(), /Payment received/);
  assert.equal(f.tree.root.findAll(n => n.props.className === 'receipt-confetti').length, 0);
  assert.equal(f.location.hash, '#receive'); assert.ok(f.button('View activity'));
  // No Activity row is needed: the request watcher must work before the full snapshot catches up.
  assert.equal(f.snapshot().activity.length, 0);
  f.control.receipt = received('completed'); await f.poll();
  assert.match(f.text(), /Payment received.*10,000.*Your payment is complete/);
  const burst = f.tree.root.find(n => n.props.className === 'receipt-confetti');
  assert.equal(String(burst.props['aria-hidden']), 'true');
  await f.poll(); assert.equal(f.tree.root.find(n => n.props.className === 'receipt-confetti'), burst);
  await f.click('View activity'); assert.equal(f.location.hash, '#activity');
});

test('a settled Lightning invoice uses the same success screen without waiting for Bitcoin confirmation', async t => {
  const f = await receiveFixture(t);
  f.control.receipt = { ...received('completed', 9900), method: 'lightning', txids: [] }; await f.poll();
  assert.match(f.text(), /Payment received.*9,900/); assert.equal(f.qr().length, 0);
  assert.equal(f.tree.root.findAll(n => n.props.className === 'receipt-confetti').length, 1);
  assert.doesNotMatch(f.text(), /Awaiting confirmation|Share|Payment request/);
});

test('partial payments show the exact amount without success and offer only the unpaid remainder', async t => {
  const f = await receiveFixture(t); f.control.receipt = received('partial', 4000); await f.poll();
  assert.equal(f.qr().length, 0); assert.match(f.text(), /Partial payment received.*4,000.*6,000 sats remaining/);
  assert.equal(f.tree.root.findAll(n => n.props.className === 'receipt-confetti').length, 0);
  await f.click('Request the remaining amount');
  assert.equal(f.tree.root.findAllByType('input').find(n => n.props.className === 'amount-input').props.value, '6000');
});

test('a status lookup failure retains a detected payment and recovers without showing the QR again', async t => {
  const f = await receiveFixture(t); f.control.receipt = received('pending'); await f.poll();
  const gate = deferred(); f.control.receiptGate = gate;
  await act(async () => { void [...f.intervals.values()].find(timer => timer.ms === 2000).callback(); });
  await act(async () => gate.reject(Error('Offline')));
  assert.equal(f.qr().length, 0); assert.match(f.text(), /temporarily unavailable/);
  assert.match(f.text(), /Payment detected/);
  f.control.receiptGate = null; f.control.receipt = received('completed'); await f.poll();
  assert.match(f.text(), /Payment received/); assert.doesNotMatch(f.text(), /temporarily unavailable/);
});

test('a late status from a replaced request cannot complete a new request', async t => {
  const f = await receiveFixture(t); const old = deferred(); f.control.receiptGate = old;
  await act(async () => { void [...f.intervals.values()].find(timer => timer.ms === 2000).callback(); });
  await f.click('New request'); f.control.receiptGate = null;
  await act(async () => f.tree.root.findAllByType('input').find(n => n.props.className === 'amount-input').props.onChange({ target: { value: '20000' } }));
  await act(async () => { void f.tree.root.findByType('form').props.onSubmit({ preventDefault() {} }); });
  await f.click('Create request');
  await act(async () => old.resolve(received('completed')));
  assert.equal(f.qr().length, 1); assert.match(f.text(), /Receive 20,000 sats/);
  assert.doesNotMatch(f.text(), /Payment received/);
});


test('an empty-capacity wallet requests an amount up front and leaves only the description optional', async t => {
  const f = await fixture(t); f.control.receivableSats = 0; await f.pollSnapshot();
  await f.click('Wallet'); await f.click('Receive');
  const amount = () => f.tree.root.findAllByType('input').find(n => n.props.className === 'amount-input');
  assert.equal(amount().props.required, true); assert.equal(amount().props.placeholder, 'Enter amount');
  assert.match(f.text(), /Amount in sats · required/); assert.match(f.text(), /What’s it for\? · optional/);
  assert.match(f.text(), /Enter an amount for your payment request/);
  assert.equal(f.button('Continue').props.disabled, true);
  await act(async () => f.tree.root.findByType('form').props.onSubmit({ preventDefault() {} }));
  assert.equal(f.calls.quotes, 0);
  await act(async () => amount().props.onChange({ target: { value: '10000' } }));
  assert.equal(f.button('Try again').props.disabled, false);
  await act(async () => f.tree.root.findByType('form').props.onSubmit({ preventDefault() {} }));
  assert.equal(f.calls.quotes, 1); assert.match(f.text(), /Your request/);
});

const tickOffline = async f => {
  const box = f.tree.root.findAllByType('input').find(n => n.props.type === 'checkbox');
  assert.ok(box, 'the Receive offline box is offered');
  await act(async () => box.props.onChange({ target: { checked: true } }));
};

test('offline receiving is an opt-in: off, capacity allows an amountless request and no mode is named', async t => {
  const f = await fixture(t); await f.click('Wallet'); await f.click('Receive');
  const amount = () => f.tree.root.findAllByType('input').find(n => n.props.className === 'amount-input');
  assert.equal(amount().props.required, false); assert.equal(amount().props.placeholder, 'Any amount');
  assert.match(f.text(), /Receive offline/); assert.match(f.text(), /provisioned by your primary node just in time/);
  await act(async () => f.tree.root.findByType('form').props.onSubmit({ preventDefault() {} }));
  assert.equal(f.calls.quotes, 1); assert.equal(f.calls.lastQuote.mode, undefined);
  assert.doesNotMatch(f.text(), /Payable while this wallet is closed/);
});

test('the Receive offline box is absent when the engine does not advertise it', async t => {
  const f = await fixture(t); f.control.offlineAvailable = false; await f.click('Wallet'); await f.click('Receive');
  assert.doesNotMatch(f.text(), /Receive offline/);
  assert.equal(f.tree.root.findAllByType('input').some(n => n.props.type === 'checkbox'), false);
});

test('offline receiving requires an amount even with existing capacity and preserves the description', async t => {
  const f = await fixture(t); await f.click('Wallet'); await f.click('Receive');
  await tickOffline(f);
  const amount = () => f.tree.root.findAllByType('input').find(n => n.props.className === 'amount-input');
  assert.equal(amount().props.required, true); assert.equal(amount().props.placeholder, 'Enter amount');
  assert.match(f.text(), /Enter an amount for your payment request/);
  assert.equal(f.button('Continue').props.disabled, true);
  await act(async () => f.tree.root.findAllByType('input').find(n => n.props.maxLength === 160).props.onChange({ target: { value: 'Keep this description' } }));
  f.control.quoteError = new core.WalletError('Enter an amount so your primary node can quote the receive fee.', 'AMOUNT_REQUIRED');
  await act(async () => f.tree.root.findByType('form').props.onSubmit({ preventDefault() {} }));
  assert.equal(f.location.hash, '#receive'); assert.equal(amount().props.required, true);
  assert.equal(f.button('Try again').props.disabled, true); assert.equal(f.calls.receives, 0);
  assert.equal(f.tree.root.findAllByType('input').find(n => n.props.maxLength === 160).props.value, 'Keep this description');
  f.control.quoteError = null; await act(async () => amount().props.onChange({ target: { value: '10000' } }));
  await act(async () => f.tree.root.findByType('form').props.onSubmit({ preventDefault() {} }));
  assert.match(f.text(), /Your request/); assert.equal(f.calls.lastQuote.mode, 'offline');
  assert.match(f.text(), /Payable while this wallet is closed/);
});

test('the Receive offline box is absent when no channel can hold an offline receive', async t => {
  const f = await fixture(t, { offlineReceivableSats: 0 }); await f.click('Wallet'); await f.click('Receive');
  assert.doesNotMatch(f.text(), /Receive offline/);
  assert.equal(f.tree.root.findAllByType('input').some(n => n.props.type === 'checkbox'), false);
});

test('an offline amount above what a channel can hold is stopped on the form', async t => {
  const f = await fixture(t, { offlineReceivableSats: 30000 }); await f.click('Wallet'); await f.click('Receive');
  await tickOffline(f);
  assert.match(f.text(), /Enter 354 to 30,000 sats\./);
  const amount = () => f.tree.root.findAllByType('input').find(n => n.props.className === 'amount-input');
  await act(async () => amount().props.onChange({ target: { value: '30001' } }));
  assert.equal(f.button('Continue').props.disabled, true);
  assert.match(f.text(), /An offline receive can take up to 30,000 sats right now\./);
  await act(async () => f.tree.root.findByType('form').props.onSubmit({ preventDefault() {} }));
  assert.equal(f.calls.quotes, 0);
  await act(async () => amount().props.onChange({ target: { value: '30000' } }));
  assert.equal(f.button('Continue').props.disabled, false);
  await act(async () => f.tree.root.findByType('form').props.onSubmit({ preventDefault() {} }));
  assert.equal(f.calls.lastQuote.mode, 'offline'); assert.equal(f.calls.lastQuote.amountSats, 30000);
});

test('a prepared offline request tells the user they can close the wallet', async t => {
  const f = await fixture(t); await f.click('Wallet'); await f.click('Receive');
  await tickOffline(f);
  await act(async () => f.tree.root.findAllByType('input').find(n => n.props.className === 'amount-input').props.onChange({target:{value:'10000'}}));
  await act(async () => f.tree.root.findByType('form').props.onSubmit({ preventDefault() {} }));
  await f.click('Create request');
  assert.match(f.text(), /You can close your wallet/);
  assert.doesNotMatch(f.text(), /Keep this wallet open/);
});

const historyRequest = () => ({ id: 'payment:fixture-hash', paymentHash: 'fixture-hash', kind: 'request', title: 'Payment request',
  timestamp: Date.now() - 30000, amountSats: 10000, feeSats: 0, status: 'pending', reference: 'fixture-hash', description: '',
  receiveRequest: { id: 'fixture-hash', uri: 'bitcoin:fixture-address?amount=0.0001&lightning=lnfixture', bolt11: 'lnfixture', address: 'fixture-address',
    paymentHash: 'fixture-hash', amountSats: 10000, description: '', expiresAt: Date.now() + 600000, bitcoinTracking: 'unique' } });
async function openHistoryItem(f, item = historyRequest()) {
  f.control.activity = [item]; await f.pollSnapshot(); await f.click('Activity');
  await act(async () => f.tree.root.find(n => n.props.className === 'activity-row').props.onClick());
  return item;
}

test('pending Activity requests expose the saved unified QR and code, then update in place when paid onchain', async t => {
  const f = await fixture(t); const item = await openHistoryItem(f);
  assert.equal(f.location.hash, '#detail'); assert.match(f.text(), /Unpaid/);
  assert.equal(f.tree.root.findAll(n => n.props.className === 'qr-wrap').length, 1);
  assert.equal(f.tree.root.findByType('textarea').props.value, item.receiveRequest.uri); assert.ok(f.button('Copy request'));
  f.control.activity = [{ ...item, kind: 'received', title: 'Bitcoin received', receiveStatus: received('pending') }];
  await f.pollSnapshot(); assert.equal(f.location.hash, '#detail');
  assert.match(f.text(), /Awaiting confirmation/); assert.match(f.text(), /View original request/);
  assert.equal(f.tree.root.findAll(n => n.props.className === 'qr-wrap').length, 0); assert.equal(f.button('Copy request'), undefined);
  f.control.activity[0] = { ...f.control.activity[0], status: 'completed', receiveStatus: received('completed') };
  await f.pollSnapshot(); assert.match(f.text(), /This request has already been paid/);
  // The same logical request remains accessible through the Requests filter after settlement.
  const back = f.tree.root.findAllByType('button').find(n => n.props.className === 'text-button' && textOf(n) === 'Activity');
  await act(async () => back.props.onClick()); await f.click('Requests');
  assert.equal(f.tree.root.findAll(n => n.props.className === 'activity-row').length, 1);
});

test('legacy request linking locks submission to the selected invoice and preserves an invalid draft', async t => {
  const f = await fixture(t); const item = historyRequest();
  item.receiveRequest = { ...item.receiveRequest, uri: 'lnfixture', address: undefined, legacy: true };
  await openHistoryItem(f, item); assert.ok(f.button('Copy invoice')); await f.click('Link original request');
  const original = () => f.tree.root.findAllByType('textarea').find(n => n.props.maxLength === 16000);
  await act(async () => original().props.onChange({ target: { value: 'bitcoin:wrong-invoice' } }));
  f.control.gate = deferred(); f.control.importError = Error('The invoice does not match this entry.');
  const submit = () => f.tree.root.findByType('form').props.onSubmit({ preventDefault() {} });
  await act(async () => { void submit(); void submit(); });
  assert.equal(f.calls.imports.length, 1); assert.equal(f.calls.imports[0].expectedHash, item.paymentHash);
  assert.equal(original().props.disabled, true); assert.match(f.text(), /Linking request/);
  await act(async () => f.control.gate.resolve());
  assert.equal(original().props.value, 'bitcoin:wrong-invoice'); assert.match(f.text(), /invoice does not match/);
  f.control.gate = null; f.control.importError = null;
  await act(async () => original().props.onChange({ target: { value: 'bitcoin:original-request' } }));
  await act(async () => { await submit(); });
  assert.equal(f.location.hash, '#detail'); assert.ok(f.button('Copy request')); assert.equal(f.button('Link original request'), undefined);
  assert.equal(f.tree.root.findByType('textarea').props.value, 'bitcoin:original-request');
});

test('ambiguous Bitcoin requests explain the limitation without presenting an unpaid QR or false success', async t => {
  const f = await fixture(t); const item = historyRequest();
  item.receiveRequest.bitcoinTracking = 'ambiguous'; item.receiveStatusUnavailable = true;
  await openHistoryItem(f, item);
  assert.match(f.text(), /address was shared by multiple requests/); assert.match(f.text(), /updates automatically if paid with Lightning/);
  assert.equal(f.tree.root.findAll(n => n.props.className === 'qr-wrap').length, 0);
  assert.doesNotMatch(f.text(), /already been paid|payment has been detected/);
});


test('reused-address tracking clears a previous Bitcoin detection and explains why it cannot identify a request', async t => {
  const f = await receiveFixture(t); f.control.receipt = received('pending'); await f.poll();
  const gate = deferred(); f.control.receiptGate = gate;
  await act(async () => { void [...f.intervals.values()].find(timer => timer.ms === 2000).callback(); });
  await act(async () => gate.reject(new core.WalletError('Address reused', 'AMBIGUOUS_RECEIVE_ADDRESS')));
  assert.match(f.text(), /address was shared by multiple requests/);
  assert.doesNotMatch(f.text(), /Payment detected|Payment received/);
  assert.equal(f.qr().length, 0); assert.equal(f.button('Share'), undefined);
  assert.equal(f.button('Copy'), undefined); assert.ok(f.button('View activity'));
  f.control.receiptGate = null; f.control.receipt = { ...received('completed'), method: 'lightning', txids: [] };
  await f.poll(); assert.match(f.text(), /Payment received/); assert.equal(f.qr().length, 0);
});


test('receiving capacity recovery does not remove the offline invoice amount requirement', async t => {
  const f = await fixture(t); await f.click('Wallet'); await f.click('Receive');
  await tickOffline(f);
  f.control.receivableSats = 0; await f.pollSnapshot();
  f.control.receivableSats = 100000; await f.pollSnapshot();
  assert.match(f.text(), /Amount in sats · required/); assert.equal(f.button('Continue').props.disabled, true);
  await act(async () => f.tree.root.findByType('form').props.onSubmit({ preventDefault() {} }));
  assert.equal(f.calls.quotes, 0);
});

test('an import completing after leaving Activity cannot interrupt a pending settings save', async t => {
  const f = await fixture(t); const item = historyRequest(); item.receiveRequest.legacy = true;
  await openHistoryItem(f, item); await f.click('Link original request');
  await act(async () => f.tree.root.findAllByType('textarea').find(n => n.props.maxLength === 16000).props.onChange({ target: { value: item.receiveRequest.uri } }));
  const importGate = deferred(); f.control.gate = importGate;
  await act(async () => { void f.tree.root.findByType('form').props.onSubmit({ preventDefault() {} }); });
  await f.click('Settings'); await f.editPrimary();
  const settingsGate = deferred(); f.control.gate = settingsGate; await f.savePrimary();
  const snapshots = f.calls.snapshots;
  await act(async () => importGate.resolve());
  assert.equal(f.calls.snapshots, snapshots, 'Unmounted detail must not refresh during a settings operation');
  await act(async () => settingsGate.resolve());
  assert.equal(f.location.hash, '#settings'); assert.match(f.text(), /Primary saved/);
  assert.equal(f.button('Wallet').props.disabled, false);
});


test('a Lightning-only fallback keeps a usable invoice QR and tracks settlement normally', async t => {
  const f = await fixture(t); f.control.lightningOnly = true;
  await f.click('Wallet'); await f.click('Receive');
  await act(async () => f.tree.root.findAllByType('input').find(n => n.props.className === 'amount-input').props.onChange({target:{value:'10000'}}));
  await act(async () => f.tree.root.findByType('form').props.onSubmit({ preventDefault() {} }));
  await f.click('Create request');
  assert.match(f.text(), /This request accepts Lightning/);
  assert.equal(f.tree.root.findByType('textarea').props.value, 'lnfixture');
  assert.equal(f.tree.root.findAll(n => n.props.className === 'qr-wrap').length, 1);
  assert.equal(f.button('Share').props.disabled, false);
  f.control.receipt = { ...received('completed'), method: 'lightning', txids: [] };
  await act(async () => { await [...f.intervals.values()].find(timer => timer.ms === 2000).callback(); });
  assert.match(f.text(), /Payment received/); assert.equal(f.button('Share'), undefined);
});

// A structurally valid 24,425 sat invoice: the amount is all the form reads.
const INVOICE_24425 = 'lnbc244250n1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqw53adf';

test('a request that names its amount fills the send amount and locks it', async t => {
  const f = await fixture(t); await f.click('Wallet'); await f.click('Send');
  const request = () => f.tree.root.findByType('textarea');
  const amount = () => f.tree.root.findAllByType('input').find(n => n.props.className === 'amount-input');
  await act(async () => request().props.onChange({ target: { value: INVOICE_24425 } }));
  assert.equal(amount().props.value, '24,425'); assert.equal(amount().props.readOnly, true);
  assert.match(f.text(), /Set by the payment request\./);
  await act(async () => f.tree.root.findByType('form').props.onSubmit({ preventDefault() {} }));
  assert.equal(f.calls.lastSend.request, INVOICE_24425); assert.equal('amountSats' in f.calls.lastSend, false);
  await act(async () => request().props.onChange({ target: { value: 'lnbc-typed' } }));
  assert.equal(amount().props.readOnly, false); assert.equal(amount().props.value, '');
  assert.match(f.text(), /Leave the amount empty if it’s already in the request/);
});
