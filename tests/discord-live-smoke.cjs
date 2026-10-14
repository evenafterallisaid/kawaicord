// Optional network test: ensure the bundled mods hook today's Discord, not
// merely that their top-level scripts execute on an empty synthetic page.
const { app, BrowserWindow, ipcMain, protocol } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'kawaicord-discord-smoke-'));
app.setPath('userData', profile);
app.on('window-all-closed', () => {});
protocol.registerSchemesAsPrivileged([{ scheme: 'kawaicord', privileges: {
  standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, bypassCSP: true
} }]);
let activeMod = 'vencord';
ipcMain.on('kawaicord:getStartupBundles', event => {
  const read = (name, ext) => fs.readFileSync(path.join(root, name, `${name}.${ext}`), 'utf8');
  event.returnValue = { activeMod, safeMode: false, shelter: { js: read('shelter', 'js') },
    mod: { enabled: true, js: read(activeMod, 'js'), css: read(activeMod, 'css') } };
});
for (const channel of ['kawaicord:getConfig', 'window:getState', 'window:getNavigationState']) {
  ipcMain.handle(channel, () => ({}));
}

app.whenReady().then(async () => {
  try {
    for (activeMod of ['vencord', 'equicord']) {
      const window = new BrowserWindow({ show: false, webPreferences: {
        preload: path.join(root, 'dist/preload.js'), contextIsolation: false, sandbox: false,
        backgroundThrottling: false, partition: `smoke-${activeMod}`
      } });
      // Match the application's main-document policy patch; TLS verification
      // remains enabled. This profile is always fresh and never signs in.
      window.webContents.session.webRequest.onHeadersReceived({ urls: ['https://discord.com/*'] },
        (details, callback) => {
          const headers = { ...details.responseHeaders };
          if (details.resourceType === 'mainFrame') {
            for (const key of Object.keys(headers)) {
              if (key.toLowerCase().startsWith('content-security-policy')) delete headers[key];
            }
          }
          callback({ responseHeaders: headers });
        });
      window.webContents.session.protocol.handle('kawaicord', request => {
        const filename = new URL(request.url).pathname.split('/').at(-1);
        if (!['plugin.js', 'plugin.json'].includes(filename)) return new Response('bad', { status: 404 });
        return new Response(fs.readFileSync(path.join(root, 'plugins/settings', filename)), {
          headers: { 'Access-Control-Allow-Origin': 'https://discord.com' }
        });
      });
      let loadError;
      void window.loadURL('https://discord.com/app').catch(error => { loadError = error; });
      let result;
      const deadline = Date.now() + 60_000;
      do {
        await new Promise(resolve => setTimeout(resolve, 500));
        if (loadError) throw loadError;
        result = await window.webContents.executeJavaScript(`({
          status: window.kawaicordInjectionStatus,
          shelter: !!window.shelter,
          modules: Object.keys(window.Vencord?.Webpack?.cache || {}).length,
          loading: !!document.getElementById('kawaicord-boot-splash')
        })`);
        if (result.shelter && result.modules > 100 && !result.loading) break;
      } while (Date.now() < deadline);
      assert.equal(result.status?.mod, activeMod, JSON.stringify(result));
      assert.equal(result.status?.error, null, JSON.stringify(result));
      assert.ok(result.shelter && result.modules > 100 && !result.loading, JSON.stringify(result));
      console.log(`${activeMod}: Shelter and ${result.modules} Discord modules initialized`);
      window.destroy();
    }
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
