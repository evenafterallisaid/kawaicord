import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import vm from 'node:vm';
const bundle = await build({entryPoints:['native-ui/spotify-companion-controller.ts'],bundle:true,write:false,format:'cjs',platform:'browser'});
const module = {exports:{}};
vm.runInNewContext(bundle.outputFiles[0].text,{module,setTimeout,clearTimeout});
const {LocalListeningController}=module.exports;
const a='spotify:track:0123456789abcdefghijkl', b='spotify:track:1123456789abcdefghijkl', c='spotify:track:2123456789abcdefghijkl';
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(){
  const calls=[],reports=[];let now=100000;
  const state={uri:a,playing:true,position:5000,duration:200000};
  const player={uri:()=>state.uri,playing:()=>state.playing,position:()=>state.position,duration:()=>state.duration,
    play:async uri=>{calls.push(['play',uri]);state.uri=uri;state.playing=true;},seek:async position=>{calls.push(['seek',position]);state.position=position;},resume:async()=>{calls.push(['resume']);state.playing=true;},pause:async()=>{calls.push(['pause']);state.playing=false;}};
  const controller=new LocalListeningController(player,(revision,result)=>reports.push([revision,result]),()=>now);
  const frame=(revision,uri,startMs=80000,session='one')=>({revision,snapshot:{session,uri,startMs,durationMs:200000}});
  return {calls,reports,state,player,controller,frame,advance:ms=>{now+=ms;}};
}
test('local playback starts the target and follows later track changes at their current position',async()=>{
  const f=fixture();f.controller.update(f.frame(1,b));await flush();
  assert.deepEqual(f.calls,[['play',b],['seek',20000]]);assert.deepEqual(f.reports,[[1,'playing']]);
  f.advance(10000);f.controller.update(f.frame(2,c,105000));await flush();
  assert.deepEqual(f.calls.slice(-2),[['play',c],['seek',5000]]);
  f.controller.update(f.frame(2,c,105000));await flush();assert.equal(f.calls.length,4);
});
test('manual pause releases ownership until a new explicit listening session',async()=>{
  const f=fixture();f.controller.update(f.frame(1,b));await flush();f.advance(1500);f.state.playing=false;f.controller.observe('pause');
  assert.deepEqual(f.reports.at(-1),[1,'manual-stop']);
  f.controller.update(f.frame(2,c));await flush();assert.equal(f.calls.length,2);
  f.controller.update(f.frame(3,c,100000,'two'));await flush();assert.deepEqual(f.calls.at(-2),['play',c]);
});
test('manual song changes are not overwritten by drift correction',async()=>{
  const f=fixture();f.controller.update(f.frame(1,b));await flush();f.advance(2000);f.state.uri=a;f.controller.observe('song');
  f.advance(20000);f.controller.observe('progress');assert.deepEqual(f.reports.at(-1),[1,'manual-stop']);assert.equal(f.calls.length,2);
});
test('late completion of an old track cannot seek over a new target',async()=>{
  const f=fixture();let release;const old=f.player.play;
  f.player.play=async uri=>{if(uri===b)await new Promise(resolve=>{release=resolve;});await old(uri);};
  f.controller.update(f.frame(1,b));f.controller.update(f.frame(2,c,90000));release();await flush();
  assert.deepEqual(f.calls,[['play',b],['play',c],['seek',10000]]);assert.deepEqual(f.reports,[[2,'playing']]);
});
test('disconnection cancels pending seeks and a restarted server can use fresh revisions',async()=>{
  const f=fixture();let release;const old=f.player.play;f.player.play=async uri=>{await new Promise(resolve=>{release=resolve;});await old(uri);};
  f.controller.update(f.frame(8,b));f.controller.disconnect();release();await flush();assert.deepEqual(f.calls,[['play',b]]);
  f.player.play=old;f.controller.update(f.frame(1,c));await flush();assert.deepEqual(f.calls.at(-1),['seek',20000]);
});
test('drift correction is bounded and seeks stay inside the loaded track',async()=>{
  const f=fixture();f.controller.update(f.frame(1,b));await flush();f.advance(12000);f.state.position=20000;f.controller.observe('progress');await flush();
  assert.deepEqual(f.calls.at(-1),['seek',32000]);const count=f.calls.length;
  f.advance(1000);f.state.position=1;f.controller.observe('progress');assert.equal(f.calls.length,count);
  f.advance(300000);f.controller.update(f.frame(2,b));await flush();assert.deepEqual(f.calls.at(-1),['seek',199750]);
});
test('failed local playback reports failure without repeated playback attempts',async()=>{
  const f=fixture();f.player.play=async()=>{throw new Error('private failure detail');};f.controller.update(f.frame(1,b));await flush();
  assert.deepEqual(f.reports,[[1,'error']]);f.controller.update(f.frame(2,b));await flush();assert.equal(f.reports.length,1);
});
test('host pause and resume preserve the target position without being mistaken for a manual stop',async()=>{
  const f=fixture();f.controller.update(f.frame(1,b));await flush();
  const paused=f.frame(2,b);paused.snapshot.paused=true;f.controller.update(paused);await flush();f.controller.observe('pause');
  assert.deepEqual(f.calls.at(-1),['pause']);assert.deepEqual(f.reports.at(-1),[2,'paused']);
  f.advance(5000);f.controller.update(f.frame(3,b,85000));await flush();assert.deepEqual(f.calls.slice(-2),[['seek',20000],['resume']]);
  f.state.playing=false;f.controller.observe('pause');assert.deepEqual(f.reports.at(-1),[3,'manual-stop']);
});
test('an explicit repair restarts a broken context even if Spotify still reports the same track uri',async()=>{
  const f=fixture();f.controller.update(f.frame(1,b));await flush();
  const repair=f.frame(2,b);repair.restart=true;f.controller.update(repair);await flush();
  assert.deepEqual(f.calls.slice(-2),[['play',b],['seek',20000]]);
  f.state.playing=false;f.controller.observe('pause');
  const blocked=f.frame(3,b);blocked.restart=true;f.controller.update(blocked);await flush();assert.equal(f.calls.length,4);
});
test('remote playback can blank the player or change to its expected track without being treated as a manual override',async()=>{
  const f=fixture();f.controller.update(f.frame(1,b));await flush();
  const transition=f.frame(2,c);transition.pending=true;f.controller.update(transition);
  f.state.uri=undefined;f.state.playing=false;f.controller.observe('song');f.controller.observe('pause');
  assert.deepEqual(f.reports,[[1,'playing']]);
  f.state.uri=c;f.state.playing=true;f.controller.observe('song');
  const finished=f.frame(3,c);finished.restart=true;f.controller.update(finished);await flush();assert.deepEqual(f.reports.at(-1),[3,'playing']);
  const next=f.frame(4,b);next.pending=true;f.controller.update(next);f.state.uri=a;f.controller.observe('song');assert.deepEqual(f.reports.at(-1),[4,'manual-stop']);
});
