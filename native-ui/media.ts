export interface MediaReport { ok: boolean; userAgent: string; peerConnection: boolean; encodedTransforms: boolean; audioContext?: string; receivedBytes?: number; error?: string }
export async function testAudioTransport(): Promise<MediaReport> {
  const report: MediaReport = { ok: false, userAgent: navigator.userAgent, peerConnection: typeof RTCPeerConnection === 'function', encodedTransforms: typeof (window as any).RTCRtpScriptTransform === 'function' || typeof (window as any).RTCRtpSender?.prototype.createEncodedStreams === 'function' };
  let context: AudioContext | undefined; let sender: RTCPeerConnection | undefined; let receiver: RTCPeerConnection | undefined; let oscillator: OscillatorNode | undefined;
  let timeout: number | undefined;
  try {
    if (!report.peerConnection) throw new Error('WebRTC is unavailable in this webview');
    context = new AudioContext(); report.audioContext = context.state;
    await Promise.race([context.resume(), new Promise((_, reject) => { timeout=window.setTimeout(()=>reject(new Error('Audio playback is blocked')),4000); })]);
    clearTimeout(timeout); report.audioContext = context.state;
    const destination = context.createMediaStreamDestination(); oscillator = context.createOscillator(); oscillator.connect(destination); oscillator.start();
    sender = new RTCPeerConnection({ iceServers: [] }); receiver = new RTCPeerConnection({ iceServers: [] });
    const a=sender,b=receiver;
    a.onicecandidate=event=>{if(event.candidate)void b.addIceCandidate(event.candidate).catch(()=>{});};
    b.onicecandidate=event=>{if(event.candidate)void a.addIceCandidate(event.candidate).catch(()=>{});};
    let source: MediaStreamAudioSourceNode | undefined; const analyser=context.createAnalyser();
    b.ontrack=event=>{source=context!.createMediaStreamSource(event.streams[0]);source.connect(analyser);};
    for (const track of destination.stream.getTracks()) a.addTrack(track,destination.stream);
    await a.setLocalDescription(await a.createOffer()); await b.setRemoteDescription(a.localDescription!);
    await b.setLocalDescription(await b.createAnswer()); await a.setRemoteDescription(b.localDescription!);
    const deadline=performance.now()+15000;
    while(performance.now()<deadline){
      const stats=await b.getStats();let bytes=0;stats.forEach(value=>{if(value.type==='inbound-rtp'&&(value.kind==='audio'||value.mediaType==='audio'))bytes+=value.bytesReceived??0;});
      const samples=new Float32Array(analyser.fftSize);analyser.getFloatTimeDomainData(samples);
      if(bytes>0&&samples.some(value=>Math.abs(value)>0.001)){report.ok=true;report.receivedBytes=bytes;break;}
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    if(!report.ok)throw new Error(`Audio transport failed (${a.connectionState}/${b.connectionState})`);
    source?.disconnect();destination.stream.getTracks().forEach(track=>track.stop());
  } catch(error){report.error=error instanceof Error?error.message:String(error);}
  finally{clearTimeout(timeout);oscillator?.stop();sender?.close();receiver?.close();if(context)await context.close();}
  return report;
}
(window as any).__kawaicordTestAudio=testAudioTransport;
