import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeKeyframes,keyframeExpression } from '../animation.mjs';
import { extractWaveform } from '../waveform.mjs';
import { renderTimeline } from '../timeline-render.mjs';

test('keyframe schemas reject unsafe, excessive and unsorted expressions',()=>{
  assert.throws(()=>normalizeKeyframes({scale:[{time:1,value:2},{time:0,value:1}]}),/关键帧/);
  assert.throws(()=>normalizeKeyframes({scale:[{time:0,value:'eval(t)'}]}),/关键帧/);
  assert.throws(()=>normalizeKeyframes({volume:[{time:0,value:3}]}),/关键帧/);
  assert.throws(()=>normalizeKeyframes({opacity:Array.from({length:129},(_,time)=>({time,value:1}))}),/关键帧/);
  const clip={in:2,keyframes:normalizeKeyframes({ox:[{time:2,value:-.5},{time:3,value:.5}]})};
  assert.ok(keyframeExpression(clip,'ox','t',0).includes('(t+2)'));
});

test('real FFmpeg: bounded waveform envelopes preserve silence and animated exports change pixels and volume',{timeout:60000},async()=>{
  const folder=await mkdtemp(join(tmpdir(),'lite-editor-essentials-')),ffmpeg=process.env.FFMPEG_PATH||'ffmpeg';
  const run=async(file,args)=>{const r=spawnSync(file,args,{encoding:'utf8',windowsHide:true,timeout:25000});assert.equal(r.status,0,r.stderr||r.error?.message);};
  const raw=args=>{const r=spawnSync(ffmpeg,['-v','error',...args],{windowsHide:true,timeout:15000,maxBuffer:4*1024*1024});assert.equal(r.status,0,String(r.stderr));return r.stdout;};
  try{
    const sound=join(folder,'wave.wav');
    await run(ffmpeg,['-v','error','-y','-f','lavfi','-i','anullsrc=r=8000:cl=mono:d=0.5','-f','lavfi','-i','sine=frequency=440:sample_rate=8000:duration=0.5','-filter_complex','[0:a][1:a]concat=n=2:v=0:a=1','-c:a','pcm_s16le',sound]);
    const envelope=await extractWaveform(ffmpeg,{path:sound,duration:1,hasAudio:true},128);
    assert.equal(envelope.peaks.length,128);assert.ok(envelope.peaks.slice(0,60).every(p=>p===0));assert.ok(envelope.peaks.slice(70).some(p=>p>.05));
    assert.equal((await extractWaveform(ffmpeg,{hasAudio:false,duration:1})).peaks.length,0);
    const source=join(folder,'source.mp4'),output=join(folder,'animated.mp4');
    await run(ffmpeg,['-v','error','-y','-f','lavfi','-i','color=c=red:s=160x90:r=24:d=1.25','-f','lavfi','-i','sine=frequency=440:duration=1.25','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-shortest',source]);
    const keyframes=normalizeKeyframes({scale:[{time:0,value:.3},{time:1,value:.6}],ox:[{time:0,value:-.25},{time:1,value:.25}],opacity:[{time:0,value:.1},{time:1,value:1}],volume:[{time:0,value:1},{time:1,value:0}]});
    await renderTimeline({clips:[{kind:'video',path:source,in:0,out:1.25,start:0,layer:1,hasAudio:true,keyframes}],texts:[],width:160,height:90,fps:24,preset:'ultrafast',crf:16,outPath:output,duration:1.25,progress:0},{ffmpeg,run,overlays:new Map(),work:folder});
    const pixel=(time,x)=>[...raw(['-ss',String(time),'-i',output,'-frames:v','1','-vf',`crop=2:2:${x}:44,scale=1:1,format=rgb24`,'-f','rawvideo','pipe:1'])];
    const early=pixel(.125,40),late=pixel(.875,120),vacated=pixel(.875,30);
    assert.ok(early[0]>15&&early[0]<100,'opacity is low at the first keyframe interval');
    assert.ok(late[0]>170&&late[2]<30,'scale, movement and opacity reach the right side');
    assert.ok(vacated[0]<15,'the source moved away from its original position');
    const rms=time=>{const pcm=raw(['-ss',String(time),'-i',output,'-t','0.05','-vn','-ac','1','-ar','8000','-f','f32le','pipe:1']);let sum=0;for(let i=0;i+3<pcm.length;i+=4)sum+=pcm.readFloatLE(i)**2;return Math.sqrt(sum/(pcm.length/4));};
    assert.ok(rms(.1)>rms(.9)*3,'volume automation fades the actual exported samples');
  }finally{await rm(folder,{recursive:true,force:true});}
});
