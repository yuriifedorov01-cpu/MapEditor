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
import zlib from 'node:zlib';
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
      const swfPath = path.join(ROOT, '..', 'gamefs', 'MyGame.swf');
      let swfMtime = null, swfSize = 0, swfOk = false, swfCheck = 'файла нет';
      try {
        const st = fs.statSync(swfPath);
        swfMtime = st.mtime.toISOString();
        swfSize = st.size;
        const b = fs.readFileSync(swfPath);
        const sig = b.toString('latin1', 0, 3);
        let body = null;
        if (sig === 'FWS' || sig === 'CWS') body = sig === 'CWS' ? zlib.inflateSync(b.slice(8)) : b.slice(8);
        const s = body ? body.toString('latin1') : '';
        const hasLocal = s.includes('127.0.0.1:8080');
        const hasPub = s.includes('github.io');
        const hasPet = s.includes('pet_body_locations');
        swfOk = !!body && hasLocal && !hasPub && hasPet;
        swfCheck = sig + ' · ' + (b.length / 1048576).toFixed(1) + ' МБ · ассеты → ' +
          (hasLocal ? '127.0.0.1:8080' : (hasPub ? 'github.io (публичная сборка!)' : 'НЕ найдены')) +
          (hasPet ? '' : ' · НЕТ pet_body_locations');
      } catch (e) { swfCheck = 'ошибка чтения: ' + e.message; }
      let logTail = '';
      try { logTail = fs.readFileSync(path.join(TOOLS, 'rebuild-client.log'), 'utf8').slice(-3000); } catch {}
      let prog = null;
      try { prog = JSON.parse(fs.readFileSync(path.join(TOOLS, 'rebuild-progress.json'), 'utf8').replace(/^\uFEFF/, '')); } catch {}
      const stale = !!(prog && prog.running && prog.at && (Date.now() - prog.at) > 120000);
      const rebuilding = !!(prog && prog.running) && !stale;
      // «сборка только что завершилась» — подсказку про перезапуск клиента показываем 2 минуты
      const done = !!(prog && prog.ok === true) && !!(prog.at && (Date.now() - prog.at) < 120000);
      const error = prog && prog.ok === false ? (prog.error || 'сборка упала') : null;
      // прогресс: во время сборки — реальный, после ошибки — застывший, в покое — 100% если SWF валиден
      const percent = rebuilding ? (prog.percent | 0) : (error ? (prog.percent | 0) : (swfOk ? 100 : 0));
      return send(res, 200, JSON.stringify({
        swfMtime, swfSize, swfOk, swfCheck,
        rebuilding, stale, publishing: !!(prog && prog.phase === 'publish'),
        phase: prog ? (prog.phase || 'rebuild') : null,
        step: prog ? prog.step : null, totalSteps: prog ? prog.total : null,
        stepName: prog ? prog.name : null, percent, done, error, logTail,
      }), MIME['.json']);
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
          // Пересборка и/или публикация в hht-client. Публикация должна идти ПОСЛЕ пересборки,
          // поэтому при обоих флагах запускаем один процесс: rebuild-client-swf.ps1 -Publish.
          // Защита от перекрытия: если сборка/публикация уже идёт, вторую НЕ запускаем — иначе
          // пуши идут подряд, GitHub Pages отменяет деплои («бесконечный deploy»).
          let busy = false;
          try {
            const p = JSON.parse(fs.readFileSync(path.join(TOOLS, 'rebuild-progress.json'), 'utf8').replace(/^\uFEFF/, ''));
            busy = !!p.running && !(p.at && Date.now() - p.at > 120000);
          } catch {}
          let rebuilding = false, publishing = false;
          if ((body.rebuild || body.publish) && process.platform === 'win32' && !busy) {
            const psExe = path.join(process.env.SystemRoot || 'C:\\Windows',
              'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
            const log = path.join(TOOLS, 'rebuild-client.log');
            const cmd = body.rebuild
              ? `& '${path.join(TOOLS, 'rebuild-client-swf.ps1')}' -Force${body.publish ? ' -Publish' : ''} *> '${log}'`
              : `& '${path.join(TOOLS, 'publish-hht-client.ps1')}' -WithSwfPatches *> '${log}'`;
            // ВАЖНО: detached:true на Windows заставляет powershell.exe молча ничего не делать
            // (проверено: ни лог, ни прогресс не появляются) — пересборка «не срабатывала».
            spawn(psExe, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', cmd],
              { cwd: TOOLS, stdio: 'ignore', windowsHide: true }).unref();
            rebuilding = !!body.rebuild;
            publishing = true;
          }
          return send(res, 200, JSON.stringify({ ok: true, saved, rebuilding, publishing, busy }), MIME['.json']);
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
