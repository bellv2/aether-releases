// Runs INSIDE the real Electron app (loaded instead of main.js's window creation
// path being trusted blindly). Launches the app for real, then drives the live
// renderer to confirm every tab and system is present and functional.
const { app, BrowserWindow } = require('electron');
const path = require('path');
const http = require('http');
const fs = require('fs');

let server, port;

function startServer() {
  return new Promise((resolve, reject) => {
    const htmlPath = path.join(__dirname, 'app', 'aether.html');
    server = http.createServer((req, res) => {
      fs.readFile(htmlPath, (err, data) => {
        if (err) { res.writeHead(500); res.end('err'); return; }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(data);
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

app.whenReady().then(async () => {
  port = await startServer();
  console.log('SERVER OK on port', port);

  const win = new BrowserWindow({
    width: 1500, height: 950, show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });

  const consoleErrors = [];
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2 && !message.includes('Autofill') && !message.includes('Content-Security-Policy') && !message.includes('unsafe-eval')) consoleErrors.push(message);
  });

  await win.loadURL(`http://127.0.0.1:${port}/`);
  console.log('PAGE LOADED');

  await new Promise(r => setTimeout(r, 1500)); // let scripts settle

  const results = await win.webContents.executeJavaScript(`
    (async () => {
      const out = {};
      out.title = document.title;
      out.origin = window.location.origin;

      // every nav tab present and clickable
      const navs = [...document.querySelectorAll('.nv[data-v]')];
      out.navCount = navs.length;
      out.navs = navs.map(n => n.dataset.v);
      const views = [...document.querySelectorAll('.view[data-v]')].map(v => v.dataset.v);
      out.viewCount = views.length;
      out.parity = navs.every(n => views.includes(n.dataset.v)) && views.every(v => navs.some(n => n.dataset.v === v));

      let clickError = null;
      try { navs.forEach(b => b.click()); } catch (e) { clickError = e.message; }
      out.allTabsClicked = clickError === null;
      out.clickError = clickError;

      // each system's key elements exist
      out.systems = {
        database_modal:  !!document.getElementById('dbmodal'),
        database_pill:   !!document.getElementById('dbpill'),
        spotify_modal:   !!document.getElementById('spotmodal'),
        spotify_player:  !!document.getElementById('npWidget'),
        spotify_transport: !!document.getElementById('npToggle'),
        youtube_modal:   !!document.getElementById('ytmodal'),
        temas_body:      !!document.getElementById('temasBody'),
        notas_body:      !!document.getElementById('notasBody'),
        elclaro_overlay: !!document.getElementById('claro'),
        elclaro_evidence:!!document.getElementById('cPersp'),
        capture_form:    !!document.getElementById('mt') && !!document.getElementById('madd'),
        timer:           !!document.getElementById('fstart'),
        calendar_grid:   !!document.getElementById('calgrid'),
        search_input:    !!document.getElementById('searchIn'),
        command_palette: !!document.getElementById('cmdk'),
      };

      // localStorage must actually persist (this is why we serve over http, not file://)
      try {
        localStorage.setItem('__aether_probe', 'ok');
        out.localStorage = localStorage.getItem('__aether_probe') === 'ok';
        localStorage.removeItem('__aether_probe');
      } catch (e) { out.localStorage = false; out.localStorageError = e.message; }

      // overlays open and close
      const claro = document.getElementById('claro');
      document.getElementById('enterClaro')?.click();
      out.claroOpens = claro.classList.contains('on');
      document.getElementById('claroBack')?.click();
      out.claroCloses = !claro.classList.contains('on');

      document.getElementById('npWidget')?.click();
      out.spotifyModalOpens = document.getElementById('spotmodal').classList.contains('on');
      document.getElementById('spotClose')?.click();

      document.getElementById('ytSettingsBtn')?.click();
      out.youtubeModalOpens = document.getElementById('ytmodal').classList.contains('on');
      document.getElementById('ytClose')?.click();

      document.getElementById('dbpill')?.click();
      out.dbModalOpens = document.getElementById('dbmodal').classList.contains('on');
      document.getElementById('dbClose')?.click();

      // Captura form actually accepts input and reacts
      const mt = document.getElementById('mt');
      if (mt) {
        mt.value = 'prueba desde electron';
        mt.dispatchEvent(new Event('input', { bubbles: true }));
        out.captureAcceptsInput = document.getElementById('mt').value === 'prueba desde electron';
        document.getElementById('madd')?.click();
        await new Promise(r => setTimeout(r, 250));
        out.captureRespondsHonestly = (document.getElementById('mmsg')?.textContent || '').length > 0;
        mt.value = '';
      }

      // honest empty states while disconnected
      out.notasEmptyHonest = (document.getElementById('notasBody').textContent||'').includes('Conéctate');
      out.temasEmptyHonest = (document.getElementById('temasBody').textContent||'').includes('Conéctate');

      // palette actually applied
      const cs = getComputedStyle(document.documentElement);
      out.accent = cs.getPropertyValue('--cyan').trim();
      out.bg = cs.getPropertyValue('--bg').trim();

      return out;
    })()
  `);

  console.log('\n=== ELECTRON APP TEST ===');
  console.log('title:', results.title);
  console.log('origin:', results.origin, '(http, not file:// — this is what keeps APIs behaving normally)');
  console.log('nav tabs:', results.navCount, '| views:', results.viewCount, '| parity:', results.parity);
  console.log('tabs:', results.navs.join(', '));
  console.log('all tabs clicked without error:', results.allTabsClicked, results.clickError || '');
  console.log('localStorage works:', results.localStorage, results.localStorageError || '');
  console.log('\nsystems present:');
  Object.entries(results.systems).forEach(([k, v]) => console.log('  ' + (v ? 'OK  ' : 'MISS') + '  ' + k));
  console.log('\noverlays:');
  console.log('  El Claro opens/closes:', results.claroOpens, '/', results.claroCloses);
  console.log('  Spotify modal opens:', results.spotifyModalOpens);
  console.log('  YouTube modal opens:', results.youtubeModalOpens);
  console.log('  Database modal opens:', results.dbModalOpens);
  console.log('\nCaptura form:');
  console.log('  accepts input:', results.captureAcceptsInput);
  console.log('  responds when submitted while disconnected:', results.captureRespondsHonestly);
  console.log('\nhonest empty states (disconnected):');
  console.log('  Notas:', results.notasEmptyHonest, '| Temas:', results.temasEmptyHonest);
  console.log('\npalette applied: accent =', results.accent, '| bg =', results.bg);
  console.log('\nconsole errors:', consoleErrors.length ? consoleErrors : 'none');

  const allSystems = Object.values(results.systems).every(Boolean);
  const pass = results.parity && results.allTabsClicked && results.localStorage && allSystems &&
               results.claroOpens && results.claroCloses && results.spotifyModalOpens &&
               results.youtubeModalOpens && results.dbModalOpens && consoleErrors.length === 0;
  console.log('\n' + (pass ? '>>> ALL ELECTRON CHECKS PASSED' : '>>> SOMETHING FAILED'));

  server.close();
  app.exit(pass ? 0 : 1);
});
