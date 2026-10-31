import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import vm from 'node:vm';
const bundle=await build({entryPoints:['native-ui/spotify-local.ts'],bundle:true,write:false,format:'cjs',platform:'browser'});
function fixture(enabled){
  let sync=null,changes, presenceChanged;const events={},timers=new Map(),calls=[];let timerId=0;
  let activities=[{sync_id:'0123456789abcdefghijkl',metadata:{type:'track'},timestamps:{start:10000,end:210000}}];
  const store={getSyncingWith:()=>sync,getActiveSocketAndDevice:()=>({socket:{isPremium:true,accessToken:'secret'},device:{id:'private-device'}}),addChangeListener:fn=>changes=fn};
  const dispatcher={subscribe:(name,fn)=>events[name]=fn,dispatch:()=>{sync=null;changes();}};
  const window={Vencord:{Webpack:{Common:{SpotifyStore:store,FluxDispatcher:dispatcher,PresenceStore:{getActivities:()=>activities,addChangeListener:fn=>presenceChanged=fn}}}}};
  const module={exports:{}};
  vm.runInNewContext(bundle.outputFiles[0].text,{module,window,setTimeout:fn=>{timers.set(++timerId,fn);return timerId;},clearTimeout:id=>timers.delete(id)});
  module.exports.installSpotifyLocal(async(command,args)=>{calls.push([command,args]);return{connected:true,outcome:'idle',message:'connected'};},enabled);
  return{api:module.exports,calls,join(){sync={userId:'private-friend',trackId:'0123456789abcdefghijkl',startTime:10000};events.ACTIVITY_SYNC();changes();},stop(){sync=null;changes();},pauseHost(){activities=[];presenceChanged();},flush(){const pending=[...timers.values()];timers.clear();pending.forEach(fn=>fn());},timers};
}
test('the feed stays idle by default and sends only the selected track timing when enabled',()=>{
  const off=fixture(false);off.join();off.api.spotifyPlaybackCompleted();off.flush();assert.equal(off.calls.length,0);
  const on=fixture(true);assert.deepEqual(on.calls.slice(0,2).map(call=>call[1].request.action),['stop','status']);on.join();on.api.spotifyPlaybackCompleted();on.flush();
  const request=on.calls.at(-1);assert.equal(request[0],'spotify_bridge');assert.equal(request[1].request.action,'publish');
  const snapshot=request[1].request.snapshot;assert.equal(snapshot.uri,'spotify:track:0123456789abcdefghijkl');assert.equal(snapshot.startMs,10000);assert.equal(snapshot.durationMs,200000);
  assert.doesNotMatch(JSON.stringify(on.calls),/secret|private-friend|private-device/);
  on.pauseHost();on.flush();assert.equal(on.calls.at(-1)[1].request.snapshot.paused,true);
  on.stop();assert.equal(on.calls.at(-1)[1].request.action,'stop');assert.equal(on.timers.size,0);
});
test('another remote response reapplies the current target after it blanks the local player',()=>{
  const f=fixture(true);f.join();f.api.spotifyPlaybackCompleted();f.flush();const first=f.calls.at(-1)[1].request.snapshot;
  f.api.spotifyPlaybackCompleted();f.flush();assert.equal(f.calls.at(-1)[1].request.action,'publish');assert.deepEqual(f.calls.at(-1)[1].request.snapshot,first);
  assert.equal(f.calls.filter(call=>call[1].request.action==='publish').length,2);assert.equal(f.calls.at(-1)[1].request.restart,true);
});
