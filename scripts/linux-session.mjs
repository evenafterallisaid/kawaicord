import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as pause } from 'node:timers/promises';

// xvfb supplies a display; native maximize/restore also needs a window manager.
const manager = spawn('openbox', [], { stdio: 'ignore' });
let managerError;
manager.on('error', error => { managerError = error; });
try {
  let ready = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    if (managerError) throw managerError;
    const result = spawnSync('xprop', ['-root', '_NET_SUPPORTING_WM_CHECK'], { encoding: 'utf8' });
    if (result.status === 0 && /window id # 0x[1-9a-f]/i.test(result.stdout)) { ready = true; break; }
    await pause(100);
  }
  if (!ready) throw new Error('The test window manager did not initialize');
  const child = spawn(process.execPath, ['scripts/smoke-native.mjs', ...process.argv.slice(2)], { stdio: 'inherit' });
  const timer = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 470_000);
  try { process.exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code ?? 1)); }); } finally { clearTimeout(timer); }
} finally { manager.kill(); }
