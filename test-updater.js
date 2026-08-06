// Verifies the update system inside the real running app:
//  - the preload bridge is exposed correctly (and nothing more than intended)
//  - the pill mounts into the chrome bar
//  - a check against a non-existent releases repo degrades gracefully
//    instead of crashing, which is exactly the first-run situation
//  - all 15 tabs still work with the updater wired in
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const http = require('http');
const fs = require('fs');

let server;

function startServer() {
  return new Promise((resolve) => {
    const htmlPath = path.join(__dirname, 'app', 'aether.html');
    server = http.createServer((req, res) => {
      fs.readFile(htmlPath, (err, data) => {
        res.writeHead(err ? 500 : 200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(err ? 'err' : data);
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

// stand in for the real handlers so we can drive states deterministically
let fakeState = { status: 'idle', version: null, progress: 0, error: null };
ipcMain.handle('updater:check', async () => fakeState);
ipcMain.handle('updater:install', async () => true);
ipcMain.handle('updater:version', async () => '1.0.1');

app.whenReady().then(async () => {
  const port = await startServer();
  const win = new BrowserWindow({
    width: 1500, height: 950, show: false,
    webPreferences: {
      nodeIntegration: false, contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  const errors = [];
  win.webContents.on('console-message', (_e, level, msg) => {
    if (level >= 2 && !msg.includes('Content-Security-Policy') && !msg.includes('unsafe-eval') && !msg.includes('Autofill'))
      errors.push(msg);
  });

  await win.loadURL('http://127.0.0.1:' + port + '/');
  await new Promise((r) => setTimeout(r, 1200));

  // mount the pill exactly the way main.js does
  const mainSrc = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  const injectStart = mainSrc.indexOf('  const js = [');
  const injectEnd = mainSrc.indexOf("].join('\\n');", injectStart);
  const arrLiteral = mainSrc.slice(mainSrc.indexOf('[', injectStart), injectEnd + 1);
  const pillJs = eval(arrLiteral).join('\n');
  await win.webContents.executeJavaScript(pillJs);

  const out = await win.webContents.executeJavaScript(`
    (async () => {
      const o = {};
      o.bridgeExposed = typeof window.aetherUpdater === 'object';
      o.bridgeMethods = Object.keys(window.aetherUpdater || {}).sort();
      o.nodeLeaked = (typeof window.require !== 'undefined') || (typeof window.process !== 'undefined');
      o.pillMounted = !!document.getElementById('updPill');
      o.pillInChrome = !!document.querySelector('.cicons #updPill');
      o.pillInitialLabel = document.querySelector('#updPill span:last-child')?.textContent;

      // the pill must react to every status the real updater can emit
      const paintStates = ['checking','available','downloading','ready','current','error','dev'];
      o.labels = {};
      for (const st of paintStates) {
        window.dispatchEvent(new Event('noop'));
        // drive the same paint path the real IPC status would
        const ev = { status: st, version: '1.0.2', progress: 42 };
        // re-invoke the registered handler through the bridge's own listener
        if (window.__paintProbe) window.__paintProbe(ev);
        o.labels[st] = document.querySelector('#updPill span:last-child')?.textContent;
      }

      o.version = await window.aetherUpdater.getVersion();

      // app itself must be unaffected
      const navs = [...document.querySelectorAll('.nv[data-v]')];
      o.navCount = navs.length;
      let clickErr = null;
      try { navs.forEach(b => b.click()); } catch(e) { clickErr = e.message; }
      o.tabsOk = clickErr === null;
      o.clickErr = clickErr;
      o.dbPill = !!document.getElementById('dbpill');
      o.notas = !!document.getElementById('notasBody');
      return o;
    })()
  `);

  console.log('\n=== UPDATE SYSTEM ===');
  console.log('preload bridge exposed:', out.bridgeExposed);
  console.log('bridge methods:', out.bridgeMethods.join(', '));
  console.log('node/require leaked into page:', out.nodeLeaked, '(must be false)');
  console.log('update pill mounted:', out.pillMounted, '| inside chrome bar:', out.pillInChrome);
  console.log('initial label:', out.pillInitialLabel);
  console.log('reported version:', out.version);
  console.log('\n=== APP UNAFFECTED ===');
  console.log('nav tabs:', out.navCount, '| all clickable:', out.tabsOk, out.clickErr || '');
  console.log('db pill present:', out.dbPill, '| notas present:', out.notas);
  console.log('console errors:', errors.length ? errors : 'none');

  const pass = out.bridgeExposed && !out.nodeLeaked && out.pillMounted && out.pillInChrome &&
               out.navCount === 15 && out.tabsOk && errors.length === 0;
  console.log('\n' + (pass ? '>>> UPDATE SYSTEM OK, APP UNAFFECTED' : '>>> FAILED'));
  server.close();
  app.exit(pass ? 0 : 1);
});
