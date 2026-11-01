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
  constructor(private invoke: Invoke, private report: (status: SpotifyBridgeStatus) => void) {
    const change = async (command: Record<string, unknown>) => {
      const generation = this.generation, sequence = ++this.requestSequence;
      const state = await this.call(command);
      if (generation === this.generation && sequence >= this.acceptedSequence) { this.acceptedSequence = sequence; this.state = state; }
    };
    this.controller = new LocalListeningController({
      uri: () => this.state.uri, playing: () => this.state.playing, position: () => this.state.positionMs, duration: () => 0,
      play: uri => change({ action: 'play', uri }), seek: positionMs => change({ action: 'seek', positionMs: Math.round(positionMs), uri: this.state.uri }),
      resume: () => change({ action: 'resume', uri: this.state.uri }), pause: () => change({ action: 'pause', uri: this.state.uri })
    }, (_, outcome) => {
      this.outcome = outcome;
      this.report({ connected: outcome !== 'error', outcome, message: outcome === 'error' ? this.failureMessage || 'Native Spotify playback failed. Check the connection report, then retry Listen Along.' : 'Using native Spotify playback.' });
      if (outcome === 'error' || outcome === 'manual-stop') { this.blockedSession = this.session; this.stopPolling(); }
    });
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
  stop() { this.generation++; this.stopPolling(); this.controller.disconnect(); }
  publish(frame: ListeningFrame) {
    if (!frame.snapshot) { this.stop(); return; }
    if (frame.snapshot.session === this.blockedSession) return;
    this.session = frame.snapshot.session;
    this.controller.update(frame);
    if (!this.active) { this.active = true; this.schedule(); }
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
      this.state = state;
      this.controller.observe(state.uri !== before.uri ? 'song' : state.playing !== before.playing ? 'pause' : 'progress');
    } catch {
      if (generation === this.generation) { this.blockedSession = this.session; this.stop(); }
    } finally { this.reading = false; this.schedule(); }
  }
  async status() {
    await this.call({ action: 'state' });
    this.report({ connected: true, outcome: this.outcome, message: 'Native Spotify control is available. Spicetify is not required for this mode.' });
  }
}
