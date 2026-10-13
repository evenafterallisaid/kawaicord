// Electron virtualizes .asar archives. App-bundle transactions must operate on
// physical files, especially recursive deletion of an old Resources directory.
export function physicalFs(): typeof import('node:fs/promises') {
  try { return (require('original-fs') as typeof import('node:fs')).promises; }
  catch { return require('node:fs/promises'); } // Plain Node test/helper runtime.
}
