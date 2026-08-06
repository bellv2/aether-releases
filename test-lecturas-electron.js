// Targeted check for the two things added this round: the Lecturas tab
// and Captura's new file-attachment input — inside the real packaged app.
const { app, BrowserWindow } = require('electron');
const path = require('path');
const http = require('http');
const fs = require('fs');

let server;
app.whenReady().then(async () => {
  const htmlPath = path.join(__dirname, 'app', 'aether.html');
  server = http.createServer((req, res) => {
    fs.readFile(htmlPath, (err, data) => {
      res.writeHead(err ? 500 : 200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(err ? 'err' : data);
    });
  });
  const port = await new Promise(r => server.listen(0, '127.0.0.1', () => r(server.address().port)));

  const win = new BrowserWindow({ width: 1500, height: 950, show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true } });
  const errors = [];
  win.webContents.on('console-message', (_e, level, msg) => {
    if (level >= 2 && !msg.includes('Content-Security-Policy') && !msg.includes('unsafe-eval') && !msg.includes('Autofill'))
      errors.push(msg);
  });
  await win.loadURL('http://127.0.0.1:' + port + '/');
  await new Promise(r => setTimeout(r, 1200));

  const out = await win.webContents.executeJavaScript(`
    (() => {
      const o = {};
      document.querySelector('.nv[data-v=lecturas]').click();
      o.lecturasTabExists = !!document.querySelector('.nv[data-v=lecturas]');
      o.subTabs = [...document.querySelectorAll('#lecTabs button')].map(b => b.dataset.lt);
      o.proximoPane = !!document.getElementById('lecProximo');
      o.librosPane = !!document.getElementById('lecLibros');
      o.resumenesPane = !!document.getElementById('lecResumenes');
      o.honestEmpty = (document.getElementById('lecProximo')?.textContent || '').includes('Conéctate a tu base');

      document.querySelector('.nv[data-v=manual]').click();
      o.fileInput = !!document.getElementById('mfile');
      o.sizeHint = (document.querySelector('.atHint')?.textContent || '').includes('4 MB');
      return o;
    })()
  `);

  console.log('\\n=== LECTURAS INSIDE PACKAGED ELECTRON APP ===');
  console.log('tab present:', out.lecturasTabExists);
  console.log('sub-tabs:', out.subTabs.join(', '));
  console.log('three panes present:', out.proximoPane && out.librosPane && out.resumenesPane);
  console.log('honest empty state (disconnected):', out.honestEmpty);
  console.log('\\nCaptura attachment:');
  console.log('file input present:', out.fileInput);
  console.log('4MB limit hint shown:', out.sizeHint);
  console.log('console errors:', errors.length ? errors : 'none');

  const pass = out.lecturasTabExists && out.subTabs.length === 3 && out.proximoPane &&
               out.librosPane && out.resumenesPane && out.honestEmpty &&
               out.fileInput && out.sizeHint && errors.length === 0;
  console.log('\\n' + (pass ? '>>> LECTURAS + ADJUNTOS OK INSIDE ELECTRON' : '>>> FAILED'));
  server.close();
  app.exit(pass ? 0 : 1);
});
