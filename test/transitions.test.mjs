import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderTimeline } from '../timeline-render.mjs';

test('FFmpeg transitions: fade, wipes and slides retain correct timing and directions',{timeout:60000},async()=>{
  const folder=await mkdtemp(join(tmpdir(),'lightcut-transition-')),ffmpeg=process.env.FFMPEG_PATH||'ffmpeg';
  const run=async(file,args)=>{const result=spawnSync(file,args,{encoding:'utf8',windowsHide:true,timeout:15000});assert.equal(result.status,0,result.stderr||result.error?.message);};
  try{
    for(const color of ['red','blue'])await run(ffmpeg,['-v','error','-y','-f','lavfi','-i',`color=c=${color}:s=160x90`,'-frames:v','1',join(folder,color+'.png')]);
    const sample=(file,time,x=80)=>{const result=spawnSync(ffmpeg,['-v','error','-ss',String(time),'-i',file,'-frames:v','1','-vf',`crop=2:2:${x}:44,scale=1:1,format=rgb24`,'-f','rawvideo','pipe:1'],{windowsHide:true,timeout:10000});assert.equal(result.status,0,String(result.stderr));return [...result.stdout];};
    for(const type of ['fade','wipeleft','wiperight','slideleft','slideright']){
      const output=join(folder,type+'.mp4'),job={clips:[
        {path:join(folder,'red.png'),kind:'image',in:0,out:2,start:0,layer:1,opacity:1},
        {path:join(folder,'blue.png'),kind:'image',in:0,out:2,start:1.5,layer:1,opacity:1,transitionIn:{type,duration:.5},transitionOut:{type:'fade',duration:.5}},
      ],texts:[],duration:3.5,width:160,height:90,fps:24,preset:'ultrafast',crf:18,outPath:output,progress:0};
      await renderTimeline(job,{ffmpeg,run,overlays:new Map(),work:folder});
      const before=sample(output,1),after=sample(output,2.3),ending=sample(output,3.4);
      assert.ok(before[0]>200&&before[2]<30,type+' before');assert.ok(after[2]>200&&after[0]<30,type+' after');assert.ok(ending[2]<150,type+' fade-out');
      if(type==='fade'){const middle=sample(output,1.75);assert.ok(middle[0]>50&&middle[2]>50,'cross dissolve should contain both colors');}
      else{
        const left=sample(output,1.75,20),right=sample(output,1.75,138);
        const leftRevealed=type==='wipeleft'||type==='slideright';
        assert.ok((leftRevealed?left:right)[2]>170,type+' reveal direction');assert.ok((leftRevealed?right:left)[0]>170,type+' remaining previous frame');
      }
    }
  }finally{await rm(folder,{recursive:true,force:true});}
});
