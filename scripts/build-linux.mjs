import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
await build({ absWorkingDir: fileURLToPath(new URL('..', import.meta.url)), entryPoints: ['linux-host/src/main.ts', 'linux-host/src/preload.ts'], outdir: 'linux-host/out', outExtension: { '.js': '.cjs' }, bundle: true, format: 'cjs', platform: 'node', target: 'node24', external: ['electron'], minify: true });
