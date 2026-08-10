const { app, BrowserWindow, shell, ipcMain, dialog } = require('electron');
const path = require('path');
const http = require('http');
const fs = require('fs');
const { autoUpdater } = require('electron-updater');

// ── Why a local server instead of loading the file directly ──
// file:// gives the page a "null" origin, which breaks localStorage
// guarantees and makes OAuth redirects and API calls behave differently
// than in a browser. Serving the same HTML over 127.0.0.1 gives it a
// real origin, so Turso, Spotify and YouTube behave exactly as they did
// in the browser tab this was built and tested in.
let server;
let serverPort = 0;
let mainWindow = null;

// Puerto fijo a propósito, no aleatorio. Con listen(0, ...) el sistema
// operativo asigna un puerto distinto cada vez que se abre la app —
// y como localStorage está ligado a la dirección exacta (127.0.0.1:PUERTO),
// un puerto distinto es, para el navegador embebido, un origen completamente
// nuevo y vacío. Eso es lo que borraba todo en cada reinicio: no era un
// bug de guardado, era que cada sesión vivía en una dirección diferente.
// Una lista corta de puertos fijos de respaldo cubre el caso raro de que
// el primero ya esté ocupado, sin volver a caer en un puerto verdaderamente
// aleatorio.
const PREFERRED_PORTS = [47821, 47822, 47823, 47824];

function startServer() {
  return new Promise((resolve, reject) => {
    const htmlPath = path.join(__dirname, 'app', 'aether.html');
    server = http.createServer((req, res) => {
      fs.readFile(htmlPath, (err, data) => {
        if (err) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('No se pudo cargar AETHER: ' + err.message);
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(data);
      });
    });

    let attempt = 0;
    function tryNextPort() {
      if (attempt >= PREFERRED_PORTS.length) {
        reject(new Error('Ninguno de los puertos fijos estaba disponible'));
        return;
      }
      const port = PREFERRED_PORTS[attempt++];
      server.once('error', (err) => {
        if (err.code === 'EADDRINUSE') { tryNextPort(); }
        else { reject(err); }
      });
      server.listen(port, '127.0.0.1', () => {
        serverPort = port;
        resolve(port);
      });
    }
    tryNextPort();
  });
}

// ══════ UPDATES ══════
// Never download silently: tell the user first, let them decide.
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = true;

let updateState = { status: 'idle', version: null, progress: 0, error: null };

function pushStatus(patch) {
  updateState = Object.assign({}, updateState, patch);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('updater:status', updateState);
  }
}

autoUpdater.on('checking-for-update', () => pushStatus({ status: 'checking', error: null }));

autoUpdater.on('update-available', (info) => {
  pushStatus({ status: 'available', version: info.version });
  if (!mainWindow || mainWindow.isDestroyed()) return;
  dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: 'Actualización disponible',
    message: 'Hay una versión nueva de AETHER (' + info.version + ').',
    detail: 'Se descarga en segundo plano. Puedes seguir trabajando mientras tanto.',
    buttons: ['Descargar ahora', 'Después'],
    defaultId: 0,
    cancelId: 1,
  }).then(function (r) {
    if (r.response === 0) autoUpdater.downloadUpdate();
    else pushStatus({ status: 'idle' });
  });
});

autoUpdater.on('update-not-available', () => pushStatus({ status: 'current', version: app.getVersion() }));
autoUpdater.on('download-progress', (p) => pushStatus({ status: 'downloading', progress: Math.round(p.percent) }));

autoUpdater.on('update-downloaded', (info) => {
  pushStatus({ status: 'ready', version: info.version, progress: 100 });
  if (!mainWindow || mainWindow.isDestroyed()) return;
  dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: 'Actualización lista',
    message: 'AETHER ' + info.version + ' está lista para instalarse.',
    detail: 'Se instala al reiniciar. ¿Reiniciar ahora?',
    buttons: ['Reiniciar ahora', 'Al cerrar la app'],
    defaultId: 0,
    cancelId: 1,
  }).then(function (r) {
    if (r.response === 0) autoUpdater.quitAndInstall(false, true);
  });
});

autoUpdater.on('error', (err) => {
  // Most common real cause: no releases published yet, or offline.
  // This is not a crash and must never be treated as one.
  const msg = (err && err.message) || String(err);
  pushStatus({ status: 'error', error: msg });
  console.warn('[updater] no se pudo buscar actualizaciones:', msg);
});

function safeCheck() {
  // Unpackaged dev runs have no update metadata — skip instead of erroring noisily.
  if (!app.isPackaged) {
    pushStatus({ status: 'dev' });
    return Promise.resolve({ skipped: 'dev' });
  }
  try {
    const p = autoUpdater.checkForUpdates();
    if (p && typeof p.catch === 'function') {
      return p.catch(function (e) {
        pushStatus({ status: 'error', error: (e && e.message) || String(e) });
        return { error: true };
      });
    }
    return Promise.resolve({});
  } catch (e) {
    pushStatus({ status: 'error', error: (e && e.message) || String(e) });
    return Promise.resolve({ error: true });
  }
}

