#!/usr/bin/env node
// rigcheck: check rigged, animated three.js characters for broken skinning and impossible poses, and render close-ups
// for a human (or an AI critic) to look at.
//
//   npx rigcheck --model zombie.glb [--model more.glb ...] [--anims moves.glb ...] [--clips walk,run] [--out rigcheck-report]
//
// Starts a local server, opens the check page in your normal browser (WebGL is needed for the close-ups), waits for the
// results, writes <out>/index.html, report.json and the close-up images, and exits with code 1 if anything failed.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

function parseArgs(argv) {
  const a = { model: [], anims: [], clips: [], out: 'rigcheck-report', port: 0, open: true, frames: 12, size: 384 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i], v = () => argv[++i];
    if (k === '--model' || k === '-m') a.model.push(v());
    else if (k === '--anims' || k === '-a') a.anims.push(v());
    else if (k === '--clips') a.clips.push(...v().split(',').map(s => s.trim()).filter(Boolean));
    else if (k === '--out' || k === '-o') a.out = v();
    else if (k === '--port') a.port = +v();
    else if (k === '--frames') a.frames = +v();
    else if (k === '--size') a.size = +v();
    else if (k === '--no-open') a.open = false;
    else if (k === '--help' || k === '-h') a.help = true;
    else if (!k.startsWith('-')) a.model.push(k);
    else { console.error('unknown option ' + k); process.exit(2); }
  }
  return a;
}

const args = parseArgs(process.argv.slice(2));
if (args.help || !args.model.length) {
  console.log(`rigcheck: find broken skinning and impossible poses in rigged three.js characters

  npx rigcheck --model zombie.glb [--model b.glb] [--anims moves.glb] [--clips walk,run] [--out dir]

  --model, -m   a GLB/GLTF character (rigged). Repeat for several. Its own animations are checked.
  --anims, -a   a GLB with animation clips on a humanoid skeleton (e.g. Mixamo); every clip is moved onto every model.
  --clips       only these clip names
  --frames      frames sampled per clip (default 12)
  --size        close-up size in pixels (default 384)
  --out, -o     report folder (default rigcheck-report)
  --no-open     print the URL instead of opening a browser`);
  process.exit(args.help ? 0 : 2);
}

// files the page may load: only the ones named on the command line, by index (no path from the browser is trusted)
const files = [...args.model, ...args.anims].map(f => path.resolve(f));
for (const f of files) if (!fs.existsSync(f)) { console.error('not found: ' + f); process.exit(2); }
const config = {
  models: args.model.map((f, i) => ({ name: path.basename(f).replace(/\.(glb|gltf)$/i, ''), url: `/file/${i}` })),
  anims: args.anims.map((f, i) => ({ name: path.basename(f), url: `/file/${args.model.length + i}` })),
  clips: args.clips, frames: args.frames, shotSize: args.size,
};
// three's package.json isn't exported; find the package folder from its main file (…/three/build/three.cjs)
let threeRoot = path.dirname(require.resolve('three'));
while (!fs.existsSync(path.join(threeRoot, 'package.json'))) threeRoot = path.dirname(threeRoot);

const TYPES = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.json': 'application/json', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.bin': 'application/octet-stream', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.ktx2': 'image/ktx2', '.webp': 'image/webp' };
function sendFile(res, file) {
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(buf);
  });
}
// serve only inside a base folder
function inside(base, rel) {
  const p = path.resolve(base, '.' + path.posix.normalize('/' + rel));
  return p.startsWith(base + path.sep) || p === base ? p : null;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = decodeURIComponent(url.pathname);
  if (p === '/') return sendFile(res, path.join(HERE, 'web/index.html'));
  if (p === '/config') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(config)); }
  if (p.startsWith('/web/')) { const f = inside(path.join(HERE, 'web'), p.slice(5)); return f ? sendFile(res, f) : (res.writeHead(403), res.end()); }
  if (p.startsWith('/three/')) { const f = inside(threeRoot, p.slice(7)); return f ? sendFile(res, f) : (res.writeHead(403), res.end()); }
  const fm = p.match(/^\/file\/(\d+)(?:\/(.*))?$/);
  if (fm) {
    const f = files[+fm[1]];
    if (!f) { res.writeHead(404); return res.end(); }
    // a .gltf may reference .bin and textures next to it
    if (fm[2]) { const g = inside(path.dirname(f), fm[2]); return g ? sendFile(res, g) : (res.writeHead(403), res.end()); }
    return sendFile(res, f);
  }
  if (p === '/result' && req.method === 'POST') {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try {
        const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const summary = writeReport(data, path.resolve(args.out));
        res.writeHead(200); res.end('ok');
        console.log(summary.text);
        console.log(`report: ${path.join(path.resolve(args.out), 'index.html')}`);
        setTimeout(() => process.exit(summary.failed ? 1 : 0), 200);
      } catch (e) {
        res.writeHead(500); res.end(String(e));
        console.error('could not write report:', e);
        process.exit(3);
      }
    });
    return;
  }
  res.writeHead(404); res.end('not found');
});

