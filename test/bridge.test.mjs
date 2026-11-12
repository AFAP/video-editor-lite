import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

test('real FFmpeg: legacy concat, multitrack composition, audio-only and text-only', {timeout:60000}, async () => {
  const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
  const ffprobe = process.env.FFPROBE_PATH || 'ffprobe';
  const temp = await mkdtemp(join(tmpdir(),'video-editor-test-'));
  const portServer = createServer();
  await new Promise(resolve => portServer.listen(0,'127.0.0.1',resolve));
  const port = portServer.address().port;
  await new Promise(resolve => portServer.close(resolve));
  const bridgePath = fileURLToPath(new URL('../ffmpeg-bridge.mjs',import.meta.url));
  const child = spawn(process.execPath,[bridgePath],{env:{...process.env,PORT:String(port)},windowsHide:true});
  let logs = ''; child.stdout.on('data',s => logs += s); child.stderr.on('data',s => logs += s);
  const base = 'http://127.0.0.1:' + port;
  function run(file,args) {
    const result = spawnSync(file,args,{windowsHide:true,encoding:'utf8',timeout:15000});
    assert.equal(result.status,0,result.stderr || result.error?.message);
    return result.stdout;
  }
  async function post(path,body,headers) {
    const res = await fetch(base+path,{method:'POST',body,headers});
    const data = await res.json(); assert.ok(data.ok,JSON.stringify(data)); return data;
  }
  try {
    let available = false;
    for (let n=0;n<60;n++) {
      try { const ping = await (await fetch(base+'/ping')).json(); if (ping.ok) {available=true;break;} } catch {}
      await delay(100);
    }
    assert.ok(available,logs);
    assert.equal((await(await fetch(base+'/ping')).json()).capabilities.colorKey,true);
    const page = await fetch(base+'/index.html');assert.equal(page.status,200);assert.match(page.headers.get('content-type'),/text\/html/);
    const pageHtml=await page.text();assert.equal(pageHtml,await readFile(new URL('../index.html',import.meta.url),'utf8'));assert.equal(await (await fetch(base+'/')).text(),pageHtml);
    assert.match(pageHtml,/rel="icon"[^>]*data:image\/svg\+xml/);
    for(const [path,type]of [['favicon.ico','image/x-icon'],['favicon.svg','image/svg+xml'],['favicon.png','image/png']]){const res=await fetch(base+'/'+path);assert.equal(res.status,200);assert.equal(res.headers.get('content-type'),type);assert.deepEqual(Buffer.from(await res.arrayBuffer()),await readFile(new URL('../'+path,import.meta.url)));}
    run(ffmpeg,['-v','error','-y','-f','lavfi','-i','testsrc2=size=320x180:rate=24:duration=2','-f','lavfi','-i','sine=frequency=440:duration=2','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-shortest',join(temp,'source.mp4')]);
    run(ffmpeg,['-v','error','-y','-f','lavfi','-i','color=c=0x294c3a:s=320x180','-frames:v','1',join(temp,'background.png')]);
    run(ffmpeg,['-v','error','-y','-f','lavfi','-i','color=c=white:s=320x180','-vf','format=rgba','-frames:v','1',join(temp,'overlay.png')]);
    const video = await post('/upload?name=sample.mp4',await readFile(join(temp,'source.mp4')));
    assert.equal(video.hasAlpha,false,'opaque video selects the native fast keying path');
    const waveform = await (await fetch(base+'/waveform/'+video.id)).json();
    assert.ok(waveform.ok);assert.equal(waveform.peaks.length,4096);assert.ok(waveform.peaks.some(value=>value>.01));
    const invalidAnimation = await fetch(base+'/render',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({timeline:true,clips:[{id:video.id,in:0,out:1,keyframes:{scale:[{time:0,value:'unsafe'}]}}]})});
    assert.equal(invalidAnimation.status,400);assert.match((await invalidAnimation.json()).error,/关键帧/);
    const invalidKey=await fetch(base+'/render',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({timeline:true,clips:[{id:video.id,in:0,out:1,colorKey:{color:"#00ff00';movie=private"}}]})});
    assert.equal(invalidKey.status,400);assert.match((await invalidKey.json()).error,/去背景颜色/);
    const image = await post('/overlay',await readFile(join(temp,'background.png')),{'content-type':'image/png'});
    const overlay = await post('/overlay',await readFile(join(temp,'overlay.png')),{'content-type':'image/png'});
    assert.ok(video.hasAudio); assert.equal(video.width,320);
    const render = await post('/render',JSON.stringify({
      clips:[
        {id:video.id,in:.25,out:.75,scale:.8,ox:.05,volume:.5,fadeIn:.1,fadeOut:.1},
        {id:image.id,kind:'image',in:2,out:2.5,volume:1},
        {id:video.id,in:1,out:1.5,volume:1,muted:true},
      ],
      texts:[{id:overlay.id,start:.75,end:1}],width:320,height:180,fps:24,quality:'low',name:'bridge-smoke',
    }),{'content-type':'application/json'});
    let job = render.job;
    for (let n=0;n<200 && !['done','error'].includes(job.status);n++) {
      await delay(150); job = (await (await fetch(base+'/job/'+job.id)).json()).job;
    }
    assert.equal(job.status,'done',job.error || logs);
    assert.equal(job.duration,1.5,'trimmed image must use out minus in');
    const download = await fetch(base+'/download/'+job.id);
    assert.equal(download.headers.get('content-type'),'video/mp4');
    const output = join(temp,'result.mp4');
    await writeFile(output,Buffer.from(await download.arrayBuffer()));
    const probe = JSON.parse(run(ffprobe,['-v','error','-show_format','-show_streams','-of','json',output]));
    assert.ok(Math.abs(Number(probe.format.duration)-1.5)<.15);
    assert.ok(probe.streams.some(s => s.codec_name==='h264' && s.width===320 && s.height===180));
    assert.ok(probe.streams.some(s => s.codec_name==='aac'));
    // A full white frame during the timed overlay, then the original pattern after it.
    const luminance = time => {
      const result = spawnSync(ffmpeg,['-v','error','-ss',String(time),'-i',output,'-frames:v','1','-vf','scale=1:1,format=gray','-f','rawvideo','pipe:1'],{windowsHide:true,timeout:10000});
      assert.equal(result.status,0,String(result.stderr)); return result.stdout[0];
    };
    assert.ok(luminance(.85)>245,'overlay must appear at the requested time');
    assert.ok(luminance(1.25)<220,'overlay must disappear after its end');

    // Independent media starts and overlays; audio plays before the first visual.
    run(ffmpeg,['-v','error','-y','-f','lavfi','-i','sine=frequency=660:duration=1','-c:a','pcm_s16le',join(temp,'music.wav')]);
    const music=await post('/upload?name=music.wav',await readFile(join(temp,'music.wav')));
    assert.equal(music.width,0);assert.equal(music.hasAudio,true);
    const composite=await post('/render',JSON.stringify({timeline:true,duration:3,width:320,height:180,fps:24,quality:'low',name:'multitrack-smoke',
      clips:[
        {id:video.id,kind:'video',in:0,out:1,start:1,layer:0,volume:0},
        {id:overlay.id,kind:'image',in:0,out:.5,start:1.25,layer:2,scale:.5,opacity:1},
        {id:image.id,kind:'image',in:0,out:.5,start:2.5,layer:0},
        {id:music.id,kind:'audio',in:0,out:1,start:.5,volume:.5},
        {id:music.id,kind:'audio',in:0,out:1,start:.5,volume:.5},
        {id:music.id,kind:'audio',in:0,out:1,start:2,volume:1,muted:true},
      ],texts:[]}),{'content-type':'application/json'});
    job=composite.job;
    for(let n=0;n<200&&!['done','error'].includes(job.status);n++){await delay(150);job=(await(await fetch(base+'/job/'+job.id)).json()).job;}
    assert.equal(job.status,'done',job.error||logs);assert.equal(job.duration,3);
    const mixedFile=join(temp,'multitrack.mp4');await writeFile(mixedFile,Buffer.from(await(await fetch(base+'/download/'+job.id)).arrayBuffer()));
    const pixel=time=>{
      const result=spawnSync(ffmpeg,['-v','error','-ss',String(time),'-i',mixedFile,'-frames:v','1','-vf','crop=40:40:140:70,scale=1:1,format=gray','-f','rawvideo','pipe:1'],{windowsHide:true});
      assert.equal(result.status,0,String(result.stderr));return result.stdout[0];
    };
    assert.ok(pixel(.25)<8,'visual gaps must remain black');
    assert.ok(pixel(1.5)>245,'upper image track must overlay the video at its scheduled start');
    assert.ok(pixel(2.25)<8,'visuals must disappear after their end');
    assert.ok(pixel(2.75)>20,'late background image must appear at its own start');
    const rms=start=>{
      const result=spawnSync(ffmpeg,['-v','error','-ss',String(start),'-i',mixedFile,'-t','0.2','-vn','-ac','1','-f','f32le','pipe:1'],{windowsHide:true});
      assert.equal(result.status,0,String(result.stderr));let sum=0;for(let n=0;n<result.stdout.length;n+=4)sum+=result.stdout.readFloatLE(n)**2;return Math.sqrt(sum/(result.stdout.length/4));
    };
    assert.ok(rms(.1)<.002,'audio must not start before its timeline offset');
    assert.ok(rms(.75)>.06,'two independent audio clips must be mixed without averaging their volume');
    assert.ok(rms(2.5)<.002,'muted audio must remain silent');

    const keyed=await post('/render',JSON.stringify({timeline:true,duration:.5,width:320,height:180,fps:24,quality:'low',clips:[
      {id:image.id,kind:'image',in:0,out:.5,start:0,layer:0},
      {id:overlay.id,kind:'image',in:0,out:.5,start:0,layer:1,colorKey:{color:'#ffffff',similarity:.05,blend:0}},
    ]}),{'content-type':'application/json'});
    job=keyed.job;for(let n=0;n<100&&!['done','error'].includes(job.status);n++){await delay(100);job=(await(await fetch(base+'/job/'+job.id)).json()).job;}
    assert.equal(job.status,'done',job.error||logs);
    const keyedFile=join(temp,'api-keyed.mp4');await writeFile(keyedFile,Buffer.from(await(await fetch(base+'/download/'+job.id)).arrayBuffer()));
    const keyedPixel=spawnSync(ffmpeg,['-v','error','-ss','0.2','-i',keyedFile,'-frames:v','1','-vf','scale=1:1,format=rgb24','-f','rawvideo','pipe:1'],{windowsHide:true,timeout:10000});
    assert.equal(keyedPixel.status,0,String(keyedPixel.stderr));assert.ok(keyedPixel.stdout[1]>keyedPixel.stdout[0]+15&&keyedPixel.stdout[1]<120,'bridge passes key parameters through to exported pixels');

    for(const only of ['audio','text']){
      const standalone=await post('/render',JSON.stringify({timeline:true,duration:.5,width:320,height:180,fps:24,name:only+'-only',
        clips:only==='audio'?[{kind:'audio',id:music.id,in:0,out:.5,start:0,volume:1}]:[],
        texts:only==='text'?[{id:overlay.id,start:0,end:.25}]:[],
      }),{'content-type':'application/json'});
      job=standalone.job;
      for(let n=0;n<200&&!['done','error'].includes(job.status);n++){await delay(100);job=(await(await fetch(base+'/job/'+job.id)).json()).job;}
      assert.equal(job.status,'done',job.error||logs);assert.equal(job.duration,.5);
      assert.ok(Number.isFinite(job.elapsedSeconds)&&job.elapsedSeconds>0,'bridge exposes measured export time');
      assert.ok(Number.isFinite(job.renderSpeed)&&job.renderSpeed>0,'bridge exposes FFmpeg rendering speed');
      const standaloneFile=join(temp,only+'-only.mp4');
      await writeFile(standaloneFile,Buffer.from(await(await fetch(base+'/download/'+job.id)).arrayBuffer()));
      const info=JSON.parse(run(ffprobe,['-v','error','-show_streams','-of','json',standaloneFile]));
      assert.ok(info.streams.some(s=>s.codec_name==='h264'));assert.ok(info.streams.some(s=>s.codec_name==='aac'));
    }
  } finally {
    child.kill();
    await rm(temp,{recursive:true,force:true});
  }
});
