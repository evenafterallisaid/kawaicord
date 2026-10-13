// Standalone Node helper. It runs outside app.asar so the app can be replaced.
import * as fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { MacUpdateTransaction, runMacUpdateTransaction, UpdateProcess } from './mac-update-transaction';

const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

async function launch(executable: string, id?: string, args: string[] = []): Promise<UpdateProcess> {
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const child = spawn(executable, [...args, ...(id ? [`--kawaicord-update-id=${id}`] : [])], {
    detached: true, stdio: 'ignore', env: environment
  });
  await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  let exited = false;
  child.once('exit', () => { exited = true; });
  child.unref();
  return {
    exited: () => exited,
    stop: async () => {
      if (exited) return;
      child.kill('SIGTERM');
      for (let i = 0; i < 50 && !exited; i++) await wait(100);
      if (!exited) child.kill('SIGKILL');
      for (let i = 0; i < 50 && !exited; i++) await wait(100);
      if (!exited) throw new Error('Could not stop failed update; previous app remains in the backup.');
    }
  };
}

async function main() {
  const tx = JSON.parse(await fs.readFile(process.argv[2], 'utf8')) as MacUpdateTransaction;
  await runMacUpdateTransaction(tx, {
    parentAlive: () => {
      try { process.kill(tx.parentPid, 0); return true; }
      catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
    }, launch, wait
  });
}

if (require.main === module) void main().catch(error => { console.error(error); process.exitCode = 1; });
