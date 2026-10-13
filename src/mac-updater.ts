import { app } from 'electron';
import { AppUpdater, ResolvedUpdateFileInfo } from 'electron-updater';
import { DownloadUpdateOptions } from 'electron-updater/out/AppUpdater';
import { ElectronHttpExecutor } from 'electron-updater/out/electronHttpExecutor';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ChildProcess, execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { MacUpdateTransaction, validateMacTransaction } from './mac-update-transaction';

const execute = promisify(execFile);
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export function macAppBundle(executable: string): string {
  const bundle = path.posix.resolve(executable, '..', '..', '..');
  if (path.posix.basename(bundle) !== 'Kawaicord.app' || bundle.startsWith('/Volumes/')
    || bundle.includes('/AppTranslocation/')) {
    throw new Error('Move Kawaicord to Applications before updating.');
  }
  return bundle;
}

export function selectMacUpdateFile(files: ResolvedUpdateFileInfo[], arch: string) {
  const candidates = files.filter(file => file.url.pathname.endsWith('.zip')
    && (file.url.pathname.includes('-universal.') || file.url.pathname.includes(`-${arch}.`)));
  const file = candidates.find(file => file.url.pathname.includes('-universal.')) ?? candidates[0];
  if (!file || file.url.protocol !== 'https:' || file.url.hostname !== 'github.com'
    || !file.url.pathname.startsWith('/evenafterallisaid/kawaicord/releases/download/')
    || !/^[A-Za-z0-9+/]{86}==$/.test(file.info.sha512)) throw new Error('No verified macOS update for this architecture.');
  return file;
}

export function validateMacZipEntries(entries: string[]) {
  for (const entry of entries) {
    if (!entry || entry.startsWith('/') || entry.includes('\\') || entry.split('/').includes('..')
      || !(entry.startsWith('Kawaicord.app/') || entry.startsWith('__MACOSX/'))) {
      throw new Error('Update archive contains an unsafe path.');
    }
  }
}

async function verifySymlinks(root: string, directory = root): Promise<void> {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const location = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      const resolved = await fs.realpath(location);
      if (!resolved.startsWith(`${root}${path.sep}`)) throw new Error('Update symlink escapes the app bundle.');
    } else if (entry.isDirectory()) await verifySymlinks(root, location);
  }
}

async function plistValue(bundle: string, key: string) {
  return (await execute('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', path.join(bundle, 'Contents', 'Info.plist')])).stdout.trim();
}

async function teamIdentifier(bundle: string) {
  const output = await execute('/usr/bin/codesign', ['-dv', '--verbose=4', bundle]);
  return output.stderr.match(/^TeamIdentifier=(\w+)$/m)?.[1];
}

export class MacZipUpdater extends AppUpdater {
  private prepared: MacUpdateTransaction | null = null;
  private downloader = new ElectronHttpExecutor();

  constructor() {
    super({ provider: 'github', owner: 'evenafterallisaid', repo: 'kawaicord' });
    // Applying a ready update is explicit, so quitting during a call never
    // unexpectedly schedules a swap or launches a replacement process.
    this.autoInstallOnAppQuit = false;
  }

