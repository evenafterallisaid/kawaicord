import { build } from 'esbuild';
import { mkdir,copyFile } from 'node:fs/promises';
await mkdir('web-dist',{recursive:true});
await Promise.all([
 build({entryPoints:['native-ui/bootstrap.ts'],outfile:'web-dist/bootstrap.js',bundle:true,format:'iife',target:['safari15','chrome105','firefox102'],minify:true}),
 build({entryPoints:['native-ui/settings.ts'],outfile:'web-dist/settings.js',bundle:true,format:'esm',target:['safari15','chrome105','firefox102'],minify:true}),
 ...['index.html','settings.css'].map(name=>copyFile(`native-ui/${name}`,`web-dist/${name}`)),
 copyFile('icons/icon.png','web-dist/icon.png')
]);
