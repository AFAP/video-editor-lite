import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {renderTimeline} from '../timeline-render.mjs';

test('real FFmpeg removes green and black backgrounds while retaining transforms, fades and original alpha',{timeout:60000},async()=>{
  const folder=await mkdtemp(join(tmpdir(),'lite-color-key-')),ffmpeg=process.env.FFMPEG_PATH||'ffmpeg';
  const run=async(file,args)=>{const result=spawnSync(file,args,{windowsHide:true,encoding:'utf8',timeout:20000});assert.equal(result.status,0,result.stderr||result.error?.message);};
  const pixel=(file,x,y,time=.5)=>{
    const result=spawnSync(ffmpeg,['-v','error','-ss',String(time),'-i',file,'-frames:v','1','-vf',`crop=2:2:${x}:${y},scale=1:1,format=rgb24`,'-f','rawvideo','pipe:1'],{windowsHide:true,timeout:15000});
    assert.equal(result.status,0,String(result.stderr));return [...result.stdout];
  };
  try{
    const base=join(folder,'blue.png');
    await run(ffmpeg,['-v','error','-y','-f','lavfi','-i','color=c=blue:s=160x96','-frames:v','1',base]);
    for(const [mode,color]of [['green','0x00ff00'],['black','black']]){
      const foreground=join(folder,mode+'.mp4'),outPath=join(folder,mode+'-keyed.mp4');
      await run(ffmpeg,['-v','error','-y','-f','lavfi','-i',`color=c=${color}:s=160x96:r=24:d=1.5`,'-vf','drawbox=x=16:y=12:w=48:h=24:color=red:t=fill','-c:v','libx264','-crf','10','-pix_fmt','yuv420p',foreground]);
      await renderTimeline({clips:[{kind:'image',path:base,in:0,out:1.5,start:0,layer:0},{kind:'video',path:foreground,in:0,out:1.5,start:0,layer:1,scale:.75,ox:.05,opacity:.5,colorKey:{mode},transitionIn:{type:'fade',duration:.2}}],texts:[],width:160,height:96,fps:24,preset:'ultrafast',crf:10,outPath,duration:1.5,progress:0},{ffmpeg,run,overlays:new Map(),work:folder});
      const background=pixel(outPath,130,74),subject=pixel(outPath,52,28),early=pixel(outPath,52,28,.0833);
      assert.ok(background[2]>230&&background[0]<15&&background[1]<15,mode+' background reveals lower blue track: '+background);
      assert.ok(subject[0]>105&&subject[0]<150&&subject[2]>105&&subject[2]<150,'transformed subject keeps opacity: '+subject);
      assert.ok(early[0]<subject[0]*.7,'entrance fade still multiplies keyed alpha');
    }
    const raw=Buffer.alloc(160*96*4);
    for(let y=0;y<96;y++)for(let x=0;x<160;x++){
      const i=(y*160+x)*4;raw.set(x>=16&&x<64&&y>=12&&y<36?[255,0,0,128]:x>=100&&x<116&&y>=16&&y<32?[0,180,0,255]:[0,255,0,0],i);
    }
    const rawPath=join(folder,'alpha.rgba'),image=join(folder,'alpha.png'),outPath=join(folder,'alpha-keyed.mp4');await writeFile(rawPath,raw);
    await run(ffmpeg,['-v','error','-y','-f','rawvideo','-pix_fmt','rgba','-s','160x96','-i',rawPath,'-frames:v','1',image]);
    await renderTimeline({clips:[{kind:'image',path:base,in:0,out:1,start:0,layer:0},{kind:'image',path:image,in:0,out:1,start:0,layer:1,colorKey:{mode:'green',similarity:.1,blend:.2}}],texts:[],width:160,height:96,fps:24,preset:'ultrafast',crf:10,outPath,duration:1,progress:0},{ffmpeg,run,overlays:new Map(),work:folder});
    const alpha=pixel(outPath,30,22),soft=pixel(outPath,106,22);
    assert.ok(alpha[0]>110&&alpha[0]<145&&alpha[2]>110&&alpha[2]<145,'original half-transparent foreground is preserved: '+alpha);
    assert.ok(soft[1]>45&&soft[1]<80&&soft[2]>145&&soft[2]<190,'soft edge has fractional alpha: '+soft);
  }finally{await rm(folder,{recursive:true,force:true,maxRetries:3,retryDelay:100});}
});
