import { readFile, writeFile, readdir, open } from 'node:fs/promises';
import { join, resolve, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

const directory = resolve(process.argv[2]);
const { version } = JSON.parse(await readFile('package.json', 'utf8'));
const tag = process.env.GITHUB_REF_NAME;
const repository = process.env.GITHUB_REPOSITORY;
assert.equal(tag, `v${version}`);
assert.equal(repository, 'evenafterallisaid/kawaicord');
const assets = await readdir(directory, { recursive: true });
const image = assets.filter(name => name.endsWith('.AppImage'));
assert.equal(image.length, 1, 'expected one linux updater payload');
const payload = await open(join(directory, image[0]), 'r');
const header = Buffer.alloc(20);
try { await payload.read(header, 0, header.length, 0); } finally { await payload.close(); }
assert.ok(header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) && header[4] === 2 && header[5] === 1 && header.readUInt16LE(18) === 62, 'linux updater must be an x86_64 elf');
assert.ok(assets.some(name => name.endsWith('.deb')), 'linux installer is missing');
const signature = (await readFile(join(directory, `${image[0]}.sig`), 'utf8')).trim();
assert.ok(signature.length > 100, 'linux updater signature is missing');
const gh = (...args) => execFileSync('gh', [...args, '--repo', repository], { stdio: 'inherit' });
gh('release', 'download', tag, '--pattern', 'latest.json', '--dir', directory);
const manifestPath = join(directory, 'latest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
assert.equal(manifest.version.replace(/^v/, ''), version);
for (const platform of ['darwin-aarch64', 'darwin-x86_64', 'windows-x86_64']) {
  assert.ok(manifest.platforms[platform]?.signature && manifest.platforms[platform]?.url, `missing ${platform} updater`);
}
manifest.platforms['linux-x86_64'] = {
  signature,
  url: `https://github.com/${repository}/releases/download/${tag}/${encodeURIComponent(basename(image[0]))}`
};
await writeFile(manifestPath, JSON.stringify(manifest, null, 2)+'\n');
gh('release', 'upload', tag, ...assets.filter(name => /\.(AppImage|deb|sig)$/.test(name)).map(name => join(directory, name)));
gh('release', 'upload', tag, manifestPath, '--clobber');
