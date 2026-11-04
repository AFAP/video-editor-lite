import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn,spawnSync } from 'node:child_process';
import { mkdtemp,readFile,writeFile,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

test('speech HTTP flow: mock Bailian, real audio extraction/concat, preview ranges and FFmpeg export',{timeout:60000},async()=>{
  const folder=await mkdtemp(join(tmpdir(),'speech-bridge-test-'));
  const ffmpeg=process.env.FFMPEG_PATH||'ffmpeg',ffprobe=process.env.FFPROBE_PATH||'ffprobe';
  function run(file,args){const result=spawnSync(file,args,{encoding:'utf8',windowsHide:true,timeout:15000});assert.equal(result.status,0,result.stderr||result.error?.message);return result.stdout;}
  run(ffmpeg,['-v','error','-y','-f','lavfi','-i','sine=frequency=550:duration=1','-c:a','pcm_s16le',join(folder,'source.wav')]);
  const wave=await readFile(join(folder,'source.wav'));let mockBase='';const calls=[];
  const provider=createServer(async(req,res)=>{
    if(req.url==='/audio.wav'){assert.equal(req.headers.authorization,undefined);res.writeHead(200,{'Content-Type':'audio/wav'});res.end(wave);return;}
    const parts=[];for await(const part of req)parts.push(part);const body=JSON.parse(Buffer.concat(parts).toString());calls.push({url:req.url,body});
    assert.equal(req.headers.authorization,'Bearer local-test-key');
    if(req.url==='/asr'){
      assert.ok(body.input.messages[0].content[0].input_audio.data.startsWith('data:audio/wav;base64,') );assert.equal(body.parameters.sample_rate,'16000');
      const event={output:{text:'轻剪测试。',sentence:{sentence_id:1,sentence_end:true,begin_time:50,end_time:600,words:[{text:'轻剪',begin_time:50,end_time:300,fixed:true},{text:'测试',punctuation:'。',begin_time:300,end_time:600,fixed:true}]}}};
      res.writeHead(200,{'Content-Type':'text/event-stream'});const bytes=Buffer.from('data: '+JSON.stringify(event)+'\n\n');res.write(bytes.subarray(0,57));res.end(bytes.subarray(57));return;
    }
    if(req.url==='/tts'){
      assert.equal(body.model,'qwen-audio-3.1-tts-plus');assert.equal(body.input.voice,'longanhuan_v3.1');assert.equal(body.input.format,'wav');assert.equal(body.input.word_timestamp_enabled,true);
      res.writeHead(200,{'Content-Type':'text/event-stream'});res.end([
        {output:{type:'sentence-end',original_text:'你好。',sentence:{index:0,words:[{begin_index:0,end_index:2,begin_time:0,end_time:900,text:'你好'}]}}},
        {output:{finish_reason:'stop',audio:{url:mockBase+'/audio.wav'}}},
      ].map(data=>'data: '+JSON.stringify(data)+'\n\n').join(''));return;
    }
    assert.equal(req.url,'/v1/chat/completions');assert.equal(body.model,'deepseek-v4.1-flash-1017');
    res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:JSON.stringify({text:'你好，欢迎来到轻剪。'})}}]}));
  });
  await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));mockBase='http://127.0.0.1:'+provider.address().port;
  const portProbe=createServer();await new Promise(resolve=>portProbe.listen(0,'127.0.0.1',resolve));const port=portProbe.address().port;await new Promise(resolve=>portProbe.close(resolve));
  const child=spawn(process.execPath,[fileURLToPath(new URL('../ffmpeg-bridge.mjs',import.meta.url))],{windowsHide:true,env:{...process.env,PORT:String(port),BAILIAN_API_KEY:'',DASHSCOPE_API_KEY:''}});
  let log='';child.stdout.on('data',data=>log+=data);child.stderr.on('data',data=>log+=data);
  const base='http://127.0.0.1:'+port;
  async function request(path,body,headers={}){const res=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:body===undefined?headers:{'Content-Type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body)});const data=await res.json();assert.equal(data.ok,true,JSON.stringify(data));return data;}
  async function job(body){const start=await request('/speech/jobs',body);for(let n=0;n<200;n++){const state=await request('/speech/jobs/'+start.job.id);if(state.job.status!=='running'){assert.equal(state.job.status,'done',state.job.error);return state.job.result;}await delay(30);}throw Error('speech job timeout');}
  try{
    let ready=false;for(let n=0;n<60;n++){try{if((await(await fetch(base+'/ping')).json()).ok){ready=true;break;}}catch{}await delay(100);}assert.ok(ready,log);
    const blocked=await fetch(base+'/speech/config',{headers:{Origin:'https://unrelated.invalid'}});assert.equal(blocked.status,403);
    const initial=await request('/speech/config');assert.equal(initial.config.hasKey,false);
    const config=await request('/speech/config',{apiKey:'local-test-key',ttsUrl:mockBase+'/tts',asrUrl:mockBase+'/asr',chatUrl:mockBase+'/v1'});
    assert.equal(config.config.hasKey,true);assert.ok(!JSON.stringify(config).includes('local-test-key'));
    const uploaded=await(await fetch(base+'/upload?name=source.wav',{method:'POST',body:wave})).json();assert.ok(uploaded.ok);
    const asr=await job({kind:'asr',sourceId:uploaded.id,in:.1,out:.8,language:'zh'});assert.equal(asr.segments[0].text,'轻剪测试。');assert.ok(Math.abs(asr.duration-.7)<.00001);
    const tts=await job({kind:'tts',text:'你好。',voice:'longanhuan_v3.1',subtitles:true,rate:1,language:'zh'});assert.ok(tts.audio.duration>0);assert.equal(tts.segments[0].text,'你好。');
    const audio=await fetch(base+tts.audio.url,{headers:{Range:'bytes=10-29'}});assert.equal(audio.status,206);assert.equal((await audio.arrayBuffer()).byteLength,20);
    const rewrite=await job({kind:'rewrite',mode:'script',text:'你好轻剪'});assert.equal(rewrite.text,'你好，欢迎来到轻剪。');
    const rendering=await request('/render',{timeline:true,duration:tts.audio.duration,width:320,height:180,fps:24,clips:[{id:tts.audio.id,kind:'audio',in:0,out:tts.audio.duration,start:0,volume:1}],texts:[]});
    let exported;for(let n=0;n<200;n++){exported=(await request('/job/'+rendering.job.id)).job;if(exported.status==='done'||exported.status==='error')break;await delay(30);}assert.equal(exported.status,'done',exported.error);
    const output=join(folder,'speech.mp4');await writeFile(output,Buffer.from(await(await fetch(base+'/download/'+exported.id)).arrayBuffer()));
    const meta=JSON.parse(run(ffprobe,['-v','error','-show_streams','-of','json',output]));assert.ok(meta.streams.some(stream=>stream.codec_name==='aac'));assert.ok(meta.streams.some(stream=>stream.codec_name==='h264'));
    assert.equal(calls.length,3);assert.ok(!log.includes('local-test-key'));
  }finally{child.kill();await new Promise(resolve=>provider.close(resolve));await rm(folder,{recursive:true,force:true});}
});
