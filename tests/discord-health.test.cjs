const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../dist/main.js'), 'utf8');

// Run the real main-process lifecycle functions with a controllable clock.
function fixture() {
  const timers = new Map();
  const sent = [];
  const reloads = [];
  let nextTimer = 1;
  const context = vm.createContext({
    injectionWatchdogTimer: null, discordHealthWatchdogTimer: null,
    rendererInjectionReady: false, discordRendererReady: false,
    discordDocumentFailed: false, discordRecoveryAttempts: 0,
    sessionSafeMode: false, isQuitting: false, restartInProgress: false,
    appendLog() {},
    setTimeout(callback) { const id = nextTimer++; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); },
    mainWindow: {
      isDestroyed: () => false,
      webContents: {
        send: (...args) => sent.push(args),
        reload: () => reloads.push('normal'),
        reloadIgnoringCache: () => reloads.push('uncached')
      }
    }
  });
  vm.runInContext(source.slice(source.indexOf('function clearInjectionWatchdog()'),
    source.indexOf('function updateWindowPerformance()')), context);
  return {
    context, timers, sent, reloads,
    run: code => vm.runInContext(code, context),
    tick() {
      const callbacks = [...timers.values()];
      timers.clear();
      callbacks.forEach(callback => callback());
    }
  };
}

test('a failed TLS document cancels health/injection retries without disabling mods', () => {
  const f = fixture();
  f.run('requestRendererInjection("test"); armDiscordHealthWatchdog()');
  f.run('markDiscordLoadFailed(-202, "ERR_CERT_AUTHORITY_INVALID", "https://discord.com/app")');
  f.run('armDiscordHealthWatchdog()'); // Chromium finishes its error document.
  assert.equal(f.timers.size, 0);
  assert.equal(f.context.sessionSafeMode, false);
  assert.equal(f.reloads.length, 0);
  assert.match(f.sent.at(-1)[1], /ERR_CERT_AUTHORITY_INVALID/);

  f.run('reloadDiscord("manual retry"); armDiscordHealthWatchdog()');
  assert.equal(f.context.discordDocumentFailed, false);
  assert.equal(f.timers.size, 1);
});

test('a slow Discord page gets one reload and retains the selected mod', () => {
  const f = fixture();
  f.run('armDiscordHealthWatchdog()');
  f.tick();
  assert.deepEqual(f.reloads, ['normal']);
  f.run('armDiscordHealthWatchdog()');
  f.tick();
  assert.deepEqual(f.reloads, ['normal']);
  assert.equal(f.context.sessionSafeMode, false);
  assert.equal(f.sent.at(-1)[0], 'kawaicord:discordFailed');

  f.run('reloadDiscord("manual retry")');
  assert.equal(f.context.discordRecoveryAttempts, 0);
});

test('a UI that became ready before did-finish-load is not reloaded', () => {
  const f = fixture();
  f.context.discordRendererReady = true;
  f.run('armDiscordHealthWatchdog()');
  f.tick();
  assert.equal(f.reloads.length, 0);
});

test('a quiet Discord UI schedules its own second ready frame', () => {
  const preload = fs.readFileSync(require.resolve('../dist/preload.js'), 'utf8');
  const start = preload.indexOf('const checkReady = () =>');
  const end = preload.indexOf('const scheduleReadyCheck =', start);
  let scheduled = 0;
  let finished = false;
  const sent = [];
  const content = { textContent: 'Discord is ready to use', querySelector: () => null };
  const context = vm.createContext({
    checkFrame: null, readyFrames: 0,
    document: { getElementById: () => content },
    electron_1: { ipcRenderer: { send: channel => sent.push(channel) } },
    scheduleReadyCheck: () => scheduled++,
    finish: () => { finished = true; }
  });
  vm.runInContext(preload.slice(start, end), context);
  vm.runInContext('checkReady()', context);
  assert.equal(scheduled, 1);
  assert.equal(finished, false);
  vm.runInContext('checkReady()', context);
  assert.equal(finished, true);
  assert.deepEqual(sent, ['kawaicord:discordReady']);
});
