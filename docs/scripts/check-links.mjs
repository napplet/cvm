import { readdir, readFile, stat } from 'node:fs/promises';
import { resolve, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../.vitepress/dist/', import.meta.url));
async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  return (await Promise.all(entries.map(e => e.isDirectory() ? walk(resolve(dir, e.name)) : [resolve(dir, e.name)]))).flat();
}
const files = (await walk(root)).filter(file => file.endsWith('.html'));
const cache = new Map();
async function html(file) { if (!cache.has(file)) cache.set(file, await readFile(file, 'utf8')); return cache.get(file); }
async function exists(file) { try { return (await stat(file)).isFile(); } catch { return false; } }
const errors = []; let links = 0;
for (const file of files) {
  const route = '/docs/' + relative(root, file).replaceAll('\\', '/').replace(/index\.html$/, '').replace(/\.html$/, '');
  const content = await html(file);
  for (const match of content.matchAll(/\b(?:href|src)="([^"]+)"/g)) {
    const raw = match[1].replaceAll('&amp;', '&');
    if (!raw || /^(?:https?:|mailto:|tel:|data:|javascript:|\/\/)/.test(raw)) continue;
    const url = new URL(raw, `https://docs.invalid${route}`);
    if (!url.pathname.startsWith('/docs/')) { errors.push(`${route}: outside /docs/: ${raw}`); continue; }
    const path = resolve(root, decodeURIComponent(url.pathname.slice('/docs/'.length)));
    if (path !== resolve(root) && !path.startsWith(resolve(root) + '/')) { errors.push(`${route}: path escape: ${raw}`); continue; }
    const candidates = [path, ...(!extname(path) ? [path + '.html', resolve(path, 'index.html')] : [])];
    let target;
    for (const candidate of candidates) if (await exists(candidate)) { target = candidate; break; }
    if (!target) { errors.push(`${route}: missing ${raw}`); continue; }
    if (url.hash && target.endsWith('.html')) {
      const id = decodeURIComponent(url.hash.slice(1));
      const ids = new Set(Array.from((await html(target)).matchAll(/\bid="([^"]+)"/g), m => m[1]));
      if (!ids.has(id)) errors.push(`${route}: missing fragment ${raw}`);
    }
    links++;
  }
}
if (errors.length) { console.error([...new Set(errors)].join('\n')); process.exitCode = 1; }
else console.log(`Checked ${files.length} HTML pages and ${links} local links/assets/fragments under /docs/.`);
