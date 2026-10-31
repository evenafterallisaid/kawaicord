export interface ListeningTarget { session: string; uri: string; startMs: number; durationMs: number; paused?: boolean }
export interface ListeningFrame { revision: number; snapshot: ListeningTarget | null; restart?: boolean; pending?: boolean }
export interface LocalPlayer {
  uri(): string | undefined; playing(): boolean; position(): number; duration(): number;
  play(uri: string): Promise<void>; seek(ms: number): Promise<void>; resume(): Promise<void>; pause(): Promise<void>;
}
// the controller owns playback only while a fresh, explicit listen along session exists.
export class LocalListeningController {
  private frame: ListeningFrame = { revision: -1, snapshot: null };
  private blocked = '';
  private applying = false;
  private pending = false;
  private lastSeek = 0;
  private previousPosition = 0;
  private previousDuration = 0;
  private ownedSession = '';
  private transitioningFrom: string | undefined;
  private waiters = new Set<() => void>();
  constructor(private player: LocalPlayer, private report: (revision: number, result: string) => void, private now = Date.now) {}
  update(frame: ListeningFrame) {
    if (!Number.isSafeInteger(frame.revision) || frame.revision <= this.frame.revision) return;
    if (frame.snapshot && (!/^spotify:track:[a-zA-Z0-9]{22}$/.test(frame.snapshot.uri) || typeof frame.snapshot.session !== 'string' || !Number.isSafeInteger(frame.snapshot.startMs))) return;
    this.frame = frame;
    if (!frame.snapshot) { this.pending = false; this.ownedSession = ''; this.wake(); return; }
    if (frame.snapshot.session === this.blocked) return;
    if (frame.pending) { this.transitioningFrom = this.player.uri(); this.pending = false; this.wake(); return; }
    this.pending = true; this.wake(); void this.pump();
  }
  disconnect() { this.frame = { revision: -1, snapshot: null }; this.pending = false; this.ownedSession = ''; this.wake(); }
  private wake() { for (const fn of this.waiters) fn(); }
  private async waitForState(frame: ListeningFrame, playing = false) {
    const ready = () => this.frame !== frame || this.player.uri() === frame.snapshot?.uri && (!playing || this.player.playing());
    if (ready()) return;
    await new Promise<void>((resolve, reject) => {
      const check = () => { if (ready()) { clearTimeout(timer); this.waiters.delete(check); resolve(); } };
      const timer = setTimeout(() => { this.waiters.delete(check); reject(new Error('Spotify did not load the requested track')); }, 4000);
      this.waiters.add(check); check();
    });
  }
  private position(target: ListeningTarget) {
    const duration = this.player.duration() || target.durationMs;
    return Math.max(0, Math.min(this.now() - target.startMs, duration > 0 ? Math.max(0, duration - 250) : 3_600_000));
  }
  private async pump() {
    if (this.applying) return;
    this.applying = true;
    try {
      while (this.pending) {
        this.pending = false;
        const frame = this.frame, target = frame.snapshot;
        if (!target || target.session === this.blocked) continue;
        try {
          if (target.paused) {
            if (this.ownedSession === target.session && this.player.playing()) await this.player.pause();
            if (this.frame === frame) this.report(frame.revision, 'paused');
            continue;
          }
          this.ownedSession = target.session;
          if (frame.restart || this.player.uri() !== target.uri) { await this.player.play(target.uri); await this.waitForState(frame); }
          if (this.frame !== frame) continue;
          if (this.player.uri() !== target.uri) { this.release(frame); continue; }
          await this.player.seek(this.position(target));
          if (this.frame !== frame) continue;
          if (this.player.uri() !== target.uri) { this.release(frame); continue; }
          if (!this.player.playing()) await this.player.resume();
          await this.waitForState(frame, true);
          if (this.frame !== frame) continue;
          this.lastSeek = this.now();
          this.previousPosition = this.player.position(); this.previousDuration = this.player.duration();
          this.report(frame.revision, 'playing');
        } catch {
          if (this.frame === frame) { this.blocked = target.session; this.report(frame.revision, 'error'); }
        }
      }
    } finally { this.applying = false; }
  }
  observe(kind: 'progress' | 'song' | 'pause') {
    this.wake();
    const frame = this.frame, target = frame.snapshot;
    if (!target || target.paused || target.session === this.blocked || this.applying) return;
    const uri = this.player.uri();
    // a blank player is the failure being repaired, not a user's chosen replacement track.
    if (!uri || frame.pending && uri === this.transitioningFrom && uri !== target.uri) return;
    const changed = uri !== target.uri, paused = !this.player.playing();
    if ((kind === 'song' && changed) || (kind === 'pause' && paused)) {
      // a natural track boundary gets a short handover window for the next presence update.
      if (this.previousDuration > 0 && this.previousPosition >= this.previousDuration - 1500) {
        setTimeout(() => { if (this.frame === frame && (this.player.uri() !== target.uri || !this.player.playing())) this.release(frame); }, 2500);
      } else this.release(frame);
      return;
    }
    if (kind !== 'progress' || frame.pending) return;
    this.previousPosition = this.player.position(); this.previousDuration = this.player.duration();
    if (changed || paused || this.now() - this.lastSeek < 10_000) return;
    if (Math.abs(this.player.position() - this.position(target)) > 2500) {
      this.lastSeek = this.now();
      void this.player.seek(this.position(target)).catch(() => this.release(frame));
    }
  }
  private release(frame: ListeningFrame) {
    if (!frame.snapshot || frame.snapshot.session === this.blocked) return;
    this.blocked = frame.snapshot.session; this.pending = false;
    this.report(frame.revision, 'manual-stop');
  }
}
