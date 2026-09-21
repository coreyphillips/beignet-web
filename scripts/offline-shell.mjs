import { readdirSync, readFileSync, writeFileSync, statSync, copyFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, relative, join } from 'node:path';
// The app may be served under a path prefix (a GitHub Pages project site). The
// export then places the route at dist/client/<base>.html and its assets under
// dist/client/<base>/, so that directory becomes the site root and receives the
// page as index.html; the offline cache lists every path with the prefix.
const base = (process.env.BEIGNET_BASE_PATH || '').replace(/^\/+|\/+$/g, '');
const client = resolve('dist/client');
const directory = base ? join(client, base) : client;
if (base) {
  copyFileSync(join(client, `${base}.html`), join(directory, 'index.html'));
  if (existsSync(join(client, '404.html'))) copyFileSync(join(client, '404.html'), join(directory, '404.html'));
}
const prefix = base ? `/${base}` : '';
function walk(dir) { return readdirSync(dir).flatMap((name) => { const path = resolve(dir, name); return statSync(path).isDirectory() ? walk(path) : [path]; }); }
const files = walk(directory).filter((path) => !path.endsWith('.map') && !path.endsWith('/sw.js'));
const digest = createHash('sha256');
for (const file of files.sort()) digest.update(relative(directory, file)).update(readFileSync(file));
const cache = `beignet-shell-${digest.digest('hex').slice(0, 20)}`;
const paths = files.map((path) => prefix + '/' + relative(directory, path));
const worker = `// Generated app-only offline cache. Never caches wallet API calls or secrets.
const CACHE = ${JSON.stringify(cache)};
const FILES = ${JSON.stringify(paths)};
const ROOT = ${JSON.stringify(prefix + '/')};
const INDEX = ${JSON.stringify(prefix + '/index.html')};
const ALLOWED = new Set(FILES);
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(FILES))));
// Do not skipWaiting: an open wallet must keep the engine version it started.
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(names => Promise.all(names.filter(name => name.startsWith('beignet-shell-') && name !== CACHE).map(name => caches.delete(name))))));
self.addEventListener('fetch', event => {
  const request = event.request, url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (request.mode === 'navigate' && (url.pathname === ROOT || url.pathname === ROOT.slice(0, -1))) {
    event.respondWith(caches.open(CACHE).then(async cache => (await cache.match(INDEX)) || fetch(request)));
  } else if (ALLOWED.has(url.pathname)) {
    event.respondWith(caches.open(CACHE).then(async cache => (await cache.match(url.pathname)) || fetch(request)));
  }
});
`;
writeFileSync(resolve(directory, 'sw.js'), worker);
console.log(`Offline app shell generated in ${relative(process.cwd(), directory)} (${files.length} static files; wallet data excluded).`);
