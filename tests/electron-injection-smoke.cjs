// Run explicitly with Electron, not node --test. Uses an isolated synthetic
// page to check real browser bundles before the page removes localStorage.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
let activeMod = 'vencord';
app.on('window-all-closed', () => {});
ipcMain.on('kawaicord:getStartupBundles', event => {
  const read = (name, ext) => fs.readFileSync(path.join(root, name, `${name}.${ext}`), 'utf8');
  event.returnValue = { activeMod, safeMode: false, shelter: { js: read('shelter', 'js') },
    mod: { enabled: true, js: read(activeMod, 'js'), css: read(activeMod, 'css') } };
});
for (const channel of ['kawaicord:getConfig', 'window:getState', 'window:getNavigationState']) {
  ipcMain.handle(channel, () => ({}));
}
app.whenReady().then(async () => {
  const server = require('node:http').createServer((_req, response) => {
    response.end('<html><head><script>window.storagePresentBeforePage=!!localStorage;delete window.localStorage;</script></head><body><div id="app-mount"></div></body></html>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    for (activeMod of ['vencord', 'equicord']) {
      const window = new BrowserWindow({ show: false, webPreferences: {
        preload: path.join(root, 'dist/preload.js'), contextIsolation: false, sandbox: false
      } });
      await window.loadURL(`http://127.0.0.1:${server.address().port}`);
      const result = await window.webContents.executeJavaScript(`(() => {
        const storage = window.Vencord.Util.localStorage;
        storage.setItem('kawaicord-injection-test', 'ok');
        const stored = storage.getItem('kawaicord-injection-test');
        storage.removeItem('kawaicord-injection-test');
        return { status: window.kawaicordInjectionStatus, stored, removed: !window.localStorage };
      })()`);
      if (result.status.mod !== activeMod || result.status.error || result.stored !== 'ok' || !result.removed) throw new Error(JSON.stringify(result));
      console.log(`${activeMod}: real bundle initialized before page startup`);
      window.destroy();
    }
    server.close();
    app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
});
