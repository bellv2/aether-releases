// The realistic first-run case: the releases repo doesn't exist yet.
// The app must stay fully usable and report honestly, not crash.
const { app, BrowserWindow } = require('electron');
const path = require('path'); const http = require('http'); const fs = require('fs');
const { autoUpdater } = require('electron-updater');

autoUpdater.autoDownload = false;
let sawError = null, crashed = false;
autoUpdater.on('error', (e) => { sawError = (e && e.message) || String(e); });

let server;
app.whenReady().then(async () => {
  const htmlPath = path.join(__dirname, 'app', 'aether.html');
  server = http.createServer((req,res)=>{ fs.readFile(htmlPath,(e,d)=>{ res.writeHead(e?500:200,{'Content-Type':'text/html; charset=utf-8'}); res.end(e?'err':d); }); });
  const port = await new Promise(r=>server.listen(0,'127.0.0.1',()=>r(server.address().port)));

  const win = new BrowserWindow({ width:1200, height:800, show:false,
    webPreferences:{ nodeIntegration:false, contextIsolation:true, preload: path.join(__dirname,'preload.js') } });
  win.webContents.on('render-process-gone', () => { crashed = true; });
  await win.loadURL('http://127.0.0.1:'+port+'/');
  await new Promise(r=>setTimeout(r,1000));

  // point at a repo that genuinely does not exist — same as before first release
  autoUpdater.setFeedURL({ provider:'github', owner:'bellv2', repo:'aether-releases-does-not-exist-yet' });

  let threw = null;
  try { await autoUpdater.checkForUpdates(); }
  catch (e) { threw = (e && e.message) || String(e); }
  await new Promise(r=>setTimeout(r,2500));

  const stillWorks = await win.webContents.executeJavaScript(`
    (() => {
      const navs=[...document.querySelectorAll('.nv[data-v]')];
      let err=null; try{ navs.forEach(b=>b.click()); }catch(e){ err=e.message; }
      return { tabs: navs.length, clickable: err===null, dbPill: !!document.getElementById('dbpill') };
    })()
  `);

  console.log('\n=== FIRST-RUN CASE: NO RELEASES PUBLISHED YET ===');
  console.log('updater reported an error (expected):', sawError ? 'yes' : 'no');
  console.log('  message:', (sawError || threw || '').slice(0,110));
  console.log('renderer crashed:', crashed, '(must be false)');
  console.log('app still fully usable — tabs:', stillWorks.tabs, '| clickable:', stillWorks.clickable, '| db pill:', stillWorks.dbPill);
  const pass = !crashed && stillWorks.clickable && stillWorks.tabs === 15;
  console.log('\n' + (pass ? '>>> DEGRADES GRACEFULLY — app unaffected by missing releases' : '>>> FAILED'));
  server.close(); app.exit(pass?0:1);
});
