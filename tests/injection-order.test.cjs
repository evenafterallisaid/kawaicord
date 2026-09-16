const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../dist/preload.js'), 'utf8');

for (const mod of ['equicord', 'vencord']) {
  test(`${mod} starts before page tasks can remove storage, and releases bundle source`, async () => {
    const start = source.indexOf('const injectionStatus =');
    const end = source.indexOf('function ensureClientModsInjected', start);
    const storage = { getItem: () => '{}' };
    const page = vm.createContext({ localStorage: storage });
    page.window = page;
    let reported;
    const context = vm.createContext({
      window: {}, console,
      mod_patches_1: { routeClientModRestarts: source => ({ source, restartHooks: 1 }) },
      electron_1: {
        ipcRenderer: {
          sendSync: () => ({ activeMod: mod, safeMode: false, shelter: { js: '' },
            mod: { enabled: true, js: 'window.capturedStorage = window.localStorage;', css: '' } }),
          invoke: () => { throw new Error('Async IPC would race Discord startup'); },
          send: (_channel, status) => { reported = status; }
        },
        webFrame: {
          executeJavaScript: code => Promise.resolve(vm.runInContext(code, page)),
          insertCSS: () => Promise.resolve()
        }
      }
    });
    vm.runInContext(source.slice(start, end), context);
    vm.runInContext('injectionStatus.shelter = true', context);
    const completion = vm.runInContext('injectModOnce("test")', context);
    await new Promise(resolve => setImmediate(() => { delete page.localStorage; resolve(); }));
    assert.equal(await completion, true);
    assert.equal(page.capturedStorage, storage);
    assert.equal(reported.mod, mod);
    assert.equal(vm.runInContext('startupBundles', context), null);
  });
}
