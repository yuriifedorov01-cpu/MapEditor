#!/usr/bin/env node
/*
 * serve.mjs — мини-сервер для автономного редактора карт Helmet Heroes.
 * Раздаёт файлы из этой папки и отдаёт редактор по адресу /editor.
 *   node serve.mjs [порт] [хост]
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.argv[2] || 8080);
const HOST = process.argv[3] || '127.0.0.1';
const MIME = {
  '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.xml': 'application/xml; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.mp3': 'audio/mpeg',
};

const send = (res, code, body, type) => {
  res.writeHead(code, { 'Content-Type': type || 'text/plain; charset=utf-8' });
  res.end(body);
};

http.createServer(async (req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  if (url === '/' || url === '/editor' || url === '/editor/') {
    return fs.readFile(path.join(ROOT, 'index.html'), (e, b) =>
      e ? send(res, 500, 'index.html не найден') : send(res, 200, b, MIME['.html']));
  }
  // ---- Редактор экипировки: позиции предметов на персонаже и питомце (tools/equip-data.mjs) ----
  const TOOLS = path.join(ROOT, '..', 'tools');
  if (url === '/editor/api/equip-status') {
    try {
      let swfMtime = null;
      try { swfMtime = fs.statSync(path.join(ROOT, '..', 'gamefs', 'MyGame.swf')).mtime.toISOString(); } catch {}
      let logTail = '';
      try { logTail = fs.readFileSync(path.join(TOOLS, 'rebuild-client.log'), 'utf8').slice(-3000); } catch {}
      return send(res, 200, JSON.stringify({ swfMtime, logTail }), MIME['.json']);
    } catch (e) { return send(res, 500, 'equip-status error: ' + e.message); }
  }
  if (url === '/editor/api/equip') {
    let mod;
    try { mod = await import('../tools/equip-data.mjs'); }
    catch (e) { return send(res, 500, 'equip-data не найден: ' + e.message); }
    if (req.method === 'GET') {
      try {
        const data = mod.buildEquipJson();
        data.petHelmetOffsets = mod.readPetHelmetOffsets();
        return send(res, 200, JSON.stringify(data), MIME['.json']);
      } catch (e) { return send(res, 500, 'equip error: ' + e.message); }
    }
    if (req.method === 'POST') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
          const saved = {};
          if (body.person) { mod.writePerson(body.person); saved.person = true; }
          if (body.pets && typeof body.pets === 'object') {
            for (const [type, fields] of Object.entries(body.pets)) {
              if (fields && typeof fields === 'object') mod.writePetFields(type, fields);
            }
            saved.pets = Object.keys(body.pets);
          }
          if (body.petHelmetOffsets) { mod.writePetHelmetOffsets(body.petHelmetOffsets.x, body.petHelmetOffsets.y); saved.petHelmetOffsets = true; }
          let rebuilding = false;
          if (body.rebuild && process.platform === 'win32') {
            const psExe = path.join(process.env.SystemRoot || 'C:\\Windows',
              'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
            const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
              `& '${path.join(TOOLS, 'rebuild-client-swf.ps1')}' -Force *> '${path.join(TOOLS, 'rebuild-client.log')}'`];
            spawn(psExe, args, { cwd: TOOLS, detached: true, stdio: 'ignore', windowsHide: true }).unref();
            rebuilding = true;
          }
          return send(res, 200, JSON.stringify({ ok: true, saved, rebuilding }), MIME['.json']);
        } catch (e) { return send(res, 500, 'equip error: ' + e.message); }
      });
      return;
    }
    return send(res, 405, 'method not allowed');
  }
  // TEST MAP: собрать server/Map.generated.cs из data/map_*.json (tools/gen-map.mjs)
  if (url === '/editor/api/gen-map') {
    const root2 = path.join(ROOT, '..');
    const r = spawnSync(process.execPath, [path.join(root2, 'tools', 'gen-map.mjs')],
      { cwd: root2, encoding: 'utf8' });
    const out = ((r.stdout || '') + (r.stderr || '')).trim();
    return send(res, r.status === 0 ? 200 : 500,
      JSON.stringify({ ok: r.status === 0, out }), MIME['.json']);
  }

  const full = path.normalize(path.join(ROOT, url));
  if (!full.startsWith(ROOT)) return send(res, 403, 'forbidden');
  fs.stat(full, (e, st) => {
    if (e || !st.isFile()) return send(res, 404, 'not found: ' + url);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream' });
    fs.createReadStream(full).pipe(res);
  });
}).listen(PORT, HOST, () => {
  const h = HOST === '0.0.0.0' ? '127.0.0.1' : HOST;
  console.log('Редактор карт: http://' + h + ':' + PORT + '/editor');
});
