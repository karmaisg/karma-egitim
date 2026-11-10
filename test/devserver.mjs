// Yerel deneme sunucusu (yalnızca test için): public/ klasörünü ve /api'yi bellek içi veritabanıyla sunar.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from '../src/index.js';
import { createD1 } from './d1shim.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };

// _headers dosyasındaki başlıkları oku (üretimdeki Cloudflare davranışını taklit eder)
const extraHeaders = {};
for (const line of fs.readFileSync(path.join(root, '_headers'), 'utf8').split('\n').slice(1)) {
  const i = line.indexOf(':');
  if (i > 0) extraHeaders[line.slice(0, i).trim()] = line.slice(i + 1).trim();
}

const env = {
  DB: createD1(),
  SETUP_CODE: 'deneme-kodu-123',
  ASSETS: {
    async fetch(request) {
      let p = new URL(request.url).pathname;
      if (p === '/') p = '/index.html';
      const file = path.join(root, path.normalize(p));
      if (!file.startsWith(root) || !fs.existsSync(file) || file.endsWith('_headers')) return new Response('Not found', { status: 404 });
      return new Response(fs.readFileSync(file), { headers: { 'content-type': types[path.extname(file)] || 'application/octet-stream', ...extraHeaders } });
    },
  },
};

const port = Number(process.env.PORT || 8787);
http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const request = new Request(`http://localhost:${port}${req.url}`, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body });
  const response = await worker.fetch(request, env);
  const headers = {};
  response.headers.forEach((v, k) => { headers[k] = v; });
  const setCookie = response.headers.get('set-cookie');
  if (setCookie) headers['set-cookie'] = setCookie;
  res.writeHead(response.status, headers);
  res.end(Buffer.from(await response.arrayBuffer()));
}).listen(port, () => console.log('hazır: http://localhost:' + port));
