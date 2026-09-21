import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, relative } from 'node:path';
const directory = resolve('dist/client');
function walk(dir) { return readdirSync(dir).flatMap((name) => { const path = resolve(dir, name); return statSync(path).isDirectory() ? walk(path) : [path]; }); }
const files = walk(directory).filter((path) => !path.endsWith('.map') && !path.endsWith('/sw.js'));
const digest = createHash('sha256');
for (const file of files.sort()) digest.update(relative(directory, file)).update(readFileSync(file));
const cache = `beignet-shell-${digest.digest('hex').slice(0, 20)}`;
const paths = files.map((path) => '/' + relative(directory, path));
const worker = `// Generated app-only offline cache. Never caches wallet API calls or secrets.
const CACHE = ${JSON.stringify(cache)};
const FILES = ${JSON.stringify(paths)};
const ALLOWED = new Set(FILES);
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(FILES))));
// Do not skipWaiting: an open wallet must keep the engine version it started.
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(names => Promise.all(names.filter(name => name.startsWith('beignet-shell-') && name !== CACHE).map(name => caches.delete(name))))));
self.addEventListener('fetch', event => {
  const request = event.request, url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (request.mode === 'navigate' && url.pathname === '/') {
    event.respondWith(caches.open(CACHE).then(async cache => (await cache.match('/index.html')) || fetch(request)));
  } else if (ALLOWED.has(url.pathname)) {
    event.respondWith(caches.open(CACHE).then(async cache => (await cache.match(url.pathname)) || fetch(request)));
  }
});
`;
writeFileSync(resolve(directory, 'sw.js'), worker);
console.log(`Offline app shell generated (${files.length} static files; wallet data excluded).`);
