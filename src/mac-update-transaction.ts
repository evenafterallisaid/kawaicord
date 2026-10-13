import { physicalFs } from './physical-fs';
import * as path from 'node:path';
const fs = physicalFs();

export type MacUpdateTransaction = {
  id: string;
  parentPid: number;
  target: string;
  workDir: string;
  staged: string;
  backup: string;
  version: string;
  receipt: string;
  args?: string[];
};

export function validateMacTransaction(tx: MacUpdateTransaction) {
  if (!/^[a-f0-9]{32}$/.test(tx.id) || !Number.isSafeInteger(tx.parentPid) || tx.parentPid <= 0
    || !/^\d+\.\d+\.\d+$/.test(tx.version)) throw new Error('Invalid update transaction.');
  if (tx.args && (!Array.isArray(tx.args) || tx.args.length > 32
    || tx.args.some(arg => typeof arg !== 'string' || arg.length > 4096 || arg.startsWith('--kawaicord-update-id=')))) throw new Error('Invalid update launch arguments.');
  for (const location of [tx.target, tx.workDir, tx.staged, tx.backup, tx.receipt]) {
    if (!path.isAbsolute(location) || path.resolve(location) !== location) throw new Error('Invalid update path.');
  }
  if (path.basename(tx.target) !== 'Kawaicord.app'
    || path.dirname(tx.workDir) !== path.dirname(tx.target)
    || !path.basename(tx.workDir).startsWith('.kawaicord-update-')
    || tx.staged !== path.join(tx.workDir, 'Kawaicord.app')
    || tx.backup !== path.join(tx.workDir, 'previous.app')
    || path.basename(tx.receipt) !== 'mac-update.json') throw new Error('Update paths are outside the installation.');
}

export type UpdateProcess = { stop(): Promise<void>; exited(): boolean };
export type TransactionRuntime = {
  parentAlive(): boolean;
  launch(executable: string, id?: string, args?: string[]): Promise<UpdateProcess>;
  wait(ms: number): Promise<void>;
  startupTimeoutMs?: number;
};

async function exists(location: string) {
  try { await fs.lstat(location); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

export async function runMacUpdateTransaction(tx: MacUpdateTransaction, runtime: TransactionRuntime) {
  validateMacTransaction(tx);
  const state = async (phase: string, error?: string) => {
    const temporary = `${tx.receipt}.${tx.id}.tmp`;
    await fs.writeFile(temporary, JSON.stringify({ ...tx, phase, error }), { mode: 0o600 });
    await fs.rename(temporary, tx.receipt);
  };
  for (const location of [tx.target, tx.workDir, tx.staged]) {
    const stat = await fs.lstat(location);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Update directory is not a real directory.');
  }
  if (await exists(tx.backup)) throw new Error('Update backup already exists.');
  await fs.writeFile(path.join(tx.workDir, 'ready'), tx.id, { mode: 0o600 });
  // Never terminate the original app. If it fails to quit, leave it untouched.
  let elapsed = 0;
  while (runtime.parentAlive()) {
    if (elapsed >= 30_000 || await exists(path.join(tx.workDir, 'cancel'))) throw new Error('Update handoff cancelled or app did not quit.');
    await runtime.wait(100);
    elapsed += 100;
  }
  if (await exists(path.join(tx.workDir, 'cancel'))) throw new Error('Update handoff cancelled.');
  let backedUp = false;
  let replaced = false;
  let replacement: UpdateProcess | undefined;
  try {
    await fs.rename(tx.target, tx.backup);
    backedUp = true;
    await fs.rename(tx.staged, tx.target);
    replaced = true;
    await state('launching');
    replacement = await runtime.launch(path.join(tx.target, 'Contents', 'MacOS', 'Kawaicord'), tx.id, tx.args);
    const timeout = runtime.startupTimeoutMs ?? 60_000;
    for (let waited = 0; waited <= timeout; waited += 100) {
      const ack = await fs.readFile(path.join(tx.workDir, 'ack'), 'utf8').catch(() => '');
      if (ack === `${tx.id}:${tx.version}` && !replacement.exited()) {
        await state('committed');
        // The exact backup path was validated above; user profiles are elsewhere.
        // A cleanup failure after confirmation must never roll back a healthy app.
        await fs.rm(tx.backup, { recursive: true, force: true }).catch(() => {});
        return;
      }
      if (replacement.exited()) throw new Error('Updated app exited before confirming startup.');
      await runtime.wait(100);
    }
    throw new Error('Updated app did not confirm startup.');
  } catch (error) {
    // Wait for our replacement process to exit before restoring the old bundle.
    if (replacement) await replacement.stop();
    if (replaced) await fs.rename(tx.target, tx.staged);
    if (backedUp) await fs.rename(tx.backup, tx.target);
    await state('rolled-back', String(error));
    await runtime.launch(path.join(tx.target, 'Contents', 'MacOS', 'Kawaicord'), undefined, tx.args);
    throw error;
  }
}
