import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import vm from 'node:vm';
const bundle = await build({entryPoints:['native-ui/spotify-native.ts'],bundle:true,write:false,format:'cjs',platform:'browser'});
const a='spotify:track:0123456789abcdefghijkl', b='spotify:track:1123456789abcdefghijkl';
const tick=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
function fixture({ignoredSeeks=0}={}){
  const timers=new Map(), calls=[], reports=[];let id=0;
  let state={uri:'',playing:false,positionMs:0};
  const module={exports:{}};
  vm.runInNewContext(bundle.outputFiles[0].text,{module,setTimeout:fn=>{timers.set(++id,fn);return id;},clearTimeout:id=>timers.delete(id)});
  const player=new module.exports.NativeSpotifyPlayer(async(_,args)=>{
    const c=args.request.command;calls.push(c);
    if(c.action==='play') state={uri:c.uri,playing:true,positionMs:0};
    if(c.action==='seek'){if(ignoredSeeks>0)ignoredSeeks--;else state.positionMs=c.positionMs;}
    if(c.action==='pause')state.playing=false;
    if(c.action==='resume')state.playing=true;
    return {...state};
  },s=>reports.push(s));
  return{player,calls,reports,timers, state:()=>state,setState:s=>state={...s},async poll(){const jobs=[...timers.values()];timers.clear();jobs.forEach(fn=>fn());await tick();}};
}
const frame=(revision,uri=a,session='one')=>({revision,snapshot:{session,uri,startMs:Date.now()-20000,durationMs:200000}});
test('native playback follows target changes, seeks, and stops all polling on exit',async()=>{
  const f=fixture();assert.equal(f.calls.length,0);assert.equal(f.timers.size,0);
  f.player.publish(frame(1));await tick();assert.equal(f.state().uri,a);assert.ok(f.calls.some(c=>c.action==='seek'&&c.positionMs>=20000));assert.equal(f.reports.at(-1).outcome,'playing');
  f.player.publish(frame(2,b));await tick();assert.equal(f.state().uri,b);
  f.player.stop();assert.equal(f.timers.size,0);const count=f.calls.length;await f.poll();assert.equal(f.calls.length,count);
});
test('manual native pause blocks repair until a fresh explicit session',async()=>{
  const f=fixture();f.player.publish(frame(1));await tick();f.setState({...f.state(),playing:false});await f.poll();
  assert.equal(f.reports.at(-1).outcome,'manual-stop');assert.equal(f.timers.size,0);
  const count=f.calls.length;f.player.publish({...frame(2),restart:true});await tick();assert.equal(f.calls.length,count);assert.equal(f.timers.size,0);
  f.player.publish(frame(3,a,'two'));await tick();assert.equal(f.state().playing,true);assert.equal(f.reports.at(-1).outcome,'playing');f.player.stop();
});
test('native failure keeps the permission error and does not spin in the background',async()=>{
  const timers=new Map();let id=0;const reports=[];const module={exports:{}};
  vm.runInNewContext(bundle.outputFiles[0].text,{module,setTimeout:fn=>{timers.set(++id,fn);return id;},clearTimeout:id=>timers.delete(id)});
  const p=new module.exports.NativeSpotifyPlayer(async()=>{throw new Error('Automation permission denied');},s=>reports.push(s));
  p.publish(frame(1));await tick();assert.match(reports.at(-1).message,/permission denied/);assert.equal(timers.size,0);p.publish({...frame(2),restart:true});await tick();assert.equal(timers.size,0);
});

test('native seek verifies playback position and retries a seek ignored during loading',async()=>{
  const f=fixture({ignoredSeeks:1});f.player.publish(frame(1));await tick();
  assert.notEqual(f.reports.at(-1)?.outcome,'playing');await f.poll();
  assert.ok(f.calls.filter(c=>c.action==='seek').length>=2);assert.equal(f.reports.at(-1).outcome,'playing');assert.ok(f.state().positionMs>=20000);f.player.stop();
});
test('native track duration preserves a natural handover until the next presence update',async()=>{
  const f=fixture();f.player.publish(frame(1));await tick();f.setState({...f.state(),positionMs:199000});await f.poll();
  f.setState({uri:b,playing:true,positionMs:0});await f.poll();assert.notEqual(f.reports.at(-1)?.outcome,'manual-stop');
  f.player.publish(frame(2,b));await tick();assert.equal(f.reports.at(-1).outcome,'playing');f.player.stop();
});
test('a player that never seeks reports failure after bounded retries',async()=>{
  const f=fixture({ignoredSeeks:100});f.player.publish(frame(1));await tick();
  for(let i=0;i<4;i++)await f.poll();
  assert.equal(f.calls.filter(c=>c.action==='seek').length,3);assert.equal(f.reports.at(-1).outcome,'error');assert.equal(f.timers.size,0);
});

test('leaving while a native seek is pending cancels retries and all waiting timers',async()=>{
  const f=fixture({ignoredSeeks:100});f.player.publish(frame(1));await tick();assert.ok(f.timers.size>0);
  f.player.stop();await tick();assert.equal(f.timers.size,0);const count=f.calls.length;await f.poll();assert.equal(f.calls.length,count);
});