  protected async doDownloadUpdate(options: DownloadUpdateOptions): Promise<string[]> {
    const file = selectMacUpdateFile(options.updateInfoAndProvider.provider.resolveFiles(options.updateInfoAndProvider.info), process.arch);
    return this.executeDownload({
      fileExtension: 'zip', fileInfo: file, downloadUpdateOptions: options,
      task: (destination, downloadOptions) => this.downloader.download(file.url, destination, downloadOptions),
      done: async event => {
        const target = await fs.realpath(macAppBundle(app.getPath('exe')));
        await fs.access(path.dirname(target), fs.constants.W_OK);
        const pendingPath = path.join(app.getPath('userData'), 'mac-pending.json');
        try {
          const previous = JSON.parse(await fs.readFile(pendingPath, 'utf8')) as MacUpdateTransaction;
          validateMacTransaction(previous);
          if (previous.target === target) await fs.rm(previous.workDir, { recursive: true, force: true });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this._logger.warn(`Could not clean previous update staging: ${String(error)}`);
        }
        const workDir = await fs.mkdtemp(path.join(path.dirname(target), '.kawaicord-update-'));
        await fs.chmod(workDir, 0o700);
        try {
          const listing = await execute('/usr/bin/unzip', ['-Z1', event.downloadedFile], { maxBuffer: 16 * 1024 * 1024 });
          validateMacZipEntries(listing.stdout.trim().split('\n'));
          await execute('/usr/bin/ditto', ['-x', '-k', event.downloadedFile, workDir]);
          const staged = path.join(workDir, 'Kawaicord.app');
          if ((await fs.lstat(staged)).isSymbolicLink()) throw new Error('Invalid app bundle.');
          await verifySymlinks(staged);
          if (await plistValue(staged, 'CFBundleIdentifier') !== 'com.kawaicord.app'
            || await plistValue(staged, 'CFBundleShortVersionString') !== event.version) throw new Error('Update app identity or version does not match.');
          const architectures = (await execute('/usr/bin/lipo', ['-archs', path.join(staged, 'Contents', 'MacOS', 'Kawaicord')])).stdout;
          if (!architectures.split(/\s+/).includes(process.arch === 'arm64' ? 'arm64' : 'x86_64')) throw new Error('Update cannot run on this Mac.');
          await execute('/usr/bin/codesign', ['--verify', '--deep', '--strict', staged]);
          const currentTeam = await teamIdentifier(target);
          if (currentTeam && await teamIdentifier(staged) !== currentTeam) throw new Error('Update signing identity does not match the installed app.');
          this.prepared = { id: randomBytes(16).toString('hex'), parentPid: process.pid, target, workDir, staged,
            backup: path.join(workDir, 'previous.app'), version: event.version,
            receipt: path.join(app.getPath('userData'), 'mac-update.json') };
          await fs.writeFile(pendingPath, JSON.stringify(this.prepared), { mode: 0o600 });
          this.dispatchUpdateDownloaded(event);
        } catch (error) {
          // mkdtemp created this exact, private directory beneath the app parent.
          await fs.rm(workDir, { recursive: true, force: true });
          throw error;
        }
      }
    });
  }

  async prepareInstall(): Promise<void> {
    const tx = this.prepared;
    if (!tx) throw new Error('No verified update is ready.');
    validateMacTransaction(tx);
    await fs.access(path.dirname(tx.target), fs.constants.W_OK);
    for (const file of ['mac-update-helper.js', 'mac-update-transaction.js']) {
      await fs.copyFile(path.join(__dirname, file), path.join(tx.workDir, file));
    }
    const manifest = path.join(tx.workDir, 'transaction.json');
    await fs.writeFile(manifest, JSON.stringify(tx), { mode: 0o600 });
    await fs.writeFile(tx.receipt, JSON.stringify({ ...tx, phase: 'prepared' }), { mode: 0o600 });
    const log = await fs.open(path.join(tx.workDir, 'helper.log'), 'a', 0o600);
    let helper: ChildProcess;
    try {
      helper = spawn(app.getPath('exe'), [path.join(tx.workDir, 'mac-update-helper.js'), manifest], {
        detached: true, stdio: ['ignore', log.fd, log.fd],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
      });
      const spawned = helper;
      await new Promise<void>((resolve, reject) => { spawned.once('spawn', resolve); spawned.once('error', reject); });
    } finally { await log.close(); }
    helper.unref();
    for (let elapsed = 0; elapsed < 5000; elapsed += 100) {
      if (await fs.readFile(path.join(tx.workDir, 'ready'), 'utf8').catch(() => '') === tx.id) return;
      if (helper.exitCode !== null) break;
      await wait(100);
    }
    await fs.writeFile(path.join(tx.workDir, 'cancel'), tx.id);
    throw new Error('Update helper could not start. Kawaicord is still running.');
  }

  quitAndInstall() { app.quit(); }
}

export async function acknowledgeMacUpdate() {
  const id = process.argv.find(arg => arg.startsWith('--kawaicord-update-id='))?.split('=')[1];
  if (!id) return;
  const receipt = path.join(app.getPath('userData'), 'mac-update.json');
  const tx = JSON.parse(await fs.readFile(receipt, 'utf8')) as MacUpdateTransaction;
  validateMacTransaction(tx);
  if (tx.receipt !== receipt || tx.id !== id || tx.version !== app.getVersion() || tx.target !== await fs.realpath(macAppBundle(app.getPath('exe')))) {
    throw new Error('Update startup receipt does not match this app.');
  }
  await fs.writeFile(path.join(tx.workDir, 'ack'), `${id}:${tx.version}`, { mode: 0o600 });
}
