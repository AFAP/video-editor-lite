import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {normalizeVisualTransform,visualGeometry} from '../visual-transform.mjs';
import {renderTimeline} from '../timeline-render.mjs';

test('visual transform schema bounds rotation, rejects unsafe values and keeps old projects compatible',()=>{
  assert.deepEqual(normalizeVisualTransform(),{fit:'contain',rotation:0,flipX:false,flipY:false});
  for(const value of ['90',NaN,Infinity,181])assert.throws(()=>normalizeVisualTransform({rotation:value}),/旋转/);
  assert.throws(()=>normalizeVisualTransform({fit:'eval(iw)'}),/适配/);assert.throws(()=>normalizeVisualTransform({flipX:'false'}),/翻转/);
  assert.equal(visualGeometry(80,40,80,80,{rotation:90}).dw,80);
  assert.equal(visualGeometry(80,40,80,80,{fit:'cover'}).dh,80);
});

test('real FFmpeg: fit, cover, rotate, flip and animated rotated images produce the expected pixels',{timeout:60000},async()=>{
  const folder=await mkdtemp(join(tmpdir(),'lite-visual-tools-')),ffmpeg=process.env.FFMPEG_PATH||'ffmpeg';
  const run=async(file,args)=>{const result=spawnSync(file,args,{windowsHide:true,encoding:'utf8',timeout:20000});assert.equal(result.status,0,result.stderr||result.error?.message);};
  const image=join(folder,'quadrants.ppm'),pixels=Buffer.alloc(80*40*3);
  for(let y=0;y<40;y++)for(let x=0;x<80;x++){const color=y<20?(x<40?[255,0,0]:[0,0,255]):(x<40?[0,255,0]:[255,255,0]);for(let n=0;n<3;n++)pixels[(y*80+x)*3+n]=color[n];}
  await writeFile(image,Buffer.concat([Buffer.from('P6\n80 40\n255\n'),pixels]));
  const frame=(file,time=.1)=>{const r=spawnSync(ffmpeg,['-v','error','-ss',String(time),'-i',file,'-frames:v','1','-pix_fmt','rgb24','-f','rawvideo','pipe:1'],{windowsHide:true,timeout:10000});assert.equal(r.status,0,String(r.stderr));assert.equal(r.stdout.length,80*80*3);return r.stdout;};
  const pixel=(data,x,y)=>[...data.subarray((y*80+x)*3,(y*80+x)*3+3)];
  const color=(data,x,y,expected)=>{const rgb=pixel(data,x,y);assert.ok(expected.every((v,n)=>Math.abs(v-rgb[n])<35),`at ${x},${y}: ${rgb} expected ${expected}`);};
  try{
    for(const [name,transform,checks]of [
      ['contain',{},[[10,5,[0,0,0]],[10,30,[255,0,0]]]],
      ['cover',{fit:'cover'},[[10,5,[255,0,0]],[65,65,[255,255,0]]]],
      ['rotate',{rotation:90},[[5,5,[0,0,0]],[25,10,[0,255,0]],[55,10,[255,0,0]]]],
      ['flipX',{flipX:true},[[10,30,[0,0,255]],[65,30,[255,0,0]]]],
      ['flipY',{flipY:true},[[10,30,[0,255,0]],[65,30,[255,255,0]]]],
      ['cover-angle',{fit:'cover',rotation:30},[[5,5,null],[74,5,null],[5,74,null],[74,74,null]]],
    ]){
      const output=join(folder,name+'.mp4');
      await renderTimeline({clips:[{kind:'image',path:image,in:0,out:.5,start:0,layer:1,...transform}],texts:[],width:80,height:80,fps:24,preset:'ultrafast',crf:10,outPath:output,duration:.5,progress:0},{ffmpeg,run,overlays:new Map(),work:folder});
      const data=frame(output);for(const [x,y,expected]of checks)if(expected)color(data,x,y,expected);else assert.ok(Math.max(...pixel(data,x,y))>130,'cover at an angle must cover the entire canvas');
    }
    const output=join(folder,'animated-rotated.mp4');
    await renderTimeline({clips:[{kind:'image',path:image,in:0,out:1,start:0,layer:1,rotation:90,keyframes:{scale:[{time:0,value:.5},{time:1,value:1}],ox:[{time:0,value:-.1},{time:1,value:.1}]}}],texts:[],width:80,height:80,fps:24,preset:'ultrafast',crf:10,outPath:output,duration:1,progress:0},{ffmpeg,run,overlays:new Map(),work:folder});
    const early=frame(output,.1),late=frame(output,.85);assert.ok(Math.max(...pixel(early,63,20))<25);assert.ok(Math.max(...pixel(late,63,20))>160,'rotated dimensions must follow animated scale');
    const blue=join(folder,'blue.png'),keyed=join(folder,'keyed.mp4'),composite=join(folder,'keyed-rotated.mp4');
    await run(ffmpeg,['-v','error','-y','-f','lavfi','-i','color=c=blue:s=80x80','-frames:v','1',blue]);
    await run(ffmpeg,['-v','error','-y','-f','lavfi','-i','color=c=green:s=80x40:r=24:d=0.5,drawbox=x=25:y=10:w=30:h=20:color=red:t=fill','-c:v','libx264','-pix_fmt','yuv420p',keyed]);
    await renderTimeline({clips:[{kind:'image',path:blue,in:0,out:.5,start:0,layer:0},{kind:'video',path:keyed,in:0,out:.5,start:0,layer:1,rotation:30,hasAlpha:false,colorKey:{mode:'custom',color:'#008000',similarity:.4,blend:.05}}],texts:[],width:80,height:80,fps:24,preset:'ultrafast',crf:10,outPath:composite,duration:.5,progress:0},{ffmpeg,run,overlays:new Map(),work:folder});
    const transparent=frame(composite);color(transparent,5,5,[0,0,255]);color(transparent,40,40,[255,0,0]);
  }finally{await rm(folder,{recursive:true,force:true});}
});