server.listen(args.port, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${server.address().port}/`;
  console.log(`rigcheck: checking ${config.models.length} model(s)${config.anims.length ? ` with ${config.anims.length} animation library(ies)` : ''}`);
  console.log(`open ${url} in a browser with WebGL${args.open ? ' (opening it now)' : ''}`);
  if (args.open) {
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
    const cargs = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
    spawn(cmd, cargs, { stdio: 'ignore', detached: true }).unref();
  }
});

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const safe = s => String(s).replace(/[^a-z0-9._-]+/gi, '_').slice(0, 80);

function writeReport(data, dir) {
  fs.mkdirSync(path.join(dir, 'shots'), { recursive: true });
  const save = (dataUrl, name) => {
    const file = `shots/${safe(name)}.jpg`;
    fs.writeFileSync(path.join(dir, file), Buffer.from(dataUrl.split(',')[1], 'base64'));
    return file;
  };
  const lines = [], json = { generated: new Date().toISOString(), models: [] };
  let failed = false;
  let html = `<!doctype html><html><head><meta charset="utf-8"><title>rigcheck report</title><style>
  body{margin:0;padding:24px;background:#16161a;color:#ddd;font:14px/1.5 system-ui,sans-serif}h1{margin:0 0 4px}h2{margin:32px 0 6px;border-top:1px solid #333;padding-top:20px}
  .ok{color:#6c6}.warn{color:#eb5}.fail{color:#f66}.row{display:flex;gap:8px;flex-wrap:wrap}.row img{width:192px;height:192px;border-radius:6px}
  table{border-collapse:collapse;margin:10px 0;width:100%}td,th{border-bottom:1px solid #2a2a30;padding:6px 8px;text-align:left;vertical-align:top}th{color:#999;font-weight:500}
  td img{width:120px;height:120px;border-radius:4px}.muted{color:#888}code{color:#9cf}</style></head><body>
  <h1>rigcheck report</h1><div class="muted">${esc(json.generated)} · mesh stretch, pose sanity and missing parts, measured on every clip · close-ups on magenta at each clip's worst frame</div>`;
  for (const m of data.models) {
    if (m.error) {
      failed = true; lines.push(`FAIL ${m.name}: ${m.error}`);
      html += `<h2>${esc(m.name)} <span class="fail">ERROR</span></h2><p>${esc(m.error)}</p>`;
      json.models.push({ name: m.name, error: m.error });
      continue;
    }
    const a = m.audit;
    if (a.status === 'fail') failed = true;
    const bad = a.clips.filter(c => c.status !== 'ok');
    lines.push(`${a.status.toUpperCase().padEnd(4)} ${m.name}: ${a.tris} tris, ${a.bones} bones, ${a.clips.length} clips, ${bad.length} with problems`);
    for (const f of a.findings) lines.push(`     ${f.level}: ${f.msg}`);
    for (const c of bad) lines.push(`     ${c.status} ${c.clip}: ${c.flags.map(f => f.msg).join('; ')}`);
    const rest = Object.fromEntries(Object.entries(m.shots.rest).map(([v, d]) => [v, save(d, `${m.name}__rest__${v}`)]));
    html += `<h2>${esc(m.name)} <span class="${a.status}">${a.status.toUpperCase()}</span></h2>
      <div class="muted">${a.tris} triangles · ${a.meshes} skinned meshes · ${a.bones} bones · ${a.humanoid ? 'humanoid' : 'not humanoid'} · height ${a.height}</div>
      ${a.findings.map(f => `<p class="${f.level}">${esc(f.level.toUpperCase())}: ${esc(f.msg)}</p>`).join('')}
      <div class="row">${Object.entries(rest).map(([v, f]) => `<figure style="margin:0"><img src="${f}"><figcaption class="muted">rest · ${v}</figcaption></figure>`).join('')}</div>
      <table><tr><th>clip</th><th>status</th><th>findings</th><th>stretch</th><th>front</th><th>side</th><th>top</th></tr>`;
    const sorted = [...a.clips].sort((x, y) => ({ fail: 0, warn: 1, ok: 2 }[x.status] - { fail: 0, warn: 1, ok: 2 }[y.status]));
    const clipsOut = [];
    for (const c of sorted) {
      const s = m.shots.clips[c.clip];
      const front = s && save(s.front, `${m.name}__${c.clip}__front`), side = s && save(s.side, `${m.name}__${c.clip}__side`), top = s?.top && save(s.top, `${m.name}__${c.clip}__top`);
      clipsOut.push({ ...c, shots: { time: s?.time, front, side, top } });
      html += `<tr><td><code>${esc(c.clip)}</code><div class="muted">${c.duration}s · shot at ${s?.time ?? '-'}s</div></td><td class="${c.status}">${c.status}</td>
        <td>${c.flags.map(f => `<div class="${f.level}">${esc(f.msg)} <span class="muted">@${f.time}s</span></div>`).join('') || '<span class="muted">-</span>'}</td>
        <td>${c.maxStretch}x max<br><span class="muted">${c.worstBadPct}% edges</span>${c.fidelity ? `<br><span class="muted">${c.fidelity.skipped ? 'source check skipped (floor move)' : `source drift ${c.fidelity.spineDrift}° spine, ${c.fidelity.maxDrift}° max`}</span>` : ''}${c.headVisible != null ? `<br><span class="muted">head visible ${Math.round(c.headVisible * 100)}%</span>` : ''}</td>
        <td>${front ? `<img src="${front}">` : ''}</td><td>${side ? `<img src="${side}">` : ''}</td><td>${top ? `<img src="${top}">` : ''}</td></tr>`;
    }
    html += `</table>`;
    json.models.push({ name: m.name, ...a, shots: { rest }, clips: clipsOut });
  }
  html += `<p class="muted">Numbers catch broken skin and impossible poses; they don't judge taste. Look at the close-ups too (or run the rigcheck critic skill).</p></body></html>`;
  fs.writeFileSync(path.join(dir, 'index.html'), html);
  fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(json, null, 2));
  return { failed, text: lines.join('\n') };
}