ipcMain.handle('updater:check', async () => { await safeCheck(); return updateState; });
ipcMain.handle('updater:install', async () => { autoUpdater.quitAndInstall(false, true); return true; });
ipcMain.handle('updater:version', async () => app.getVersion());

// ══════ UPDATE PILL, injected so aether.html itself stays untouched ══════
// Injecting from here rather than editing the HTML keeps the app file
// byte-identical to the build that passes the browser test suite.
function injectUpdateUI(win) {
  const js = [
    "(function(){",
    "  if (!window.aetherUpdater || document.getElementById('updPill')) return;",
    "  var bar = document.querySelector('.cicons');",
    "  if (!bar) return;",
    "  var pill = document.createElement('button');",
    "  pill.id = 'updPill'; pill.type = 'button';",
    "  pill.style.cssText = 'display:flex;align-items:center;gap:6px;background:transparent;border:1px solid var(--line);color:var(--ink-3);font-family:var(--mono);font-size:10.5px;letter-spacing:.04em;padding:4px 9px;border-radius:6px;cursor:pointer;transition:.18s;text-transform:uppercase;white-space:nowrap';",
    "  pill.onmouseenter = function(){ pill.style.borderColor='var(--gold-dim)'; pill.style.color='var(--cyan)'; };",
    "  pill.onmouseleave = function(){ if(!pill.dataset.hot){ pill.style.borderColor='var(--line)'; pill.style.color='var(--ink-3)'; } };",
    "  var dot = document.createElement('span');",
    "  dot.style.cssText = 'width:6px;height:6px;border-radius:50%;background:var(--ink-3);flex:0 0 6px';",
    "  var label = document.createElement('span');",
    "  label.textContent = 'buscar actualización';",
    "  pill.appendChild(dot); pill.appendChild(label);",
    "  bar.insertBefore(pill, bar.firstChild);",
    "  function paint(s){",
    "    pill.dataset.hot = '';",
    "    if (s.status === 'checking'){ label.textContent='buscando…'; dot.style.background='var(--ink-3)'; }",
    "    else if (s.status === 'available'){ label.textContent='v'+s.version+' disponible'; dot.style.background='var(--cyan)'; pill.style.color='var(--cyan)'; pill.style.borderColor='var(--gold-dim)'; pill.dataset.hot='1'; }",
    "    else if (s.status === 'downloading'){ label.textContent='descargando '+s.progress+'%'; dot.style.background='var(--cyan)'; pill.style.color='var(--cyan)'; pill.dataset.hot='1'; }",
    "    else if (s.status === 'ready'){ label.textContent='reiniciar para instalar'; dot.style.background='var(--cyan)'; pill.style.color='var(--cyan)'; pill.style.borderColor='var(--cyan)'; pill.dataset.hot='1'; }",
    "    else if (s.status === 'current'){ label.textContent='al día · v'+(s.version||''); dot.style.background='var(--mint)'; }",
    "    else if (s.status === 'error'){ label.textContent='sin conexión a updates'; dot.style.background='var(--rose)'; }",
    "    else if (s.status === 'dev'){ label.textContent='modo desarrollo'; dot.style.background='var(--ink-3)'; }",
    "    else { label.textContent='buscar actualización'; dot.style.background='var(--ink-3)'; }",
    "  }",
    "  pill.addEventListener('click', function(){",
    "    if (pill.dataset.hot && label.textContent.indexOf('reiniciar') === 0) { window.aetherUpdater.install(); return; }",
    "    window.aetherUpdater.check();",
    "  });",
    "  window.aetherUpdater.onStatus(paint);",
    "  window.aetherUpdater.getVersion().then(function(v){ pill.title = 'AETHER v' + v; });",
    "  window.__updPillMounted = true;",
    "})();",
  ].join('\n');
  return win.webContents.executeJavaScript(js).catch(function (e) {
    console.warn('[updater] no se pudo montar el pill:', e.message);
  });
}

function createWindow(port) {
  const win = new BrowserWindow({
    width: 1500,
    height: 950,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0A0A0A',
    title: 'AETHER',
    icon: path.join(__dirname, 'build', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  win.loadURL('http://127.0.0.1:' + port + '/');

  win.webContents.on('did-finish-load', function () {
    injectUpdateUI(win);
    setTimeout(safeCheck, 4000); // quiet check shortly after launch
  });

  win.webContents.setWindowOpenHandler(function (details) {
    const url = details.url;
    if (url.startsWith('https://accounts.spotify.com') || url.indexOf('github.io') !== -1) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 460, height: 680, autoHideMenuBar: true, backgroundColor: '#0A0A0A',
        },
      };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });

  return win;
}

app.whenReady().then(async function () {
  try {
    const port = await startServer();
    mainWindow = createWindow(port);
  } catch (e) {
    console.error('No se pudo iniciar AETHER:', e);
    app.quit();
  }

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow(serverPort);
  });
});

app.on('window-all-closed', function () {
  if (server) server.close();
  if (process.platform !== 'darwin') app.quit();
});
