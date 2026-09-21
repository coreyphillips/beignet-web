// Render the actual onboarding component with isolated synthetic storage status.
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { create, act } from 'react-test-renderer';
import ts from 'typescript';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const require = createRequire(import.meta.url);
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const textOf = node => typeof node === 'string' ? node : (node?.children || []).map(textOf).join('');

async function fixture(t) {
  const inspection = deferred(); let nextInspection = inspection.promise;
  const calls = { opens: 0, creates: 0, starts: 0, connects: 0 };
  class Session {
    client = {
      async listWallets() { return [{ id: 'saved-wallet', name: 'Existing wallet' }]; },
      selectWallet() {},
      async startWallet() { calls.starts++; },
      async createWallet() { calls.creates++; throw Error('Creation must not run'); },
    };
    inspect() { return nextInspection; }
    async open() { calls.opens++; return { defaults: {} }; }
    destroy() {}
  }
  const primitive = tag => ({ children, ...props }) => React.createElement(tag, props, children);
  const source = ts.transpileModule(fs.readFileSync(new URL('../app/local-connection.tsx', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  const localRequire = name => {
    if (name === '@/lib/local/client') return { BrowserWalletSession: Session };
    if (name === '@/components/ui/input') return { Input: primitive('input') };
    if (name === '@/components/ui/button') return { Button: primitive('button') };
    if (name === '@/components/ui/spinner') return { Spinner: primitive('spinner') };
    return require(name);
  };
  const context = vm.createContext({ console, Error, navigator: { storage: { persist: async () => true } } });
  vm.runInContext(`(function(require,module,exports){${source}\n})`, context)(localRequire, module, module.exports);
  let tree;
  await act(async () => { tree = create(React.createElement(module.exports.LocalConnection, {
    onConnect: () => { calls.connects++; }, back() {}, BackupView: primitive('backup'),
  })); });
  t.after(async () => { await act(async () => tree.unmount()); });
  return { tree, calls, inspection, text: () => textOf(tree.toJSON()),
    next: found => { nextInspection = Promise.resolve(found); },
    button: label => tree.root.findAllByType('button').find(node => textOf(node) === label) };
}

test('an unreadable wallet stays an opening error, never a new-wallet setup, and retry opens the existing identity', async t => {
  const f = await fixture(t);
  assert.match(f.text(), /Checking for a saved wallet/);
  assert.doesNotMatch(f.text(), /Create your wallet|save your recovery phrase/);
  assert.equal(f.tree.root.findAllByType('form').length, 0);
  await act(async () => f.inspection.reject(new RangeError('Maximum call stack size exceeded')));
  assert.match(f.text(), /Could not open wallet.*Maximum call stack size exceeded/);
  assert.doesNotMatch(f.text(), /Create your wallet|save your recovery phrase/);
  assert.equal(f.tree.root.findAllByType('form').length, 0); assert.equal(f.calls.creates, 0);
  f.next({ exists: true, passwordRequired: false });
  await act(async () => f.button('Try again').props.onClick());
  assert.match(f.text(), /Welcome back/); assert.ok(f.button('Open wallet'));
  await act(async () => f.tree.root.findByType('form').props.onSubmit({ preventDefault() {} }));
  assert.equal(f.calls.opens, 1); assert.equal(f.calls.starts, 1); assert.equal(f.calls.connects, 1); assert.equal(f.calls.creates, 0);
});

test('creation is offered only after inspection confirms there is no saved wallet', async t => {
  const f = await fixture(t);
  await act(async () => f.inspection.resolve({ exists: false, passwordRequired: false }));
  assert.match(f.text(), /Create your wallet/); assert.match(f.text(), /Next, save your recovery phrase/);
  assert.ok(f.button('Continue')); assert.equal(f.calls.creates, 0);
});
