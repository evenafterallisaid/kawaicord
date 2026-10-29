export interface MediaReport {
  ok: boolean;
  userAgent: string;
  peerConnection: boolean;
  encodedTransforms: boolean;
  audioContext?: string;
  receivedBytes?: number;
  error?: string;
}

export async function testAudioTransport(): Promise<MediaReport> {
  const report: MediaReport = {
    ok: false,
    userAgent: navigator.userAgent,
    peerConnection: typeof RTCPeerConnection === 'function',
    encodedTransforms: typeof (window as any).RTCRtpScriptTransform === 'function'
      || typeof (window as any).RTCRtpSender?.prototype.createEncodedStreams === 'function'
  };
  let context: AudioContext | undefined;
  let sender: RTCPeerConnection | undefined;
  let receiver: RTCPeerConnection | undefined;
  let oscillator: OscillatorNode | undefined;
  let source: MediaStreamAudioSourceNode | undefined;
  let stream: MediaStream | undefined;
  let timeout: number | undefined;
  try {
    if (!report.peerConnection) throw new Error('WebRTC is unavailable in this webview');
    context = new AudioContext();
    report.audioContext = context.state;
    await Promise.race([
      context.resume(),
      new Promise((_, reject) => {
        timeout = window.setTimeout(() => reject(new Error('Audio playback is blocked')), 4000);
      })
    ]);
    clearTimeout(timeout);
    report.audioContext = context.state;
    const destination = context.createMediaStreamDestination();
    stream = destination.stream;
    oscillator = context.createOscillator();
    oscillator.connect(destination);
    oscillator.start();
    sender = new RTCPeerConnection({ iceServers: [] });
    receiver = new RTCPeerConnection({ iceServers: [] });
    const a = sender, b = receiver;
    const candidatesA: RTCIceCandidate[] = [], candidatesB: RTCIceCandidate[] = [];
    a.onicecandidate = event => {
      if (!event.candidate) return;
      if (b.remoteDescription) void b.addIceCandidate(event.candidate).catch(() => {});
      else candidatesB.push(event.candidate);
    };
    b.onicecandidate = event => {
      if (!event.candidate) return;
      if (a.remoteDescription) void a.addIceCandidate(event.candidate).catch(() => {});
      else candidatesA.push(event.candidate);
    };
    const analyser = context.createAnalyser();
    b.ontrack = event => {
      source = context!.createMediaStreamSource(event.streams[0]);
      source.connect(analyser);
    };
    for (const track of stream.getTracks()) a.addTrack(track, stream);
    await a.setLocalDescription(await a.createOffer());
    await b.setRemoteDescription(a.localDescription!);
    for (const candidate of candidatesB) await b.addIceCandidate(candidate);
    await b.setLocalDescription(await b.createAnswer());
    await a.setRemoteDescription(b.localDescription!);
    for (const candidate of candidatesA) await a.addIceCandidate(candidate);
    const samples = new Float32Array(analyser.fftSize);
    const deadline = performance.now() + 15000;
    while (performance.now() < deadline) {
      const stats = await b.getStats();
      let bytes = 0;
      stats.forEach(value => {
        if (value.type === 'inbound-rtp' && (value.kind === 'audio' || value.mediaType === 'audio')) bytes += value.bytesReceived ?? 0;
      });
      analyser.getFloatTimeDomainData(samples);
      if (bytes > 0 && samples.some(value => Math.abs(value) > 0.001)) {
        report.ok = true;
        report.receivedBytes = bytes;
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!report.ok) throw new Error(`Audio transport failed (${a.connectionState}/${b.connectionState})`);
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
  } finally {
    clearTimeout(timeout);
    source?.disconnect();
    oscillator?.disconnect();
    stream?.getTracks().forEach(track => track.stop());
    sender?.close();
    receiver?.close();
    if (context && context.state !== 'closed') await context.close();
  }
  return report;
}
(window as any).__kawaicordTestAudio = testAudioTransport;
