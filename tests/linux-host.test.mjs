import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const directory = await mkdtemp(join(tmpdir(), 'kawaicord-host-test-'));
after(() => rm(directory, { recursive: true, force: true }));
await build({ entryPoints: ['linux-host/src/policy.ts', 'linux-host/src/core-bridge.ts'], outdir: directory, bundle: true, platform: 'node', format: 'esm' });
const policy = await import(pathToFileURL(join(directory, 'policy.js')));
const { CoreBridge } = await import(pathToFileURL(join(directory, 'core-bridge.js')));

test('linux privileges remain limited to discord and narrow client actions', () => {
  for (const url of ['https://discord.com/app', 'https://canary.discord.com/channels/@me', 'https://ptb.discord.com/']) assert.ok(policy.trusted(url));
  for (const url of ['https://discord.com.evil.test/', 'https://discord.com@evil.test/', 'https://name@discord.com/', 'http://discord.com', 'file:///tmp/index.html', 'https://discord.com:8443']) assert.equal(policy.trusted(url), false);
  assert.ok(policy.embedded('https://newassets.hcaptcha.com/captcha/v1/frame'));
  assert.equal(policy.embedded('https://hcaptcha.com.evil.test'), false);
  assert.ok(policy.external('spotify:'));
  assert.ok(policy.external('spotify:track:1234567890123456789012'));
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'spotify:app:arbitrary', 'spotify://host/track']) assert.equal(policy.external(url), false);
  for (const id of ['../main', '', 'x'.repeat(33), 'hello/world']) assert.throws(() => policy.instanceId(id));
  assert.equal(policy.commands.has('execute_script'), false);
});

test('private core pipe correlates concurrent replies and reports service failure', async () => {
  const fixture = join(directory, 'fixture.cjs');
  await writeFile(fixture, `const lines=require('node:readline').createInterface({input:process.stdin});lines.on('line',line=>{const r=JSON.parse(line);if(r.command==='crash')process.exit(1);else setTimeout(()=>{process.stdout.write(JSON.stringify({id:r.id,value:r.args.value})+'\\n');if(r.command==='shutdown')process.exit(0)},r.args.delay||0)})`);
  const core = new CoreBridge(process.execPath, [fixture]);
  try {
    assert.deepEqual(await Promise.all([core.request('one', { value: 1, delay: 30 }), core.request('two', { value: 2 })]), [1, 2]);
    await assert.rejects(core.request('crash'), /Rust service stopped/);
    await assert.rejects(core.request('one'), /unavailable/);
  } finally { await core.close(); }
});
