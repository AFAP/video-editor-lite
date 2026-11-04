import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,readFile,writeFile,rm,mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createSpeechService,readCloudEvents,splitSpeechText,wordsToCues,SPEECH_DEFAULTS } from '../speech-service.mjs';

const sentence={sentence_id:1,sentence_end:true,begin_time:100,end_time:900,text:'这是测试。',words:[{begin_time:100,end_time:400,text:'这是',fixed:true},{begin_time:400,end_time:900,text:'测试',punctuation:'。',fixed:true}]};
const asrResponse=()=>new Response(JSON.stringify({output:{sentence,text:sentence.text}}),{headers:{'content-type':'application/json'}});
const sse=events=>new Response(events.map(event=>'data: '+JSON.stringify(event)+'\n\n').join(''),{headers:{'content-type':'text/event-stream'}});
async function waitJob(service,id){for(let n=0;n<400;n++){const job=service.get(id);if(job.status!=='running')return job;await delay(5);}throw Error('job did not finish');}
async function fixture(t,fetchImpl){
  const dir=await mkdtemp(join(tmpdir(),'speech-unit-'));await mkdir(join(dir,'input'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const calls=[],uploads=new Map([['source',{path:join(dir,'source.wav'),duration:400,hasAudio:true}]]);
  const service=createSpeechService({ffmpeg:'test-ffmpeg',inDir:join(dir,'input'),workDir:dir,uploads,env:{},fetchImpl,
    run:async(file,args,options={})=>{calls.push(args);if(options.signal?.aborted)throw Error('aborted');await writeFile(args.at(-1),Buffer.from('test wave'));},
    probe:async()=>({duration:1.5,width:0,height:0,hasAudio:true}),
  });
  service.configure({apiKey:'private-test-key',ttsUrl:'http://127.0.0.1:18181/tts',asrUrl:'http://127.0.0.1:18181/asr',chatUrl:'http://127.0.0.1:18181/v1'});
  return {service,calls,uploads};
}

test('speech defaults use a placeholder endpoint and example models',()=>{
  for(const key of ['ttsUrl','asrUrl','chatUrl'])assert.equal(new URL(SPEECH_DEFAULTS[key]).hostname,'your-bailian-endpoint.example');
  assert.ok(SPEECH_DEFAULTS.ttsUrl.endsWith('/api/v1/services/audio/tts/SpeechSynthesizer'));
  assert.equal(SPEECH_DEFAULTS.ttsModel,'qwen-audio-3.1-tts-plus');assert.equal(SPEECH_DEFAULTS.chatModel,'deepseek-v4.1-flash-1017');
});
test('SSE reader handles UTF-8 split inside Chinese characters and CRLF frames',async()=>{
  const bytes=new TextEncoder().encode('event: result\r\ndata: '+JSON.stringify({output:{text:'你好世界'}})+'\r\n\r\ndata: [DONE]\r\n\r\n');
  const parts=[];for(let i=0;i<bytes.length;i+=7)parts.push(bytes.slice(i,i+7));
  const response=new Response(new ReadableStream({start(controller){for(const part of parts)controller.enqueue(part);controller.close();}}),{headers:{'content-type':'text/event-stream'}});
  const events=[];await readCloudEvents(response,event=>events.push(event));assert.equal(events.length,1);assert.equal(events[0].output.text,'你好世界');
});
test('SSE errors and invalid event JSON cannot be interpreted as successful speech',async()=>{
  await assert.rejects(readCloudEvents(sse([{code:'InvalidApiKey',message:'bad key'}]),()=>{}),/bad key/);
  await assert.rejects(readCloudEvents(new Response('data: not json\n\n',{headers:{'content-type':'text/event-stream'}}),()=>{}),/无法解析/);
});
test('timestamp grouping preserves real word boundaries and splits at pauses',()=>{
  const cues=wordsToCues([...sentence.words,{begin_time:2000,end_time:2400,text:'下一句',punctuation:'。'}],{offset:180});
  assert.equal(cues.length,2);assert.equal(cues[0].start,180.1);assert.equal(cues[0].end,180.9);assert.equal(cues[0].text,'这是测试。');assert.equal(cues[1].start,182);
  assert.deepEqual(wordsToCues([{text:'invalid',begin_time:NaN,end_time:100}]),[]);
});
test('long TTS scripts split at punctuation without breaking surrogate pairs',()=>{
  const input=('你好😀。'.repeat(250));const chunks=splitSpeechText(input,80);
  assert.ok(chunks.length>1);assert.ok(chunks.every(chunk=>Array.from(chunk).length<=80));assert.equal(chunks.join(''),input);
});
test('configuration never exposes a key and requires re-entry on a domain change',async t=>{
  const {service}=await fixture(t,async()=>asrResponse());assert.equal(service.publicConfig().hasKey,true);assert.equal(service.publicConfig().apiKey,undefined);
  assert.ok(!JSON.stringify(service.publicConfig()).includes('private-test-key'));
  assert.throws(()=>service.configure({chatUrl:'https://example.com/v1'}),/重新填写/);
  assert.throws(()=>service.configure({ttsUrl:'file:///etc/passwd',apiKey:'new'}),/HTTP/);
  assert.throws(()=>service.configure({apiKey:'bad\r\nkey'}),/格式/);
  service.configure({clearKey:true});assert.equal(service.publicConfig().hasKey,false);assert.throws(()=>service.start({kind:'asr'}),/API Key/);
});
test('long ASR ranges are extracted in chunks and timestamps accumulate correctly',async t=>{
  const requests=[];const {service,calls}=await fixture(t,async(url,options)=>{requests.push(JSON.parse(options.body));return asrResponse();});
  const start=service.start({kind:'asr',sourceId:'source',in:0,out:400,language:'zh'}),job=await waitJob(service,start.id);
  assert.equal(job.status,'done',job.error);assert.equal(requests.length,3);assert.deepEqual(calls.map(args=>args[args.indexOf('-ss')+1]),['0','180','360']);
  assert.ok(requests.every(body=>body.input.messages[0].content[0].input_audio.data.startsWith('data:audio/wav;base64,')));
  assert.deepEqual(job.result.segments.map(cue=>cue.start),[.1,180.1,360.1]);
});
test('ASR uses the selected trim range instead of uploading the entire source',async t=>{
  const {service,calls}=await fixture(t,async()=>asrResponse());const job=await waitJob(service,service.start({kind:'asr',sourceId:'source',in:21,out:26}).id);
  assert.equal(job.status,'done');assert.equal(calls[0][calls[0].indexOf('-ss')+1],'21');assert.equal(calls[0][calls[0].indexOf('-t')+1],'5');assert.equal(job.result.duration,5);
});
test('TTS uses the SpeechSynthesizer schema, downloads without forwarding the key and registers audio',async t=>{
  const requests=[];const {service,uploads}=await fixture(t,async(url,options={})=>{
    requests.push({url:String(url),options});
    if(options.method==='POST')return sse([{output:{type:'sentence-end',original_text:'你好。',sentence:{index:0,words:[{begin_index:0,end_index:2,begin_time:100,end_time:800,text:'你好'}]}}},{output:{finish_reason:'stop',audio:{url:'http://127.0.0.1:18181/result.wav'}}}]);
    return new Response(Buffer.from('test wave'));
  });
  const job=await waitJob(service,service.start({kind:'tts',text:'你好。',voice:'longanhuan_v3.1',rate:1.2,subtitles:true,language:'zh'}).id);
  assert.equal(job.status,'done',job.error);const body=JSON.parse(requests[0].options.body);
  assert.equal(body.model,'qwen-audio-3.1-tts-plus');assert.equal(body.input.rate,1.2);assert.equal(body.input.format,'wav');assert.equal(body.input.word_timestamp_enabled,true);
  assert.equal(requests[1].options.headers,undefined);assert.ok(uploads.get(job.result.audio.id).generatedSpeech);assert.equal(job.result.segments[0].text,'你好。');
});
test('subtitle proofreading checks IDs and refuses model responses that lose entries',async t=>{
  const {service}=await fixture(t,async()=>new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({segments:[{id:99,text:'wrong'}]})}}]}),{headers:{'content-type':'application/json'}}));
  const job=await waitJob(service,service.start({kind:'rewrite',mode:'captions',segments:[{text:'测试'}]}).id);
  assert.equal(job.status,'error');assert.match(job.error,/编号/);
});
test('cloud errors are redacted and cancellation releases the active task',async t=>{
  let requests=0;const {service}=await fixture(t,async(url,options)=>{requests++;if(requests===1)return new Response(JSON.stringify({message:'private-test-key unauthorized'}),{status:401,headers:{'content-type':'application/json'}});
    return new Promise((resolve,reject)=>{options.signal.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true});});
  });
  const error=await waitJob(service,service.start({kind:'asr',sourceId:'source',in:0,out:2}).id);assert.equal(error.status,'error');assert.ok(!error.error.includes('private-test-key'));
  const pending=service.start({kind:'rewrite',mode:'script',text:'测试'});assert.throws(()=>service.start({kind:'tts',text:'duplicate'}),/已有 AI/);
  await delay(10);service.cancel(pending.id);assert.equal((await waitJob(service,pending.id)).status,'cancelled');
});
