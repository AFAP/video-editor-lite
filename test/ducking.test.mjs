import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {normalizeDuckingConfig,normalizeDuckingPoints,buildDuckingEnvelope,clipDuckingEnvelope,duckingGain,duckingExpression} from '../audio-ducking.mjs';
import {renderTimeline} from '../timeline-render.mjs';

test('ducking schemas reject unsafe curves and configs, and smooth merged pauses without pumping',()=>{
  const config=normalizeDuckingConfig({voiceTrackIds:['v1','a1','a1'],level:.2,attack:.1,release:.3,hold:.2});assert.deepEqual(config.voiceTrackIds,['v1','a1']);
  for(const voiceTrackIds of [[],['t1'],['va1'],['a1;eval(t)']])assert.throws(()=>normalizeDuckingConfig({voiceTrackIds}),/轨道/);
  for(const value of [{level:2},{attack:0},{threshold:0},{release:'1'}])assert.throws(()=>normalizeDuckingConfig({voiceTrackIds:['a1'],...value}),/参数/);
  for(const points of [[{time:0,value:2}],[{time:1,value:1},{time:0,value:0}],[{time:0,value:'eval(t)'}]])assert.throws(()=>normalizeDuckingPoints(points),/曲线/);
  const {points,intervals}=buildDuckingEnvelope([[1,2],[2.3,3],[6,7]],config);assert.equal(intervals.length,2);assert.equal(duckingGain(points,2.15),.2);assert.ok(Math.abs(duckingGain(points,.95)-.6)<1e-9);assert.equal(duckingGain(points,4),1);
  const clipped=clipDuckingEnvelope(points,{start:1.5,in:10,out:12});assert.equal(clipped[0].time,10);assert.equal(clipped[0].value,.2);assert.equal(clipped.at(-1).time,12);assert.deepEqual(clipDuckingEnvelope(points,{start:20,in:0,out:2}),[]);
});

test('long ducking envelopes stay bounded and expression nesting is logarithmic',()=>{
  const config=normalizeDuckingConfig({voiceTrackIds:['a1'],attack:.01,release:.01,hold:0});
  const envelope=buildDuckingEnvelope(Array.from({length:1200},(_,i)=>[i*2,i*2+.5]),config);assert.equal(envelope.simplified,200);assert.ok(envelope.points.length<=4000);normalizeDuckingPoints(envelope.points);
  const expression=duckingExpression(envelope.points);let depth=0,max=0;for(const char of expression){if(char==='(')max=Math.max(max,++depth);else if(char===')')depth--;}
  assert.equal(depth,0);assert.ok(max<30,'FFmpeg expression depth remains bounded on long projects');
});

test('real FFmpeg ducking multiplies original volume automation, preserves trim offsets and recovers after speech',{timeout:60000},async()=>{
  const folder=await mkdtemp(join(tmpdir(),'lite-ducking-')),ffmpeg=process.env.FFMPEG_PATH||'ffmpeg';
  const run=async(file,args)=>{const r=spawnSync(file,args,{windowsHide:true,encoding:'utf8',timeout:25000,maxBuffer:4*1024*1024});assert.equal(r.status,0,r.stderr||r.error?.message);};
  const rms=(file,time)=>{const r=spawnSync(ffmpeg,['-v','error','-ss',String(time),'-i',file,'-t','0.06','-vn','-ac','1','-ar','16000','-f','f32le','pipe:1'],{windowsHide:true,timeout:10000});assert.equal(r.status,0,String(r.stderr));let sum=0;for(let n=0;n+3<r.stdout.length;n+=4)sum+=r.stdout.readFloatLE(n)**2;return Math.sqrt(sum/(r.stdout.length/4));};
  try{
    const source=join(folder,'music.wav');await run(ffmpeg,['-v','error','-y','-f','lavfi','-i','sine=frequency=1000:duration=8','-c:a','pcm_s16le',source]);
    const config=normalizeDuckingConfig({voiceTrackIds:['a1'],level:.2,attack:.1,release:.2,hold:.1});
    const envelope=buildDuckingEnvelope([[1,2]],config).points;
    const clip={kind:'audio',path:source,in:2,out:6,start:0,layer:0,hasAudio:true,fadeIn:.2,fadeOut:.2,keyframes:{volume:[{time:2,value:.5},{time:6,value:1}]}};
    const baseline=join(folder,'baseline.mp4'),ducked=join(folder,'ducked.mp4');
    for(const [outPath,ducking]of [[baseline,[]],[ducked,clipDuckingEnvelope(envelope,clip)]])await renderTimeline({clips:[{...clip,ducking}],texts:[],width:64,height:36,fps:24,preset:'ultrafast',crf:25,duration:4,outPath,progress:0},{ffmpeg,run,overlays:new Map(),work:folder});
    for(const [time,expected]of [[.5,1],[1.4,.2],[2.7,1]]){const ratio=rms(ducked,time)/rms(baseline,time);assert.ok(Math.abs(ratio-expected)<.07,`gain at ${time}: ${ratio}, expected ${expected}`);}
    const many=normalizeDuckingPoints(Array.from({length:2000},(_,i)=>({time:i/1000,value:i%2?.2:1})));
    await renderTimeline({clips:[{...clip,in:0,out:2,keyframes:{},ducking:many}],texts:[],width:64,height:36,fps:24,preset:'ultrafast',crf:25,duration:2,outPath:join(folder,'long-envelope.mp4'),progress:0},{ffmpeg,run,overlays:new Map(),work:folder});
  }finally{await rm(folder,{recursive:true,force:true});}
});
