// Proves the database layer genuinely works from inside the packaged app's
// origin — this is the thing most likely to silently break when moving from
// a browser tab to Electron, so it gets a real end-to-end test against a
// mock Turso server rather than an assumption.
const { app, BrowserWindow } = require('electron');
const path = require('path');
const http = require('http');
const fs = require('fs');

let appServer, dbServer;

function startAppServer() {
  return new Promise(resolve => {
    const htmlPath = path.join(__dirname, 'app', 'aether.html');
    appServer = http.createServer((req, res) => {
      fs.readFile(htmlPath, (err, data) => {
        res.writeHead(err ? 500 : 200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(err ? 'err' : data);
      });
    });
    appServer.listen(0, '127.0.0.1', () => resolve(appServer.address().port));
  });
}

function startMockTurso() {
  return new Promise(resolve => {
    dbServer = http.createServer((req, res) => {
      // real Turso answers preflight and permits the Authorization header;
      // the mock must too, or we'd be testing the stub, not the app
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        });
        res.end();
        return;
      }
      let body = '';
      req.on('data', c => (body += c));
      req.on('end', () => {
        const parsed = JSON.parse(body || '{}');
        const exec = (parsed.requests || []).find(r => r.type === 'execute');
        const sql = (exec && exec.stmt && exec.stmt.sql) || '';
        let cols = [], rows = [];

        if (/SELECT 1/i.test(sql)) { cols = ['1']; rows = [['1']]; }
        else if (/FROM courses/i.test(sql)) {
          cols = ['id', 'name', 'code', 'credits'];
          rows = [['5', 'Cálculo en Varias Variables', 'MAT-12221', '9'],
                  ['6', 'Principios de Macroeconomía', 'ECO-12010', '6']];
        }
        else if (/FROM assignments/i.test(sql)) {
          cols = ['id','course_id','title','type','due_at','status','weight','grade','course_name'];
          rows = [['1','5','Problemario 7','tarea','2026-08-14','pendiente','6', null,'Cálculo en Varias Variables']];
        }
        else if (/FROM note_snapshots/i.test(sql)) {
          cols = ['id','course_id','source_filename','drive_file_id','full_text','new_since_last','captured_at','course_name'];
          rows = [['1','5','Calculo.pdf','f1','texto','Teorema de Green' + String.fromCharCode(10) + 'Integrales de linea','2026-08-02 12:00:00','Cálculo en Varias Variables']];
        }

        const wrap = v => (v === null ? { type: 'null' } : { type: 'text', value: String(v) });
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        });
        res.end(JSON.stringify({
          results: [
            { type: 'ok', response: { result: { cols: cols.map(c => ({ name: c })), rows: rows.map(r => r.map(wrap)) } } },
            { type: 'ok' },
          ],
        }));
      });
    });
    dbServer.listen(0, '127.0.0.1', () => resolve(dbServer.address().port));
  });
}

app.whenReady().then(async () => {
  const appPort = await startAppServer();
  const dbPort = await startMockTurso();

  const win = new BrowserWindow({ width: 1500, height: 950, show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true } });

  const errors = [];
  win.webContents.on('console-message', (_e, level, msg) => {
    if (level >= 2 && !msg.includes('Content-Security-Policy') && !msg.includes('unsafe-eval') && !msg.includes('Autofill'))
      errors.push(msg);
  });

  await win.loadURL(`http://127.0.0.1:${appPort}/`);
  await new Promise(r => setTimeout(r, 1200));

  const out = await win.webContents.executeJavaScript(`
    (async () => {
      const o = {};
      // drive the real connection UI, not internals
      document.getElementById('dbpill').click();
      document.getElementById('dbUrl').value = 'http://127.0.0.1:${dbPort}';
      document.getElementById('dbTok').value = 'test-token';
      document.getElementById('dbSave').click();
      await new Promise(r => setTimeout(r, 1200));

      o.pillText = (document.getElementById('dbpill').textContent || '').trim();
      o.connected = o.pillText.toLowerCase().includes('conectado');

      // real data must now be rendered, not placeholders
      o.heroSub = (document.querySelector('.hero p')?.textContent || '').slice(0, 90);
      o.statEntregas = document.getElementById('statEntregas')?.textContent;

      // Clases tab should list the real courses from the DB
      document.querySelector('.nv[data-v=classes]').click();
      await new Promise(r => setTimeout(r, 400));
      o.courseListed = (document.body.textContent || '').includes('Cálculo en Varias Variables');

      // Notas tab should show the real snapshot, grouped by real course name
      document.querySelector('.nv[data-v=notas]').click();
      await new Promise(r => setTimeout(r, 700));
      o.notasGroup = document.querySelector('.ntHead h3')?.textContent || '';
      o.notasText = (document.querySelector('.ntText')?.textContent || '').slice(0, 40);
      o.notasCount = document.getElementById('notasCount')?.textContent;

      return o;
    })()
  `);

  console.log('\n=== LIVE DATABASE CONNECTION FROM INSIDE ELECTRON ===');
  console.log('connection pill:', out.pillText, '->', out.connected ? 'CONNECTED' : 'NOT CONNECTED');
  console.log('dashboard reflects real data:', out.heroSub);
  console.log('stat "entregas":', out.statEntregas, '(expect 1 from mock)');
  console.log('real course rendered in Clases:', out.courseListed);
  console.log('Notas grouped under real course:', out.notasGroup);
  console.log('Notas OCR text rendered:', out.notasText.replace(/\n/g, ' | '));
  console.log('Notas count:', out.notasCount);
  console.log('console errors:', errors.length ? errors : 'none');

  const pass = out.connected && out.courseListed &&
               out.notasGroup.includes('Cálculo') && out.notasText.length > 0 && errors.length === 0;
  console.log('\n' + (pass ? '>>> DATABASE LAYER FULLY WORKING IN ELECTRON' : '>>> DATABASE LAYER FAILED'));

  appServer.close(); dbServer.close();
  app.exit(pass ? 0 : 1);
});
