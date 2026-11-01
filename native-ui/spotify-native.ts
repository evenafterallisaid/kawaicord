import { LocalListeningController, type ListeningFrame } from './spotify-companion-controller';
import type { Invoke } from './discord-settings';
import type { SpotifyBridgeStatus } from './spotify-local';
interface State { uri: string; playing: boolean; positionMs: number }
// poll only during an explicit listening session; native calls never run on an idle timer.
export class NativeSpotifyPlayer {
  private state: State = { uri: '', playing: false, positionMs: 0 };
  private controller: LocalListeningController;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private generation = 0;
  private active = false;
  private reading = false;
  private session = '';
  private blockedSession = '';
  private failureMessage = '';
  private outcome = 'idle';
  private requestSequence = 0;
  private acceptedSequence = 0;
  private durationMs = 0;
  private stateAt = Date.now();
  private waiters = new Set<() => void>();
  private targetKey = '';
  private targetStartMs = 0;
  private change: (command: Record<string, unknown>) => Promise<void>;
  constructor(private invoke: Invoke, private report: (status: SpotifyBridgeStatus) => void) {
    const change = this.change = async (command: Record<string, unknown>) => {
      const generation = this.generation, sequence = ++this.requestSequence;
      const state = await this.call(command);
      if (generation === this.generation && sequence >= this.acceptedSequence) { this.acceptedSequence = sequence; this.accept(state); }
    };
    this.controller = new LocalListeningController({
      uri: () => this.state.uri, playing: () => this.state.playing, position: () => this.position(), duration: () => this.durationMs,
      play: uri => change({ action: 'play', uri }), seek: positionMs => this.seek(positionMs),
      resume: () => change({ action: 'resume', uri: this.state.uri }), pause: () => change({ action: 'pause', uri: this.state.uri })
    }, (_, outcome) => {
      this.outcome = outcome;
      this.report({ connected: outcome !== 'error', outcome, message: outcome === 'error' ? this.failureMessage || 'Native Spotify playback failed. Check the connection report, then retry Listen Along.' : 'Using native Spotify playback.' });
      if (outcome === 'error' || outcome === 'manual-stop') { this.blockedSession = this.session; this.stopPolling(); }
    });
  }
  private accept(state: State) { this.state = state; this.stateAt = Date.now(); for (const wake of [...this.waiters]) wake(); }
  private position() { return this.state.positionMs + (this.state.playing ? Math.max(0, Date.now() - this.stateAt) : 0); }
  private async seek(positionMs: number) {
    const uri = this.state.uri, generation = this.generation, started = Date.now(), advancing = this.state.playing;
    const target = () => Math.max(0, Math.min(positionMs + (advancing ? Date.now() - started : 0), this.durationMs > 0 ? this.durationMs - 250 : 3_600_000));
    const current = () => generation === this.generation && this.active && this.state.uri === uri;
    const aligned = () => Math.abs(this.position() - target()) <= 1500;
    for (let attempt = 0; attempt < 3 && current(); attempt++) {
      await this.change({ action: 'seek', positionMs: Math.round(target()), uri });
      if (!current() || aligned()) return;
      await new Promise<void>(resolve => {
        const wake = () => { clearTimeout(timer); this.waiters.delete(wake); resolve(); };
        const timer = setTimeout(wake, 1500); this.waiters.add(wake);
      });
      if (!current() || aligned()) return;
    }
    if (current()) { this.failureMessage = 'Spotify did not reach the requested listening position. Rejoin Listen Along to retry.'; throw new Error(this.failureMessage); }
  }
  private async call(command: Record<string, unknown>) {
    try {
      return await this.invoke<State>('spotify_bridge', { request: { action: 'native', command } });
    } catch (error) {
      this.failureMessage = String(error);
      this.report({ connected: false, outcome: 'error', message: this.failureMessage });
      throw error;
    }
  }
  private stopPolling() { this.active = false; if (this.timer) clearTimeout(this.timer); this.timer = undefined; }
  stop() { this.generation++; this.stopPolling(); this.controller.disconnect(); for (const wake of [...this.waiters]) wake(); }
  publish(frame: ListeningFrame) {
    if (!frame.snapshot) { this.stop(); return; }
    if (frame.snapshot.session === this.blockedSession) return;
    const key = JSON.stringify([frame.snapshot.session, frame.snapshot.uri, frame.snapshot.startMs, frame.snapshot.paused]);
    if (key !== this.targetKey) { this.generation++; this.targetKey = key; for (const wake of [...this.waiters]) wake(); }
    if (this.session !== frame.snapshot.session) { this.failureMessage = ''; this.outcome = 'idle'; }
    this.session = frame.snapshot.session;
    this.targetStartMs = frame.snapshot.startMs;
    this.durationMs = frame.snapshot.durationMs;
    if (!this.active) { this.active = true; this.schedule(); }
    this.controller.update(frame);
  }
  private schedule() { if (this.active && !this.timer) this.timer = setTimeout(() => { this.timer = undefined; void this.poll(); }, 1000); }
  private async poll() {
    if (!this.active || this.reading) return;
    this.reading = true;
    const generation = this.generation, sequence = ++this.requestSequence;
    try {
      const before = this.state;
      const state = await this.call({ action: 'state' });
      if (generation !== this.generation || !this.active || sequence < this.acceptedSequence) return;
      this.acceptedSequence = sequence;
      this.accept(state);
      this.controller.observe(state.uri !== before.uri ? 'song' : state.playing !== before.playing ? 'pause' : 'progress');
    } catch {
      if (generation === this.generation) { this.blockedSession = this.session; this.stop(); }
    } finally { this.reading = false; this.schedule(); }
  }
  async status() {
    await this.call({ action: 'state' });
    this.report({ connected: true, outcome: this.outcome, message: `Native Spotify control is available. Last result: ${this.outcome}.${this.active ? ` Timing difference: ${Math.round((this.position() - Math.min(Date.now() - this.targetStartMs, this.durationMs || 3_600_000)) / 1000)} seconds.` : ''}` });
  }
}
