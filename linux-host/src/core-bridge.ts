import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';

export class CoreBridge extends EventEmitter {
  readonly process: ChildProcessWithoutNullStreams;
  private sequence = 0;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timeout: NodeJS.Timeout }>();
  dead = false;
  constructor(binary: string, args: string[]) {
    super(); this.process = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    createInterface({ input: this.process.stdout }).on('line', line => {
      try {
        const message = JSON.parse(line);
        if (message.event) { this.emit(message.event, message); return; }
        const request = this.pending.get(message.id);
        if (!request) return;
        this.pending.delete(message.id); clearTimeout(request.timeout);
        if (typeof message.error === 'string') request.reject(new Error(message.error)); else request.resolve(message.value);
      } catch { this.fail('Invalid response from the Rust service'); }
    });
    // the pipe is drained without copying application or credential data into logs.
    this.process.stderr.on('data', () => {});
    this.process.on('error', () => this.fail('The Rust service could not be started'));
    this.process.on('exit', () => this.fail('The Rust service stopped. Restart Kawaicord when ready.'));
  }
  private fail(message: string) {
    if (this.dead) return; this.dead = true;
    for (const request of this.pending.values()) { clearTimeout(request.timeout); request.reject(new Error(message)); }
    this.pending.clear(); this.emit('stopped', message);
  }
  request(command: string, args: Record<string, unknown> = {}): Promise<any> {
    if (this.dead) return Promise.reject(new Error('The Rust service is unavailable'));
    if (this.pending.size >= 64) return Promise.reject(new Error('Too many pending requests'));
    const id = ++this.sequence;
    const data = JSON.stringify({ id, command, args });
    if (data.length > 40 * 1024 * 1024) return Promise.reject(new Error('The request exceeds its size limit'));
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { this.pending.delete(id); reject(new Error('The Rust service request timed out')); }, command === 'install_update' ? 16 * 60_000 : command === 'refresh_mods' ? 90_000 : 40_000);
      this.pending.set(id, { resolve, reject, timeout });
      this.process.stdin.write(data+'\n', error => { if (error) this.fail('The Rust service connection closed'); });
    });
  }
  async close() {
    if (this.dead) return;
    let timeout: NodeJS.Timeout | undefined;
    await Promise.race([this.request('shutdown').catch(() => {}), new Promise<void>(resolve => { timeout = setTimeout(resolve, 2000); })]);
    clearTimeout(timeout); this.process.stdin.end();
    if (this.process.exitCode === null) {
      const timer = setTimeout(() => this.process.kill(), 2000); timer.unref();
      this.process.once('exit', () => clearTimeout(timer));
    }
  }
}
