import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';

const binary = resolve(process.argv[2] ?? (process.platform === 'darwin'
  ? 'src-tauri/target/release/bundle/macos/Kawaicord.app/Contents/MacOS/kawaicord'
  : `src-tauri/target/release/kawaicord${process.platform === 'win32' ? '.exe' : ''}`));
const backgroundTest = process.argv.includes('--background');
const integrationTest = process.argv.includes('--integration');
const mediaPreflight = process.argv.includes('--media-preflight');
const mediaTest = process.argv.includes('--media') || mediaPreflight;
for (const activeMod of integrationTest ? ['illegalcord'] : backgroundTest || mediaTest ? ['vencord'] : ['vencord', 'equicord', 'illegalcord']) {
  const profile = await mkdtemp(join(tmpdir(), 'kawaicord-smoke-'));
  let failed = false;
  try {
    await writeFile(join(profile, 'config.json'), JSON.stringify({ activeMod, richPresence: false,
      autoUpdateMods: false, autoUpdateApp: false, notifications: false, startAtLogin: false }));
    const child = spawn(binary, ['--smoke-test', '--profile', profile, ...(backgroundTest ? ['--background-test'] : []), ...(integrationTest ? ['--integration-test'] : []), ...(mediaTest ? ['--media-test'] : []), ...(mediaPreflight ? ['--media-preflight'] : [])], {
      stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, WEBKIT_DISABLE_DMABUF_RENDERER: '1' }
    });
    let output = '';
    for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { output = (output + data).slice(-12000); });
    const timer = setTimeout(() => child.kill('SIGKILL'), backgroundTest ? 450000 : integrationTest ? 330000 : 110000);
    let code;
    try {
      code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    } finally { clearTimeout(timer); }
    let status;
    try { status = JSON.parse(await readFile(join(profile, 'runtime.json'), 'utf8')); }
    catch { throw new Error(`${activeMod} produced no startup report (exit ${code})\n${output}`); }
    let integration;
    if (integrationTest) {
      try { integration = JSON.parse(await readFile(join(profile, 'integration.json'), 'utf8')); }
      catch { integration = { ok: false, error: 'no integration report' }; }
    }
    let media;
    if (mediaTest) {
      try { media = JSON.parse(await readFile(join(profile, 'media.json'), 'utf8')); }
      catch { media = { ok: false, error: 'no media report' }; }
    }
    const log = code === 0 ? '' : await readFile(join(profile, 'kawaicord.log'), 'utf8').catch(() => '');
    assert.equal(code, 0, `${activeMod}: ${JSON.stringify(status)}\n${JSON.stringify(integration ?? media ?? {})}\n${log}\n${output}`);
    assert.equal(status.activeMod, activeMod);
    assert.equal(status.safeMode, false);
    assert.equal(status.ready, true);
    assert.equal(status.shelter, true);
    assert.ok(status.modules > 100);
    assert.equal(status.media, true);
    if (backgroundTest) { assert.equal(status.backgroundHidden, true); assert.ok(status.backgroundElapsed >= 370000); }
    if (integrationTest) { assert.equal(integration.ok, true, JSON.stringify(integration)); console.log(JSON.stringify(integration)); }
    if (mediaTest) {
      assert.equal(media.ok, true, JSON.stringify(media));
      assert.equal(media.peerConnection, true);
      assert.equal(media.discordVoiceSupported, true, 'Discord must select a supported voice engine');
      assert.equal(media.encodedTransforms, true);
      if (!mediaPreflight) assert.ok(media.receivedBytes > 0);
      if (process.platform === 'darwin') assert.match(media.userAgent, /Version\/[\d.]+ Safari\//);
      console.log(JSON.stringify(media));
    }
    console.log(JSON.stringify(status));
  } catch (error) { failed = true; throw error; }
  finally {
    try { await rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
    catch (error) { if (!failed) throw error; console.error(`temporary profile cleanup: ${String(error)}`); }
  }
}
