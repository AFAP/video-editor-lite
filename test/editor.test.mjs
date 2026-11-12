import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { normalizeColorKey as nativeColorKey } from '../color-key.mjs';

// Run the shipped inline script in an isolated lightweight DOM adapter.
// These tests cover editing state; visual layout is verified separately.
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);

class Element {
  constructor() {
    this.style = { setProperty() {} };
    this.classList = { add() {}, remove() {}, toggle() {} };
    this.listeners = {};
    this.dataset = {};
    this.attributes = {};
    this.children = [];
    this.value = '';
    this.innerHTML = '';
    this.textContent = '';
    this.width = 1280; this.height = 720;
    this.clientWidth = 900; this.clientHeight = 440;
  }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  getAttribute(key) { return this.attributes[key] ?? null; }
  removeAttribute(key) { delete this.attributes[key]; }
  appendChild(node) { this.children.push(node); }
  querySelector() { return new Element(); }
  getContext() { return new Proxy({}, {get: (_, key) => key === 'measureText' ? text => ({width:String(text).length*8}) : key === 'createLinearGradient' || key === 'createRadialGradient' ? () => ({addColorStop() {}}) : () => {}}); }
  toDataURL() { return 'data:image/png;base64,test'; }
  getBoundingClientRect() { return {left:0,top:0,width:900,height:440}; }
  focus() {} select() {} contains() { return false; }
  remove() { this.removed=true; } load() {} pause() {}
  removeEventListener(type,fn) { this.listeners[type]=(this.listeners[type]||[]).filter(item=>item!==fn); }
  showModal() { this.open=true; } close() { this.open=false; }
}

function editor({storageBlocked = false, tracks = [], page = {}, browser = {}} = {}) {
  const frames = [];
  const clock = {time:0};
  const requests=[];
  const blobs=new Map(),revoked=[];
  const elements = new Map(ids.map(id => [id, new Element()]));
  const generic = new Element();
  const document = {
    body:new Element(), activeElement:null, listeners:{},
    querySelector(selector) {
      if (selector.startsWith('#')) return elements.get(selector.slice(1)) ?? null;
      if (selector === 'dialog[open]') return null;
      return generic;
    },
    createElement(tag) {
      const el=new Element();
      if(tag==='video'||tag==='audio'){
        el.readyState=1;el.duration=10;el.videoWidth=1920;el.videoHeight=1080;
        Object.defineProperty(el,'src',{set(url){this.url=url;const file=blobs.get(url);this.duration=file?.duration??10;this.failure=file?.failure;this.readyState=file?.failure?0:1;},get(){return this.url;}});
        el.load=()=>{if(el.failure)queueMicrotask(()=>{for(const fn of el.listeners.error||[])fn();});};
      }
      return el;
    },
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
  };
  const context = vm.createContext({
    document, location:{protocol:'file:',hostname:'',port:'',...page}, console, structuredClone, performance:{now:()=>clock.time},
    localStorage:{getItem() { if (storageBlocked) throw Error('blocked'); return null; },setItem() {}},
    setTimeout:() => 1, clearTimeout() {}, setInterval() {},
    requestAnimationFrame:fn => { frames.push(fn); return frames.length; },
    AbortController, ResizeObserver:class {observe() {}},
    URL:{createObjectURL(file){const url='blob:test-'+blobs.size;blobs.set(url,file);return url;},revokeObjectURL(url){revoked.push(url);}},
    Image:class {constructor(){this.naturalWidth=256;this.naturalHeight=256;this.complete=true;}async decode(){}},
    fetch:async url => {requests.push(url);return {ok:true,json:async () => ({ok:true,version:'test'})};},
    MediaRecorder:{isTypeSupported:() => true},
    window:{addEventListener() {},removeEventListener() {},...browser},indexedDB:browser.indexedDB,
  });
  let js = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  js = js.replace(/\}\)\(\);\s*$/, `globalThis.testApi = { S, settings, bridge, history,
    appendClip, addSourceToTimeline, importPickedFiles, reorderTrack, normalizeTrackNames, setClipTransform, syncTransformInputs, refreshKeyframeInspector, copyTimelineSelection, pasteTimelineSelection, layout, outputSize, splitAtPlayhead, duplicateSelected,
    deleteSelected, commitHistory, undo, redo, readSettings, updateOutputNote, togglePlay,
    activeRows, visualRows, totalDuration, addTrack, moveClipTo, mediaForClip, clipVolume, mediaKind,
    normalizeColorKey,keyPixels,setClipColorKey,syncColorKeyInspector,overlayAtPlayhead,startExport,
    parseSrt,serializeSrt,setSpeechDraft,speechState,validateSpeechDraft,applySpeechCaptions,
    buildProject,validateProject,prepareProject,applyProject,projectState,connectPreviousClip,transitionState,
    relinkProjectFiles,closeProjectDialog,matchProjectFiles,chooseMediaFiles,rememberSourceFile,loadSourceFile,authorizeProjectSource,
    setSelection,selectionEntries,groupSelection,detachAudio,rippleDelete,closeTimelineGaps,isLocked,clipKind,
    animationValue,setAnimationValue,validateAnimation,applyCaptionStyle,openCaptionEditor,detectBridge,openSpeech,
    transitionCuts,transitionItems,insertTransition,removeTransition,selectedTransition,reconcileLinkedTransitions,paintTransitionDemo,
    createFancyText,applyFancyToSelected,applyTextPreset,FANCY_TEXT_PRESETS,FANCY_CATEGORIES,TEXT_PRESETS,createSticker,STICKER_ASSETS,STICKER_CATEGORIES,STICKER_ATLAS_SIZE,drawTextLayer,filterLibraryItems,
    quiet() { renderSources = renderTimeline = renderPanels = drawAt = updateSummary = refreshHistoryUi = refreshThumb = () => {};
      seek = time => { S.time = clamp(time,0,totalDuration()); };
      stopPlayback = () => { S.playing = false; };
    }
  }; })();`);
  vm.runInContext(js, context, {timeout:2000});
  const api = context.testApi;
  api.quiet();
  for(const kind of tracks)api.addTrack(kind);
  api.S.activeTrack='v1';
  return {api, elements, document, frames, clock, requests,revoked};
}

function playbackMedia(initialTime) {
  let time = initialTime;
  const listeners = new Set();
  return {
    readyState:2, ended:false, playStarts:[], seekTargets:[],
    get currentTime() { return time; },
    set currentTime(value) {
      time = value; this.seekTargets.push(value);
      queueMicrotask(() => { for (const fn of [...listeners]) fn(); });
    },
    addEventListener(type, fn) { if (type === 'seeked') listeners.add(fn); },
    removeEventListener(type, fn) { if (type === 'seeked') listeners.delete(fn); },
    async play() { this.playStarts.push(time); },
    pause() {},
    advance(value) { time = value; },
  };
}

async function untilFrame(frames) {
  for (let n=0;n<20 && !frames.length;n++) await Promise.resolve();
  assert.ok(frames.length,'playback should reach its first animation frame');
}

async function pausePlayback(api, frames, playback) {
  await api.togglePlay();
  while (frames.length) frames.shift()();
  await playback;
}

test('single-page document has unique IDs and every literal ID reference exists', () => {
  assert.equal(new Set(ids).size, ids.length);
  for (const match of html.matchAll(/\$\(['"]#([\w-]+)['"]\)/g)) assert.ok(ids.includes(match[1]), match[1]);
  assert.equal((html.match(/<script\b/g) || []).length, 1);
  assert.ok(!/<(?:script|link)[^>]+(?:src|href)=["']https?:/i.test(html));
});

test('shipped script starts with available or blocked browser storage', () => {
  assert.ok(editor().api);
  assert.deepEqual(JSON.parse(JSON.stringify(editor({storageBlocked:true}).api.readSettings())), {});
});

test('public browser edition never probes local services and still imports SRT captions',async()=>{
  const {api,elements,requests}=editor({page:{protocol:'https:',hostname:'afap.github.io'}});
  assert.equal(await api.detectBridge(false),false);assert.equal(requests.length,0);assert.equal(api.bridge.base,'');
  assert.equal(elements.get('bridgeBadge').textContent,'浏览器版');assert.equal(elements.get('btnSpeech').textContent,'导入字幕');
  await api.openSpeech();assert.equal(requests.length,0);assert.equal(elements.get('btnRecognize').disabled,true);
  assert.equal(elements.get('btnTtsGenerate').disabled,true);assert.equal(elements.get('speechApiKey').value,'');
  api.setSpeechDraft(api.parseSrt('1\n00:00:00,000 --> 00:00:01,000\nHello'));api.applySpeechCaptions();
  assert.equal(api.S.texts[0].content,'Hello');assert.equal(requests.length,0);assert.equal(elements.get('btnProofreadCaptions').disabled,true);
});

test('local editor keeps bridge detection and AI speech available',async()=>{
  const {api,elements,requests}=editor({page:{protocol:'http:',hostname:'127.0.0.1',port:'8787'}});
  assert.equal(await api.detectBridge(false),true);assert.ok(requests.every(url=>url.startsWith('http://127.0.0.1:')));
  assert.ok(api.bridge.base);assert.notEqual(elements.get('btnSpeech').textContent,'导入字幕');
});

function seed(api) {
  const source = {id:'source',name:'sample.mp4',duration:10,width:1920,height:1080,size:1024,el:{pause() {}},url:'blob:test'};
  api.S.sources.push(source);
  const clip = api.appendClip(source,1,9);
  return {source,clip};
}

test('new projects start with one visual track and create audio/text tracks only when used',()=>{
  const {api}=editor();assert.equal(api.S.tracks.length,1);assert.equal(api.S.tracks[0].id,'v1');
  api.openCaptionEditor();assert.equal(api.S.tracks.length,1,'opening an empty caption panel must not add a track');
  seed(api);assert.equal(api.S.tracks.length,1,'importing video uses the existing visual track');
  const audio={id:'music',kind:'audio',duration:10};api.S.sources.push(audio);api.appendClip(audio,0,4);
  assert.equal(api.S.tracks.length,2);assert.equal(api.S.clips.at(-1).trackId,'a1');
  api.appendClip(audio,4,8);assert.equal(api.S.tracks.length,2,'reuse the audio track');
  api.createFancyText(api.FANCY_TEXT_PRESETS[0].id);
  assert.equal(api.S.tracks.length,3);assert.equal(api.S.texts[0].trackId,'t1');
});

test('minimal projects can save and restore while older multitrack projects retain their tracks',async()=>{
  const minimal=editor().api;const project=minimal.buildProject();assert.doesNotThrow(()=>minimal.validateProject(project));
  minimal.addTrack('visual');await minimal.prepareProject(project);await minimal.applyProject();assert.equal(minimal.S.tracks.length,1);
  const older=editor({tracks:['text','visual','audio']}).api;const oldProject=older.buildProject();
  await minimal.prepareProject(oldProject);await minimal.applyProject();assert.equal(minimal.S.tracks.length,4);
});

test('empty auxiliary tracks may be removed and the remaining visual track stays active',()=>{
  const {api,elements}=editor();
  function remove(id){elements.get('trackHeads').listeners.click[0]({target:{closest(selector){return selector==='[data-track]'?{dataset:{track:id}}:{dataset:{action:'remove'}};}}});}
  api.addTrack('audio');remove('a1');assert.equal(api.S.tracks.length,1);assert.equal(api.S.activeTrack,'v1');
  api.addTrack('text');remove('t1');assert.equal(api.S.tracks.length,1);assert.equal(api.S.activeTrack,'v1');
  remove('v1');assert.equal(api.S.tracks.length,1,'retain a visual canvas track');
});

test('multiselect duplication preserves offsets and grouping, and undoes as one edit',()=>{
  const {api}=editor({tracks:['visual']});const {source,clip}=seed(api);const second=api.appendClip(source,0,2,'v2');second.start=3;
  api.setSelection([{type:'clip',id:clip.id},{type:'clip',id:second.id}]);api.groupSelection();const group=clip.groupId;assert.ok(group);assert.equal(second.groupId,group);
  api.duplicateSelected();assert.equal(api.S.clips.length,4);const copies=api.S.clips.slice(2);
  assert.equal(copies[1].start-copies[0].start,3);assert.equal(copies[0].groupId,copies[1].groupId);assert.notEqual(copies[0].groupId,group);
  api.undo();assert.equal(api.S.clips.length,2);assert.equal(api.selectionEntries().length,2);
});

test('locked tracks protect clips from split, movement and multiselect deletion',()=>{
  const {api}=editor({tracks:['visual']});const {source,clip}=seed(api);const other=api.appendClip(source,0,2,'v2');api.S.tracks.find(t=>t.id==='v1').locked=true;
  api.setSelection([{type:'clip',id:clip.id}]);api.S.time=3;api.splitAtPlayhead();assert.equal(api.S.clips.length,2);
  assert.equal(api.moveClipTo(clip,4,'v2'),false);assert.equal(clip.start,0);
  api.setSelection([{type:'clip',id:clip.id},{type:'clip',id:other.id}]);api.deleteSelected();assert.equal(api.S.clips.length,1);assert.equal(api.S.clips[0].id,clip.id);
});

test('ripple deletion trims crossing audio and subtitles while preserving locked tracks',()=>{
  const {api}=editor({tracks:['visual', 'audio', 'text']});const {source,clip}=seed(api);Object.assign(source,{kind:'video',duration:30});Object.assign(clip,{start:5,in:0,out:3});
  const later=api.appendClip(source,0,2);later.start=10;
  const audio=api.appendClip(source,0,20,'a1');audio.audioOnly=true;audio.trackId='a1';audio.start=0;
  const locked=api.appendClip(source,0,2,'v2');locked.start=12;api.S.tracks.find(t=>t.id==='v2').locked=true;
  api.S.texts.push({id:'caption',trackId:'t1',start:6,end:12,content:'hello'});
  api.setSelection([{type:'clip',id:clip.id}]);api.commitHistory();api.rippleDelete();
  assert.equal(later.start,10,'removed objects are not mutated in place');assert.equal(api.S.clips.find(c=>c.id===later.id).start,7);
  const parts=api.S.clips.filter(c=>c.audioOnly);assert.equal(parts.length,2);assert.equal(parts[0].out,5);assert.equal(parts[1].in,8);assert.equal(parts[1].start,5);
  assert.equal(api.S.texts[0].start,5);assert.equal(api.S.texts[0].end,9);assert.equal(api.S.clips.find(c=>c.id===locked.id).start,12);
  api.undo();assert.equal(api.S.clips.length,4);assert.equal(api.S.texts[0].start,6);
});

test('close gaps removes only globally empty intervals',()=>{
  const {api}=editor();const {source,clip}=seed(api);Object.assign(clip,{start:2,in:0,out:2});const other=api.appendClip(source,0,2);other.start=7;
  api.closeTimelineGaps();assert.equal(api.S.clips[0].start,0);assert.equal(api.S.clips[1].start,2);assert.equal(api.totalDuration(),4);
});

test('separated audio retains timing, automation and a group, without duplicating video or audio output',()=>{
  const {api}=editor();const {source,clip}=seed(api);source.kind='video';clip.start=2;clip.volume=.4;clip.keyframes={volume:[{time:1,value:.4},{time:9,value:1}]};
  api.setSelection([{type:'clip',id:clip.id}]);api.detachAudio();const audio=api.S.clips.find(c=>c.audioOnly);
  assert.ok(audio);assert.equal(audio.in,clip.in);assert.equal(audio.start,clip.start);assert.equal(audio.groupId,clip.groupId);
  assert.equal(api.clipKind(audio),'audio');assert.equal(api.visualRows(3).length,1);assert.equal(api.clipVolume(clip,1,8),0);assert.ok(api.clipVolume(audio,1,8)>0);
  const project=api.buildProject();assert.doesNotThrow(()=>api.validateProject(project));assert.ok(project.clips.some(c=>c.audioOnly));
  api.undo();assert.equal(api.S.clips.length,1);assert.equal(api.S.clips[0].muted,false);
});

test('source-relative keyframes interpolate and retain their animation across split and trim',()=>{
  const {api}=editor();const {clip}=seed(api);clip.keyframes={scale:[{time:1,value:1},{time:9,value:2}]};
  assert.equal(api.animationValue(clip,'scale',5),1.5);api.S.time=4;api.splitAtPlayhead();const [left,right]=api.S.clips;
  assert.equal(api.animationValue(left,'scale',5),1.5);assert.equal(api.animationValue(right,'scale',5),1.5);
  assert.notEqual(left.keyframes,right.keyframes);right.in=6;assert.equal(api.animationValue(right,'scale',6),1.625);
});

test('keyframe editing clamps values, replaces a point and validates saved animation',()=>{
  const {api}=editor();const {clip,source}=seed(api);source.kind='video';api.S.time=2;api.setAnimationValue(clip,'opacity',.5,{force:true});api.setAnimationValue(clip,'opacity',2);
  assert.equal(clip.keyframes.opacity.length,1);assert.equal(clip.keyframes.opacity[0].value,1);
  const project=api.buildProject();assert.doesNotThrow(()=>api.validateProject(project));
  project.clips[0].keyframes.scale=[{time:3,value:1},{time:2,value:2}];assert.throws(()=>api.validateProject(project),/关键帧/);
  assert.throws(()=>api.validateAnimation({unknown:[]}),/关键帧/);
});

test('caption batch styling preserves text, timing and locked captions',()=>{
  const {api}=editor({tracks:['text']});seed(api);const a={id:'ta',trackId:'t1',start:0,end:2,content:'one',size:7,color:'#ff0000',caption:true},b={id:'tb',trackId:'t1',start:3,end:4,content:'two',size:4,caption:true};
  api.S.texts.push(a,b);api.setSelection([{type:'text',id:a.id}]);api.applyCaptionStyle();assert.equal(b.size,7);assert.equal(b.color,'#ff0000');assert.equal(b.content,'two');assert.equal(b.start,3);assert.equal(b.end,4);
  api.S.tracks.find(t=>t.id==='t1').locked=true;a.size=9;api.applyCaptionStyle();assert.equal(b.size,7);
});

test('locked tracks, groups, separated audio and animation restore from a saved project',async()=>{
  const {api}=editor();const {source,clip}=seed(api);source.kind='video';clip.keyframes={scale:[{time:1,value:1},{time:9,value:2}]};
  api.setSelection([{type:'clip',id:clip.id}]);api.detachAudio();api.S.tracks.find(t=>t.id==='v1').locked=true;
  const project=api.buildProject();assert.doesNotThrow(()=>api.validateProject(project));
  await api.prepareProject(project);await api.applyProject();
  assert.equal(api.S.tracks.find(t=>t.id==='v1').locked,true);const video=api.S.clips.find(c=>!c.audioOnly),audio=api.S.clips.find(c=>c.audioOnly);
  assert.equal(video.groupId,audio.groupId);assert.equal(api.animationValue(video,'scale',5),1.5);assert.equal(audio.trackId,'a1');
  const oldGroup=video.groupId;api.S.tracks.find(t=>t.id==='v1').locked=false;api.S.seq=Number(oldGroup.slice(1))-1;
  api.setSelection(api.S.clips.map(c=>({type:'clip',id:c.id})));api.groupSelection();
  assert.notEqual(video.groupId,oldGroup,'new groups must not reuse a restored group ID');assert.equal(video.groupId,audio.groupId);
});

test('detaching audio creates an unlocked audio track and rolls back the whole operation in one undo',()=>{
  const {api}=editor({tracks:['audio']});const {source,clip}=seed(api);source.kind='video';api.S.tracks.find(t=>t.id==='a1').locked=true;
  api.setSelection([{type:'clip',id:clip.id}]);api.commitHistory();const count=api.S.tracks.length;
  api.detachAudio();assert.equal(api.S.tracks.length,count+1);assert.equal(api.S.clips.length,2);
  api.undo();assert.equal(api.S.tracks.length,count);assert.equal(api.S.clips.length,1);assert.equal(api.S.clips[0].muted,false);
});

test('split preserves transform, volume, mute and fades on both halves', () => {
  const {api} = editor(); const {clip} = seed(api);
  Object.assign(clip,{scale:.65,ox:.12,oy:-.2,volume:.3,muted:true,fadeIn:.5,fadeOut:1});
  api.S.time = 3;
  api.splitAtPlayhead();
  assert.equal(api.S.clips.length,2);
  const [left,right] = api.S.clips;
  assert.equal(left.out,4); assert.equal(right.in,4); assert.equal(right.out,9);
  assert.notEqual(left.id,right.id);
  for (const prop of ['scale','ox','oy','volume','muted','fadeIn','fadeOut']) assert.equal(left[prop],right[prop],prop);
  assert.equal(api.layout().at(-1).end,8);
});

test('split at a boundary does not create zero-length clips', () => {
  const {api} = editor(); seed(api);
  api.S.time = 0; api.splitAtPlayhead(); assert.equal(api.S.clips.length,1);
  api.S.time = 8; api.splitAtPlayhead(); assert.equal(api.S.clips.length,1);
});

test('delete, undo and redo restore clips and their media references', () => {
  const {api} = editor(); const {source} = seed(api); api.commitHistory();
  api.deleteSelected(); api.commitHistory(); assert.equal(api.S.clips.length,0);
  api.undo(); assert.equal(api.S.clips.length,1); assert.equal(api.S.sources[0],source);
  api.redo(); assert.equal(api.S.clips.length,0);
});

test('removing a source can be undone without cloning its video element', () => {
  const {api} = editor(); const {source} = seed(api); api.commitHistory();
  api.S.sources = []; api.S.clips = []; api.S.selected = null; api.commitHistory();
  api.undo(); assert.equal(api.S.sources[0],source); assert.equal(api.S.sources[0].url,'blob:test');
});

test('new edit after undo discards redo and history has a bounded size', () => {
  const {api} = editor(); const {clip} = seed(api); api.commitHistory();
  clip.scale = 2; api.commitHistory(); api.undo();
  api.S.clips[0].volume = .5; api.commitHistory();
  const index = api.history.index; api.redo(); assert.equal(api.history.index,index);
  for (let n=0;n<80;n++) { api.S.clips[0].ox = n/100; api.commitHistory(); }
  assert.equal(api.history.entries.length,60);
});

test('duplicating a clip preserves its edits and gives it a unique ID', () => {
  const {api} = editor(); const {clip} = seed(api); clip.scale = .7;
  api.duplicateSelected(); assert.equal(api.S.clips.length,2);
  assert.equal(api.S.clips[1].scale,.7); assert.notEqual(api.S.clips[1].id,clip.id);
});

test('output uses the first source aspect ratio with even dimensions', () => {
  const {api} = editor(); const {source} = seed(api);
  source.width=1080; source.height=1920; api.settings.size='1280';
  const {w,h} = api.outputSize(); assert.equal(w%2,0); assert.equal(h%2,0);
  assert.ok(Math.abs(w/h - 9/16) < .003); assert.ok(h<=1280);
});

test('bridge format is locked to MP4 only when all timeline media are uploaded', () => {
  const {api,elements} = editor(); const {source} = seed(api);
  api.bridge.base='http://127.0.0.1:8787'; api.settings.format='webm';
  api.updateOutputNote(); assert.equal(elements.get('setFormat').disabled,false);
  source.bridgeId='remote-id'; api.updateOutputNote();
  assert.equal(elements.get('setFormat').disabled,true); assert.equal(elements.get('setFormat').value,'mp4');
  assert.equal(api.settings.format,'webm');
});

for (const nextIn of [90,10]) test(`play from the current cursor when adjacent clips share media (next in ${nextIn}s)`, async () => {
  const {api,frames,clock} = editor();
  const media = playbackMedia(81);
  const source = {id:'shared',duration:200,el:media};
  api.S.sources.push(source);
  api.appendClip(source,10,90);
  api.appendClip(source,nextIn,nextIn+40);
  api.S.time=71;
  const playback=api.togglePlay();
  try {
    await untilFrame(frames);
    assert.equal(api.S.time,71,'the timeline cursor must not jump when Play is pressed');
    assert.equal(media.currentTime,81,'preparing the next clip must not seek the active video');
    assert.deepEqual(media.playStarts,[81]);
  } finally { await pausePlayback(api,frames,playback); }
});

test('pause and resume keep the current position inside a split clip', async () => {
  const {api,frames,clock} = editor();
  const media=playbackMedia(81),source={id:'shared',duration:200,el:media};
  api.S.sources.push(source); api.appendClip(source,10,90); api.appendClip(source,90,200);
  api.S.time=71;
  let playback=api.togglePlay();
  await untilFrame(frames);
  media.advance(82); clock.time+=1000; frames.shift()();
  assert.equal(api.S.time,72);
  await pausePlayback(api,frames,playback);
  playback=api.togglePlay();
  try {
    await untilFrame(frames);
    assert.equal(api.S.time,72);
    assert.equal(media.currentTime,82);
  } finally { await pausePlayback(api,frames,playback); }
});

test('image/audio/video detection accepts common extensions without MIME hints', () => {
  const {api}=editor();
  for(const name of ['logo.PNG','photo.jpg','photo.webp'])assert.equal(api.mediaKind({name}),'image');
  for(const name of ['voice.wav','music.mp3','music.flac','voice.m4a'])assert.equal(api.mediaKind({name}),'audio');
  assert.equal(api.mediaKind({name:'movie.MKV'}),'video');assert.equal(api.mediaKind({name:'notes.txt'}),'');
});

test('parallel tracks use independent start times and total duration is their maximum', () => {
  const {api}=editor({tracks:['visual']});const {source,clip}=seed(api);
  const audio={id:'audio',kind:'audio',duration:20};api.S.sources.push(audio);
  const music=api.appendClip(audio,0,20);assert.equal(music.trackId,'a1');assert.equal(music.start,0);
  api.moveClipTo(clip,5,'v2');assert.equal(api.totalDuration(),20);
  assert.equal(api.activeRows(6).length,2);assert.equal(api.activeRows(19).length,1);
  assert.equal(api.moveClipTo(music,0,'v1'),false);
});

test('image duration can be extended, split, and placed over the primary video', () => {
  const {api}=editor({tracks:['visual']});seed(api);const image={id:'image',kind:'image',duration:86400,width:500,height:500};api.S.sources.push(image);
  const overlay=api.appendClip(image,0,5,'v2');overlay.out=12;api.moveClipTo(overlay,2,'v2');
  api.reorderTrack('v2','v1');
  assert.equal(api.totalDuration(),14);assert.equal(api.visualRows(3).at(-1).clip,overlay);
  api.S.time=6;api.splitAtPlayhead();
  const right=api.S.clips.find(c=>c.id===api.S.selected.id);
  assert.equal(right.start,6);assert.equal(right.trackId,'v2');assert.equal(right.in,4);assert.equal(api.totalDuration(),14);
});

test('deleting a clip preserves the timing of clips on other tracks', () => {
  const {api}=editor();const {clip}=seed(api);const source={id:'audio',kind:'audio',duration:20};api.S.sources.push(source);
  const audio=api.appendClip(source,0,5);api.moveClipTo(audio,10,'a1');api.S.selected={type:'clip',id:clip.id};
  api.deleteSelected();assert.equal(audio.start,10);assert.equal(api.totalDuration(),15);
});

test('track creation, mute and layer movement are undoable', () => {
  const {api}=editor({tracks:['visual', 'audio']});const {clip}=seed(api);api.commitHistory();
  api.addTrack('audio');assert.equal(api.S.tracks.filter(t=>t.kind==='audio').length,2);
  api.undo();assert.equal(api.S.tracks.filter(t=>t.kind==='audio').length,1);api.redo();
  api.moveClipTo(api.S.clips[0],4,'v2');api.S.tracks.find(t=>t.id==='v2').muted=true;api.commitHistory();
  api.undo();assert.equal(api.S.clips[0].start,0);assert.equal(api.S.clips[0].trackId,'v1');
});

test('tracks can grow dynamically from one visual track without reusing IDs', () => {
  const {api}=editor();
  for(let n=0;n<8;n++)api.addTrack('visual');
  for(let n=0;n<5;n++)api.addTrack('audio');
  for(let n=0;n<3;n++)api.addTrack('text');
  assert.equal(api.S.tracks.length,17);
  assert.equal(new Set(api.S.tracks.map(t=>t.id)).size,17);
  api.undo();assert.equal(api.S.tracks.length,16);api.redo();assert.equal(api.S.tracks.length,17);
});

test('overlapping copies of a file receive independent media decoders', () => {
  const {api}=editor({tracks:['visual']});
  const original={cloneNode(){return {...playbackMedia(0),load(){},remove(){}};}};
  const source={id:'shared',kind:'video',duration:20,el:original};api.S.sources.push(source);
  const first=api.appendClip(source,0,5,'v1'),second=api.appendClip(source,10,15,'v2');
  const a=api.mediaForClip(first),b=api.mediaForClip(second);
  assert.notEqual(a.el,b.el);a.el.currentTime=2;b.el.currentTime=12;assert.equal(a.el.currentTime,2);
});

test('track visibility and audio fade envelopes affect the timed composition', () => {
  const {api}=editor();const {clip}=seed(api);clip.volume=.8;clip.fadeIn=2;clip.fadeOut=2;
  assert.equal(api.clipVolume(clip,1,8),.4);assert.equal(api.clipVolume(clip,7,8),.4);
  api.S.tracks.find(t=>t.id==='v1').muted=true;assert.equal(api.clipVolume(clip,4,8),0);
  api.S.tracks.find(t=>t.id==='v1').hidden=true;assert.equal(api.activeRows(1).length,0);
});

test('SRT supports BOM, CRLF, multiline captions and millisecond round trips',()=>{
  const {api}=editor();const source='\uFEFF1\r\n00:00:01,125 --> 00:00:03,750\r\n第一行\r\n第二行\r\n\r\n2\r\n00:01:00,000 --> 00:01:02,100\r\nHello world';
  const cues=api.parseSrt(source);assert.equal(cues.length,2);assert.equal(cues[0].start,1.125);assert.equal(cues[0].text,'第一行\n第二行');
  assert.equal(JSON.stringify(api.parseSrt(api.serializeSrt(cues))),JSON.stringify(cues));
  assert.throws(()=>api.parseSrt('1\n00:00:04,000 --> 00:00:03,000\nbad'),/无效区间/);
});

test('AI subtitle drafts do not alter the timeline until applied, and apply is undoable',()=>{
  const {api,elements}=editor();api.setSpeechDraft([{start:.1,end:1.2,text:'测试字幕'}],{offset:5});
  assert.equal(api.S.texts.length,0);assert.equal(api.S.tracks.length,1);
  api.applySpeechCaptions();assert.equal(api.S.texts.length,1);assert.equal(api.S.texts[0].start,5.1);assert.equal(api.S.texts[0].end,6.2);assert.equal(api.S.tracks.length,2);
  api.undo();assert.equal(api.S.texts.length,0);assert.equal(api.S.tracks.length,1);api.redo();assert.equal(api.S.texts.length,1);
});

test('ASR captions map to a moved clip while preserving the analyzed trim range',()=>{
  const {api}=editor();const {clip}=seed(api);
  api.setSpeechDraft([{start:1,end:2,text:'片段内字幕'}],{offset:clip.start,context:{clipId:clip.id,sourceId:clip.sourceId,in:clip.in,out:clip.out,start:clip.start}});
  clip.start=12;assert.equal(api.validateSpeechDraft()[0].start,13);
  clip.in+=1;api.applySpeechCaptions();assert.equal(api.S.texts.length,0,'stale ASR trims must not create misaligned captions');
});

test('cross-clip transitions overlap only the selected clip and preserve other track timing',()=>{
  const {api}=editor(),{source,clip}=seed(api);source.kind='video';
  const next=api.appendClip(source,1,9,'v1');const audio={id:'audio',kind:'audio',duration:20};api.S.sources.push(audio);const music=api.appendClip(audio,0,10,'a1');music.start=5;
  const overlap=api.connectPreviousClip(next,'fade',.5);assert.equal(overlap,.5);assert.equal(next.start,7.5);assert.equal(clip.start,0);assert.equal(music.start,5);
  assert.equal(api.transitionState(next,.25,1280,720).alpha,.5);assert.equal(next.fadeIn,.5);assert.equal(clip.fadeOut,.5);
});

test('project JSON excludes keys and runtime media and restores edits as an undoable operation',async()=>{
  const {api}=editor(),{source,clip}=seed(api);source.kind='video';source.apiKey='secret-media';api.settings.apiKey='secret-setting';
  clip.transitionIn={type:'wipeleft',duration:.4};api.settings.aspect='portrait';api.commitHistory();
  const project=api.buildProject();assert.ok(!JSON.stringify(project).includes('secret'));assert.equal(project.sources[0].el,undefined);assert.equal(api.validateProject(project),project);
  clip.scale=2;api.settings.aspect='source';api.commitHistory();await api.prepareProject(project);await api.applyProject();
  assert.equal(api.S.clips[0].scale,1);assert.equal(api.S.clips[0].transitionIn.type,'wipeleft');assert.equal(api.settings.aspect,'portrait');api.undo();assert.equal(api.S.clips[0].scale,2);assert.equal(api.settings.aspect,'source');
});

function mediaFile(overrides={}){return {name:'original.mp4',size:4096,type:'video/mp4',lastModified:123,duration:12,...overrides};}
function sourceAction(elements,id,act){
  return elements.get('sources').listeners.click[0]({target:{closest(selector){return selector==='[data-act]'?{dataset:{act}}:selector==='.src'?{dataset:{id}}:null;}}});
}
test('importing video, images and audio only populates the library without changing timeline or selection',async()=>{
  const {api,elements}=editor(),{clip}=seed(api);api.S.time=3;api.setSelection([{type:'clip',id:clip.id}]);api.commitHistory();
  const before=JSON.stringify({tracks:api.S.tracks,clips:api.S.clips,selection:api.selectionEntries(),time:api.S.time});
  await api.importPickedFiles([mediaFile(),mediaFile({name:'music.mp3',type:'audio/mpeg'}),mediaFile({name:'cover.png',type:'image/png'})]);
  assert.equal(api.S.sources.length,4);assert.equal(api.S.busy,false);
  assert.equal(JSON.stringify({tracks:api.S.tracks,clips:api.S.clips,selection:api.selectionEntries(),time:api.S.time}),before);
  api.undo();assert.equal(api.S.sources.length,1);api.redo();assert.equal(api.S.sources.length,4);
  const video=api.S.sources[1],image=api.S.sources[3],audio=api.S.sources[2];
  sourceAction(elements,video.id,'add');assert.equal(api.S.clips.at(-1).start,8);assert.equal(api.S.selected.id,api.S.clips.at(-1).id);
  sourceAction(elements,video.id,'add');assert.equal(api.S.clips.at(-1).start,20);assert.equal(api.S.clips.filter(c=>c.sourceId===video.id).length,2);
  sourceAction(elements,image.id,'add');assert.equal(api.S.clips.at(-1).out,5);assert.equal(api.S.clips.at(-1).trackId,'v1');
  sourceAction(elements,audio.id,'add');assert.equal(api.S.clips.at(-1).trackId,'a1');assert.equal(api.S.tracks.at(-1).kind,'audio');
  api.undo();assert.equal(api.S.clips.length,4);assert.equal(api.S.sources.length,4);assert.equal(api.S.tracks.length,1);
});

test('library actions work after import, protect referenced sources and respect busy state',async()=>{
  const {api,elements}=editor();await api.importPickedFiles([mediaFile()]);const source=api.S.sources[0];
  api.S.busy=true;sourceAction(elements,source.id,'add');assert.equal(api.S.clips.length,0);api.S.busy=false;
  sourceAction(elements,source.id,'add');assert.equal(api.S.clips.length,1);sourceAction(elements,source.id,'remove');assert.equal(api.S.sources.length,1);
  assert.match(elements.get('toast').textContent,/仍在时间线/);api.deleteSelected();sourceAction(elements,source.id,'remove');assert.equal(api.S.sources.length,0);
  api.undo();assert.equal(api.S.sources[0],source);sourceAction(elements,source.id,'add');assert.equal(api.S.clips.length,1);
});

test('new tracks append below with unified names, while reordering changes compositing and persists as one undo step',async()=>{
  const {api}=editor();const {source,clip}=seed(api);source.kind='video';api.addTrack('audio');api.addTrack('visual');
  assert.equal(api.S.tracks.map(t=>t.name).join(','),'轨道1,轨道2,轨道3');assert.equal(api.S.tracks.map(t=>t.id).join(','),'v1,a1,v2');
  const lower=api.appendClip(source,0,8,'v2');api.commitHistory();assert.equal(api.visualRows(1).at(-1).clip.id,clip.id);
  const count=api.history.entries.length;assert.equal(api.reorderTrack('v2','v1'),true);assert.equal(api.visualRows(1).at(-1).clip.id,lower.id);assert.equal(api.history.entries.length,count+1);
  assert.equal(api.S.tracks[0].name,'轨道3');assert.equal(api.S.clips[0].start,0);
  api.undo();assert.equal(api.S.tracks[0].id,'v1');api.redo();assert.equal(api.S.tracks[0].id,'v2');
  const project=api.buildProject();await api.prepareProject(project);await api.applyProject();assert.equal(api.S.tracks.map(t=>t.id).join(','),'v2,v1,a1');
  api.S.tracks[0].locked=true;assert.equal(api.reorderTrack('v2','a1',true),false);assert.equal(api.S.tracks[0].id,'v2');
  api.S.tracks[0].name='画面2';api.S.tracks[1].name='画面1';api.S.tracks[2].name='音频1';api.normalizeTrackNames();assert.equal(api.S.tracks.map(t=>t.name).join(','),'轨道1,轨道2,轨道3');
});

test('scale can be typed with decimals, stays in sync with the slider, supports keyframes and undo, and rejects locked edits',()=>{
  const {api,elements}=editor();const {clip,source}=seed(api);source.kind='video';api.commitHistory();
  const field=elements.get('cpScaleNumber');field.value='145.5';field.listeners.input[0]();field.listeners.change[0]();assert.equal(clip.scale,1.455);assert.equal(elements.get('cpScale').value,145.5);
  api.undo();assert.equal(api.S.clips[0].scale,1);api.redo();assert.equal(api.S.clips[0].scale,1.455);
  const current=api.S.clips[0];api.S.time=2;api.setAnimationValue(current,'scale',1,{force:true});assert.equal(api.setClipTransform('scale','175.2'),true);assert.ok(Math.abs(current.keyframes.scale[0].value-1.752)<1e-9);
  const before=JSON.stringify(current);assert.equal(api.setClipTransform('scale',''),false);assert.equal(api.setClipTransform('scale','invalid'),false);assert.equal(JSON.stringify(current),before);
  api.S.tracks[0].locked=true;assert.equal(api.setClipTransform('scale','200'),false);assert.equal(JSON.stringify(current),before);
});

test('opacity and both position controls accept decimals and negatives, synchronize both directions, and survive save and undo',async()=>{
  const {api,elements}=editor();const {clip,source}=seed(api);source.kind='video';api.commitHistory();
  for(const [key,prefix,value]of [['opacity','cpOpacity',63.4],['ox','cpOx',-30.5],['oy','cpOy',28.8]]){
    const field=elements.get(prefix+'Number');field.value=String(value);field.listeners.input[0]();field.listeners.change[0]();
    assert.ok(Math.abs(clip[key]-value/100)<1e-9);assert.equal(Number(elements.get(prefix).value),value);
    const slider=elements.get(prefix);slider.value=String(value+1);slider.listeners.input[0]();assert.equal(Number(field.value),value+1);
    slider.value=String(value);slider.listeners.input[0]();slider.listeners.change[0]();
  }
  api.undo();assert.equal(api.S.clips[0].oy,0);api.redo();assert.ok(Math.abs(api.S.clips[0].oy-.288)<1e-9);
  const project=api.buildProject();await api.prepareProject(project);await api.applyProject();
  assert.equal(api.S.clips[0].opacity,.634);assert.equal(api.S.clips[0].ox,-.305);assert.ok(Math.abs(api.S.clips[0].oy-.288)<1e-9);
});

test('numeric transform edits follow keyframes, clamp bounds, protect locked tracks, and do not overwrite unfinished input',()=>{
  const {api,elements,document}=editor();const {clip,source}=seed(api);source.kind='video';
  clip.keyframes={opacity:[{time:1,value:1},{time:9,value:0}],ox:[{time:1,value:-.4},{time:9,value:.4}]};api.S.time=4;
  const field=elements.get('cpOxNumber');document.activeElement=field;field.value='';api.syncTransformInputs(clip);assert.equal(field.value,'');assert.equal(elements.get('cpOpacityNumber').value,50);
  field.value='-12.3';field.listeners.input[0]();assert.equal(field.value,'-12.3');assert.ok(Math.abs(api.animationValue(clip,'ox',5)+.123)<1e-9);
  assert.equal(api.setClipTransform('opacity','0'),true);assert.equal(api.animationValue(clip,'opacity',5),0);
  document.activeElement=null;api.S.time=0;api.refreshKeyframeInspector();assert.equal(elements.get('cpOpacityNumber').value,100);assert.equal(elements.get('cpOxNumber').value,-40);
  assert.equal(api.setClipTransform('oy','999'),true);assert.equal(clip.oy,.5);assert.equal(api.setClipTransform('oy','-999'),true);assert.equal(clip.oy,-.5);
  const before=JSON.stringify(clip);for(const value of ['',' ','invalid',NaN,Infinity])assert.equal(api.setClipTransform('ox',value),false);assert.equal(JSON.stringify(clip),before);
  api.S.tracks[0].locked=true;for(const key of ['scale','opacity','ox','oy'])assert.equal(api.setClipTransform(key,'20'),false);assert.equal(JSON.stringify(clip),before);
});

test('copy and paste retain a snapshot of image/video settings and paste onto the active compatible track at the cursor',()=>{
  const {api}=editor();const {clip,source}=seed(api);source.kind='video';clip.colorKey=api.normalizeColorKey({mode:'green'});clip.scale=1.25;clip.keyframes={ox:[{time:1,value:.1}]};
  api.setSelection([{type:'clip',id:clip.id}]);assert.equal(api.copyTimelineSelection(),true);clip.scale=2;api.addTrack('visual');api.S.time=12;api.commitHistory();
  assert.equal(api.pasteTimelineSelection(),true);const pasted=api.S.clips.at(-1);assert.equal(pasted.trackId,'v2');assert.equal(pasted.start,12);assert.equal(pasted.scale,1.25);assert.equal(pasted.colorKey.mode,'green');assert.equal(pasted.sourceId,clip.sourceId);assert.deepEqual(pasted.keyframes,clip.keyframes);
  api.undo();assert.equal(api.S.clips.length,1);api.redo();assert.equal(api.S.clips.length,2);
});

test('multitrack clipboard keeps group offsets and captions, remaps IDs, and rejects locked or missing-source targets atomically',()=>{
  const {api}=editor();const {clip,source}=seed(api);source.kind='video';api.setSelection([{type:'clip',id:clip.id}]);api.detachAudio();
  const audio=api.S.clips.find(c=>c.audioOnly);audio.start=1;api.createFancyText(api.FANCY_TEXT_PRESETS[0].id);const text=api.S.texts[0];text.start=2;text.end=4;
  api.setSelection([...api.S.clips.map(c=>({type:'clip',id:c.id})),{type:'text',id:text.id}]);api.copyTimelineSelection();api.S.time=20;
  api.S.tracks.find(t=>t.id===audio.trackId).locked=true;api.pasteTimelineSelection();assert.equal(api.S.clips.length,2);assert.equal(api.S.texts.length,1);
  api.S.tracks.find(t=>t.id===audio.trackId).locked=false;assert.equal(api.pasteTimelineSelection(),true);
  const pasted=api.S.clips.slice(2);assert.equal(pasted[0].start,20);assert.equal(pasted[1].start,21);assert.equal(pasted[0].groupId,pasted[1].groupId);assert.notEqual(pasted[0].groupId,clip.groupId);assert.equal(api.S.texts.at(-1).start,22);assert.equal(api.S.texts.at(-1).end,24);
  api.S.sources=[];const count=api.S.clips.length;api.pasteTimelineSelection();assert.equal(api.S.clips.length,count);
});

test('copying adjacent transition clips remaps the link without altering original transition audio',()=>{
  const {api}=editor();const {clip,source}=seed(api);source.kind='video';const next=api.appendClip(source,0,8,'v1');api.insertTransition('fade',clip,next,.5);
  api.setSelection([{type:'clip',id:clip.id},{type:'clip',id:next.id}]);api.copyTimelineSelection();api.S.time=30;api.pasteTimelineSelection();
  const [a,b]=api.S.clips.slice(2);assert.equal(b.transitionIn.fromId,a.id);assert.equal(b.start,37.5);assert.equal(next.transitionIn.fromId,clip.id);
  api.setSelection([{type:'clip',id:next.id}]);api.copyTimelineSelection();api.S.time=50;api.pasteTimelineSelection();assert.equal(api.S.clips.at(-1).transitionIn,undefined);assert.equal(clip.fadeOut,.5);
});

test('green, black and custom color keys match bridge validation and preserve transparent alpha',()=>{
  const {api}=editor();
  for(const value of [undefined,{mode:'green'},{mode:'black'},{color:'#3344AA',similarity:.12,blend:0}])assert.deepEqual(JSON.parse(JSON.stringify(api.normalizeColorKey(value)??null)),nativeColorKey(value)??null);
  for(const value of [{color:"#ff00ff';movie=secret"},{mode:'other'},{mode:'green',similarity:NaN},{mode:'black',blend:2},{mode:'green',similarity:'0.1'}]){
    assert.throws(()=>api.normalizeColorKey(value),/去背景/);assert.throws(()=>nativeColorKey(value),/去背景/);
  }
  const green=api.normalizeColorKey({mode:'green',similarity:.1,blend:.2});
  const pixels=new Uint8ClampedArray([0,255,0,255,255,0,0,128,0,0,255,0,0,180,0,255]);api.keyPixels(pixels,green);
  assert.equal(pixels[3],0);assert.equal(pixels[7],128);assert.equal(pixels[11],0);assert.ok(pixels[15]>0&&pixels[15]<255,'soft edges have partial alpha');
  const black=new Uint8ClampedArray([0,0,0,255,20,20,20,255,255,255,255,255]);api.keyPixels(black,api.normalizeColorKey({mode:'black',blend:0}));
  assert.equal(black[3],0);assert.equal(black[7],0);assert.equal(black[11],255);
});

test('color keys are per clip, undoable, and survive splitting, copying and project restoration',async()=>{
  const {api,elements}=editor(),{source,clip}=seed(api);source.kind='video';api.setSelection([{type:'clip',id:clip.id}]);api.commitHistory();
  api.setClipColorKey('green');assert.equal(clip.colorKey.color,'#00ff00');assert.equal(elements.get('colorKeyOptions').hidden,false);
  api.undo();assert.equal(api.S.clips[0].colorKey,undefined);api.redo();assert.equal(api.S.clips[0].colorKey.mode,'green');
  api.S.time=4;api.splitAtPlayhead();assert.equal(api.S.clips.length,2);assert.ok(api.S.clips.every(c=>c.colorKey.mode==='green'));
  api.setSelection([{type:'clip',id:api.S.clips[1].id}]);api.setClipColorKey('black');assert.equal(api.S.clips[0].colorKey.mode,'green');
  api.duplicateSelected();assert.ok(api.S.clips.some(c=>c.colorKey.mode==='black'));
  const project=api.buildProject();api.validateProject(project);await api.prepareProject(project);await api.applyProject();
  assert.equal(api.S.clips[0].colorKey.mode,'green');assert.equal(api.S.clips[1].colorKey.mode,'black');
  project.clips[0].colorKey.color='bad';assert.throws(()=>api.validateProject(project),/去背景颜色/);
});

test('overlay at playhead creates an upper visual track and moves grouped audio together as one undo step',()=>{
  const {api}=editor(),{source,clip:base}=seed(api);source.kind='video';
  const overlay=api.appendClip(source,0,4);api.setSelection([{type:'clip',id:overlay.id}]);api.setClipColorKey('green');api.detachAudio();
  const audio=api.S.clips.find(c=>c.audioOnly);assert.equal(audio.colorKey,undefined);
  api.setSelection([{type:'clip',id:overlay.id}]);api.S.time=2;api.commitHistory();const original=overlay.start,tracks=api.S.tracks.length;
  api.overlayAtPlayhead();assert.equal(overlay.start,2);assert.equal(audio.start,2);assert.notEqual(overlay.trackId,base.trackId);assert.equal(base.start,0);assert.equal(api.S.tracks.length,tracks+1);
  api.undo();assert.equal(api.S.clips.find(c=>c.id===overlay.id).start,original);assert.equal(api.S.tracks.length,tracks);
  api.setSelection([{type:'clip',id:overlay.id}]);api.S.tracks.find(t=>t.id===api.S.clips.find(c=>c.id===overlay.id).trackId).locked=true;
  api.setClipColorKey('black');assert.equal(api.S.clips.find(c=>c.id===overlay.id).colorKey.mode,'green');
  api.overlayAtPlayhead();assert.equal(api.S.tracks.length,tracks);
});

test('old bridges cannot silently export a keyed clip without its background removal',async()=>{
  const {api,elements}=editor(),{source,clip}=seed(api);source.kind='video';source.bridgeId='uploaded';api.bridge.base='http://127.0.0.1:8787';api.bridge.info={};
  clip.colorKey=api.normalizeColorKey({mode:'green'});await api.startExport();
  assert.match(elements.get('toast').textContent,/重启.*去背景/);assert.equal(api.S.rendering,false);
});

function savedFileProject(file=mediaFile()){
  const {api}=editor(),source={id:'saved',kind:api.mediaKind(file),name:file.name,fileName:file.name,size:file.size,duration:file.duration,width:1920,height:1080,lastModified:file.lastModified};
  api.S.sources.push(source);api.appendClip(source,2,8);
  return JSON.parse(JSON.stringify(api.buildProject()));
}
function referenceDatabase(records=[]){
  const saved=new Map(records.map(record=>[record.id,record]));
  return {saved,open(){
    const request={};queueMicrotask(()=>{
      request.result={close(){},transaction(){
        const tx={objectStore(){return {
          getAll(){return {result:[...saved.values()]};},
          put(value){saved.set(value.id,value);return {result:value.id};},
        };}};
        queueMicrotask(()=>tx.oncomplete?.());return tx;
      }};request.onsuccess?.();
    });return request;
  }};
}

test('relinking the original file leaves current tracks and history intact until apply, and can be undone',async()=>{
  const project=savedFileProject(),{api,elements}=editor(),{source}=seed(api);source.kind='video';api.commitHistory();
  const before={sources:api.S.sources,clips:api.S.clips,tracks:api.S.tracks,selected:api.S.selected,history:api.history.entries.length};
  await api.prepareProject(project);assert.equal(elements.get('btnApplyProject').disabled,true);
  await api.relinkProjectFiles([mediaFile()]);assert.equal(elements.get('btnApplyProject').disabled,false);
  assert.equal(api.S.sources,before.sources);assert.equal(api.S.clips,before.clips);assert.equal(api.S.tracks,before.tracks);assert.equal(api.S.selected,before.selected);assert.equal(api.history.entries.length,before.history);
  assert.equal(api.projectState.pending.loaded.size,1);await api.applyProject();
  assert.equal(api.S.sources[0].name,'original.mp4');assert.equal(api.S.clips[0].in,2);assert.equal(api.S.clips[0].out,8);
  api.undo();assert.equal(api.S.sources[0],source);
});

test('file matching accepts Unicode-normalized names and unique renamed or resized replacements without guessing ambiguous pairs',()=>{
  const {api}=editor(),descriptors=[{id:'one',name:'Café.mp4',kind:'video',size:4}];
  const normalized=mediaFile({name:'CAFE\u0301.MP4',size:4});assert.equal(api.matchProjectFiles(descriptors,[normalized]).get('one'),normalized);
  const resized=mediaFile({name:'Café.mp4',size:8});assert.equal(api.matchProjectFiles(descriptors,[resized]).get('one'),resized);
  const renamed=mediaFile({name:'replacement.mp4',size:8});assert.equal(api.matchProjectFiles(descriptors,[renamed]).get('one'),renamed);
  const other={id:'two',name:'different.mp4',kind:'video',size:6};
  assert.equal(api.matchProjectFiles([...descriptors,other],[renamed,mediaFile({name:'other.mp4'})]).size,0);
  assert.equal(api.matchProjectFiles([...descriptors,{...descriptors[0],id:'two',size:6}],[resized]).size,0);
});

test('a row can explicitly replace a renamed file; wrong types and short files show actionable errors',async()=>{
  const {api,elements}=editor();await api.prepareProject(savedFileProject());
  await api.relinkProjectFiles([mediaFile({name:'new.wav',type:'audio/wav'})],'saved');
  assert.match(api.projectState.pending.errors.get('saved'),/类型不符/);assert.equal(elements.get('btnApplyProject').disabled,true);
  await api.relinkProjectFiles([mediaFile({name:'short.mp4',duration:4})],'saved');
  assert.match(api.projectState.pending.errors.get('saved'),/时长不足/);assert.equal(elements.get('btnApplyProject').disabled,true);
  await api.relinkProjectFiles([mediaFile({name:'renamed.mp4',size:9000})],'saved');
  assert.equal(api.projectState.pending.errors.size,0);assert.equal(elements.get('btnApplyProject').disabled,false);
  await api.applyProject();assert.equal(api.S.sources[0].fileName,'renamed.mp4');
  assert.equal(api.buildProject().sources[0].fileName,'renamed.mp4');
});

test('failed decoding and cancelling relink release new media without changing or releasing the active project',async()=>{
  const {api,revoked,elements}=editor(),{source}=seed(api);source.kind='video';
  await api.prepareProject(savedFileProject());await api.relinkProjectFiles([mediaFile({failure:true})]);
  assert.match(api.projectState.pending.errors.get('saved'),/打不开/);assert.equal(api.S.sources[0],source);
  assert.equal(elements.get('btnApplyProject').disabled,true);assert.equal(api.S.busy,false);
  await api.relinkProjectFiles([mediaFile()]);const linked=api.projectState.pending.loaded.get('saved');
  api.closeProjectDialog();assert.equal(linked.el.removed,true);assert.ok(revoked.includes(linked.url));assert.ok(!revoked.includes(source.url));
  assert.equal(api.S.sources[0],source);assert.equal(api.projectState.pending,null);
});

test('batch relink restores mixed media without adding default tracks or skipping unmatched rows',async()=>{
  const project=savedFileProject(),audio=mediaFile({name:'music.wav',type:'audio/wav',size:800});
  const image=mediaFile({name:'cover.png',type:'image/png',size:500});
  project.sources.push({id:'music',name:audio.name,kind:'audio',size:audio.size,duration:12});
  project.sources.push({id:'cover',name:image.name,kind:'image',size:image.size,duration:86400});project.clips.push({id:'image',sourceId:'cover',trackId:'v1',start:6,in:0,out:5});
  project.tracks.push({id:'a1',name:'音频1',kind:'audio'});project.clips.push({id:'audio',sourceId:'music',trackId:'a1',start:0,in:0,out:6});
  const {api,elements}=editor();await api.prepareProject(project);
  await api.relinkProjectFiles([mediaFile()]);assert.equal(api.projectState.pending.loaded.size,1);assert.equal(elements.get('btnApplyProject').disabled,true);
  await api.relinkProjectFiles([audio,image]);assert.equal(api.S.tracks.length,1);assert.equal(api.S.clips.length,0);
  await api.applyProject();assert.equal(api.S.tracks.length,2);assert.equal(api.S.clips.length,3);assert.equal(api.S.clips[2].trackId,'a1');assert.equal(api.S.sources.find(s=>s.kind==='image').fileName,'cover.png');
});

test('authorized file references survive a browser session and restore a saved project automatically',async()=>{
  const file=mediaFile(),db=referenceDatabase(),handle={async getFile(){return file;},async queryPermission(){return 'granted';}};
  const first=editor({browser:{indexedDB:db,showOpenFilePicker:async()=>[handle]}}),files=await first.api.chooseMediaFiles();
  const source=await first.api.loadSourceFile(files[0]);first.api.S.sources.push(source);first.api.appendClip(source,2,8);
  const project=JSON.parse(JSON.stringify(first.api.buildProject()));assert.ok(project.sources[0].fileHandleId);assert.equal(project.sources[0].lastModified,file.lastModified);
  assert.ok(!JSON.stringify(project).includes('handle"'));assert.equal(db.saved.size,1);
  const next=editor({browser:{indexedDB:db}});await next.api.prepareProject(project);
  assert.equal(next.api.projectState.pending.loaded.size,1);assert.equal(next.elements.get('btnApplyProject').disabled,false);
  await next.api.applyProject();assert.equal(next.api.S.sources[0].fileName,file.name);
});

test('permission prompts wait for an explicit click; denied or missing files allow manual replacement',async()=>{
  const file=mediaFile(),project=savedFileProject(),record={id:'remembered',name:file.name,size:file.size,kind:'video',lastModified:file.lastModified};
  project.sources[0].fileHandleId=record.id;
  let requested=0,permission='prompt';record.handle={async getFile(){return file;},async queryPermission(){return permission;},async requestPermission(){requested++;return 'granted';}};
  const {api,elements}=editor({browser:{indexedDB:referenceDatabase([record])}});
  await api.prepareProject(project);assert.equal(requested,0);assert.equal(api.projectState.pending.handles.size,1);assert.equal(elements.get('btnApplyProject').disabled,true);
  await api.authorizeProjectSource('saved');assert.equal(requested,1);assert.equal(api.projectState.pending.loaded.size,1);
  api.closeProjectDialog();permission='denied';await api.prepareProject(project);assert.equal(requested,1);assert.match(api.projectState.pending.errors.get('saved'),/授权已失效/);
  await api.relinkProjectFiles([mediaFile({name:'moved.mp4'})],'saved');assert.equal(elements.get('btnApplyProject').disabled,false);
  api.closeProjectDialog();permission='granted';record.handle.getFile=async()=>{throw Object.assign(Error('not found'),{name:'NotFoundError'});};
  await api.prepareProject(project);assert.match(api.projectState.pending.errors.get('saved'),/已移动或删除/);assert.equal(elements.get('btnApplyProject').disabled,true);
});

test('changed files require manual confirmation and blocked handle storage never blocks ordinary relinking',async()=>{
  const file=mediaFile(),project=savedFileProject(),record={id:'changed',name:file.name,size:file.size,kind:'video',handle:{async queryPermission(){return 'granted';},async getFile(){return {...file,lastModified:456};}}};
  project.sources[0].fileHandleId=record.id;
  const {api}=editor({browser:{indexedDB:referenceDatabase([record])}});await api.prepareProject(project);
  assert.equal(api.projectState.pending.loaded.size,0);assert.match(api.projectState.pending.errors.get('saved'),/已修改/);
  const blocked=editor({browser:{indexedDB:{open(){throw Error('blocked');}}}});await blocked.api.prepareProject(project);
  await blocked.api.relinkProjectFiles([file]);assert.equal(blocked.api.projectState.pending.loaded.size,1);
});

test('old projects can reuse a unique authorized reference, but duplicate remembered names require a choice',async()=>{
  const file=mediaFile(),project=savedFileProject(),record={id:'legacy',name:file.name,size:file.size,kind:'video',lastModified:file.lastModified,handle:{async queryPermission(){return 'granted';},async getFile(){return file;}}};
  const {api}=editor({browser:{indexedDB:referenceDatabase([record])}});await api.prepareProject(project);assert.equal(api.projectState.pending.loaded.size,1);
  const ambiguous=editor({browser:{indexedDB:referenceDatabase([record,{...record,id:'duplicate'}])}});await ambiguous.api.prepareProject(project);assert.equal(ambiguous.api.projectState.pending.loaded.size,0);
  assert.equal(await editor().api.chooseMediaFiles(),null);
  const cancelled=editor({browser:{showOpenFilePicker:async()=>{throw Object.assign(Error('cancelled'),{name:'AbortError'});}}});
  assert.equal((await cancelled.api.chooseMediaFiles()).length,0);assert.equal(cancelled.api.S.sources.length,0);
});

test('transition assets become selectable boundary items and replacement/removal are undoable',()=>{
  const {api}=editor(),{source,clip}=seed(api);source.kind='video';clip.fadeOut=.2;
  const next=api.appendClip(source,0,8,'v1');next.fadeIn=.1;api.commitHistory();
  assert.equal(api.transitionCuts().length,1);api.insertTransition('wipeleft',clip,next,.8);api.S.selected={type:'transition',id:next.id+':in'};api.commitHistory();
  const item=api.selectedTransition();assert.equal(item.from,clip);assert.equal(item.type,'wipeleft');assert.equal(item.start,7.2);assert.equal(item.end,8);
  api.insertTransition('slideleft',clip,next,1.2);assert.equal(next.start,6.8);assert.equal(api.transitionItems().length,1);
  api.removeTransition(api.selectedTransition());api.commitHistory();assert.equal(next.start,8);assert.equal(next.transitionIn,undefined);assert.equal(clip.fadeOut,.2);assert.equal(next.fadeIn,.1);
  api.undo();assert.equal(api.transitionItems()[0].type,'wipeleft');api.redo();assert.equal(api.transitionItems().length,0);
});

test('transition links survive project restore with remapped clip IDs',async()=>{
  const {api}=editor(),{source,clip}=seed(api);source.kind='video';const next=api.appendClip(source,0,8,'v1');api.insertTransition('fade',clip,next,.6);
  const project=api.buildProject();api.validateProject(project);await api.prepareProject(project);await api.applyProject();api.reconcileLinkedTransitions();
  assert.equal(api.transitionItems().length,1);assert.equal(api.transitionItems()[0].from.id,api.S.clips[0].id);assert.notEqual(api.S.clips[0].id,clip.id);assert.equal(api.S.clips[1].start,7.4);
});

test('deleting a linked clip clears its transition and restores the other audio envelope',()=>{
  const {api}=editor(),{source,clip}=seed(api);source.kind='video';clip.fadeOut=.2;const next=api.appendClip(source,0,8,'v1');api.insertTransition('fade',clip,next,.5);
  api.S.selected={type:'clip',id:next.id};api.deleteSelected();api.reconcileLinkedTransitions();assert.equal(api.S.clips.length,1);assert.equal(api.transitionItems().length,0);assert.equal(clip.fadeOut,.2);
});

test('transition preview playback stops at its range instead of playing the whole timeline',async()=>{
  const {api,frames,clock}=editor();seed(api);api.S.time=2;const playback=api.togglePlay({end:3});await untilFrame(frames);clock.time=1500;frames.shift()();await playback;assert.equal(api.S.time,3);assert.equal(api.S.playing,false);
});

test('moving clips apart detaches a transition without moving unrelated media',()=>{
  const {api}=editor(),{source,clip}=seed(api);source.kind='video';const next=api.appendClip(source,0,8,'v1');api.insertTransition('fade',clip,next,.5);next.start=20;api.reconcileLinkedTransitions();assert.equal(next.start,20);assert.equal(next.transitionIn,undefined);assert.equal(clip.fadeOut,0);
});

test('older overlapping clip effects migrate to visible linked transition items',()=>{
  const {api}=editor(),{source,clip}=seed(api);source.kind='video';const next=api.appendClip(source,0,8,'v1');next.start=7.5;next.transitionIn={type:'fade',duration:.5};next.fadeIn=.5;clip.fadeOut=.5;
  api.reconcileLinkedTransitions();assert.equal(next.transitionIn.fromId,clip.id);api.removeTransition(api.transitionItems()[0]);assert.equal(next.start,8);assert.equal(clip.fadeOut,0);assert.equal(next.fadeIn,0);
});

test('fancy type is editable timed text, supports standalone projects and undo',()=>{
  const {api,elements}=editor();const text=api.createFancyText('neon-purple');assert.equal(api.S.clips.length,0);assert.equal(api.totalDuration(),4);assert.equal(text.effect,'neon');
  elements.get('txContent').value='换成我的标题';for(const handler of elements.get('txContent').listeners.input)handler();assert.equal(text.content,'换成我的标题');assert.equal(text.glow,28);
  elements.get('txEnd').value='10';for(const handler of elements.get('txEnd').listeners.input)handler();assert.equal(text.end,10);api.commitHistory();api.undo();assert.equal(api.S.texts[0].end,4);api.undo();assert.equal(api.S.texts.length,0);
});

test('applying fancy styles preserves content and timing and basic presets clear advanced effects',()=>{
  const {api}=editor();const text=api.createFancyText('ice');text.content='自定义标题';text.start=1;text.end=7;api.applyFancyToSelected('neon-blue');assert.equal(text.content,'自定义标题');assert.equal(text.start,1);assert.equal(text.end,7);assert.equal(text.effect,'neon');
  api.applyTextPreset(text,api.TEXT_PRESETS[0]);for(const key of ['effect','glow','glowColor','depth','gradientColor','outlineWidth'])assert.equal(text[key],undefined,key);
});

test('fancy text styling round-trips through project save/load',async()=>{
  const {api}=editor();api.createFancyText('gold');const project=api.buildProject();api.validateProject(project);await api.prepareProject(project);await api.applyProject();assert.equal(api.S.texts[0].effect,'gold');assert.equal(api.S.texts[0].gradientColor,'#dc8c22');assert.equal(api.S.texts[0].depth,4);
});

test('thirty distinct fancy presets serialize and restore their editable typography',async()=>{
  const {api}=editor();assert.equal(api.FANCY_TEXT_PRESETS.length,30);assert.equal(new Set(api.FANCY_TEXT_PRESETS.map(p=>p.id)).size,30);
  for(const preset of api.FANCY_TEXT_PRESETS)api.createFancyText(preset.id);
  const project=api.buildProject();api.validateProject(project);await api.prepareProject(project);await api.applyProject();
  assert.equal(api.S.texts.length,30);assert.equal(api.S.texts.find(t=>t.presetId==='hollow').effect,'outline');assert.equal(api.S.texts.find(t=>t.presetId==='duotone').accentColor,'#ff588f');assert.equal(api.S.texts.find(t=>t.presetId==='sport').italic,true);assert.equal(api.S.texts.find(t=>t.presetId==='bookish').fontFace,'serif');assert.equal(api.S.texts.find(t=>t.presetId==='highlight').underline,true);
});

test('material search combines category, Chinese names and English IDs',()=>{
  const {api}=editor();assert.equal(api.filterLibraryItems(api.FANCY_TEXT_PRESETS,'neon','',api.FANCY_CATEGORIES).length,4);
  assert.equal(api.filterLibraryItems(api.FANCY_TEXT_PRESETS,'','宋体',api.FANCY_CATEGORIES)[0].id,'bookish');assert.equal(api.filterLibraryItems(api.FANCY_TEXT_PRESETS,'','DUOTONE',api.FANCY_CATEGORIES)[0].id,'duotone');assert.equal(api.filterLibraryItems(api.FANCY_TEXT_PRESETS,'neon','宋体',api.FANCY_CATEGORIES).length,0);
});

test('112 unique sticker PNGs match the embedded atlas and preserve old project IDs',()=>{
  const {api}=editor(),manifest=JSON.parse(readFileSync(new URL('../assets/stickers/sticker-atlas-112.json',import.meta.url),'utf8'));
  assert.equal(api.STICKER_ASSETS.length,112);assert.equal(manifest.frames.length,112);assert.equal(new Set(manifest.frames.map(f=>f.id)).size,112);
  assert.deepEqual(JSON.parse(JSON.stringify(api.STICKER_ATLAS_SIZE)),manifest.size);const cells=new Set(),hashes=new Set();
  for(const frame of manifest.frames){assert.ok(frame.x>=0&&frame.y>=0&&frame.x+frame.w<=manifest.size.w&&frame.y+frame.h<=manifest.size.h);cells.add(frame.x+':'+frame.y);const png=readFileSync(new URL('../assets/stickers/'+frame.file,import.meta.url));assert.equal(png.readUInt32BE(16),256);assert.equal(png.readUInt32BE(20),256);assert.equal(png[25],6,'RGBA: '+frame.id);hashes.add(createHash('sha256').update(png).digest('hex'));}
  assert.equal(cells.size,112);assert.equal(hashes.size,112);
  for(const category of Object.keys(manifest.categories))assert.equal(api.filterLibraryItems(api.STICKER_ASSETS,category,'',api.STICKER_CATEGORIES).length,16,category);
  for(const id of ['heart','like','stars','rocket'])assert.ok(api.STICKER_ASSETS.some(item=>item.id===id));
});

test('stickers use upper visual tracks and restore from atlas IDs without embedding image bytes',async()=>{
  const {api}=editor();const clip=await api.createSticker('heart',{at:2});assert.ok(clip);assert.equal(clip.trackId,'v1');assert.equal(clip.start,2);assert.equal(clip.scale,.28);
  const project=api.buildProject({draft:true});assert.equal(project.sources[0].stickerId,'heart');assert.equal(project.sources[0].inlineImage,undefined);api.validateProject(project);
  api.S.sources=[];api.S.clips=[];await api.prepareProject(project);await api.applyProject();assert.equal(api.S.sources[0].stickerId,'heart');assert.equal(api.S.clips[0].start,2);assert.equal(api.S.sources[0].kind,'image');
});

test('stickers create an upper track when existing footage occupies the highest visual track',async()=>{
  const {api}=editor();const {clip}=seed(api);const sticker=await api.createSticker('stars');assert.equal(sticker.trackId,'v2');assert.equal(api.S.tracks.filter(t=>t.kind==='visual')[0].id,'v2');
});

test('invalid project references and settings cannot replace the current timeline',()=>{
  const {api}=editor(),{source}=seed(api);source.kind='video';const project=api.buildProject();
  project.clips[0].trackId='missing';assert.throws(()=>api.validateProject(project),/引用/);project.clips[0].trackId='v1';
  project.settings.aspect='javascript:bad';assert.throws(()=>api.validateProject(project),/设置/);assert.equal(api.S.clips.length,1);
});

test('canvas presets determine output size and preserve portrait and square ratios',()=>{
  const {api}=editor();api.settings.aspect='portrait';api.settings.size='1280';assert.equal(api.outputSize().h,1280);assert.equal(api.outputSize().w,720);
  api.settings.aspect='square';assert.equal(api.outputSize().w,api.outputSize().h);
});

test('playback crosses a split boundary once without seeking back', async () => {
  const {api,frames,clock} = editor();
  const media=playbackMedia(81),source={id:'shared',duration:200,el:media};
  api.S.sources.push(source); api.appendClip(source,10,90); api.appendClip(source,90,200);
  api.S.time=71;
  const playback=api.togglePlay();
  try {
    await untilFrame(frames);
    media.advance(90); clock.time+=9000; frames.shift()();
    await untilFrame(frames);
    assert.equal(api.S.time,80);
    for(let n=0;n<20 && media.playStarts.length<2;n++)await Promise.resolve();
    assert.deepEqual(media.playStarts,[81,90]);
    media.advance(91); clock.time+=1000; frames.shift()();
    assert.equal(api.S.time,81);
  } finally { await pausePlayback(api,frames,playback); }
});

test('inactive media does not change current playback or start early', async () => {
  const {api,frames} = editor();
  const first=playbackMedia(60),next=playbackMedia(0);
  const sourceA={id:'a',duration:100,el:first},sourceB={id:'b',duration:100,el:next};
  api.S.sources.push(sourceA,sourceB); api.appendClip(sourceA,0,100); api.appendClip(sourceB,20,80);
  api.S.time=60;
  const playback=api.togglePlay();
  try {
    await untilFrame(frames);
    assert.equal(api.S.time,60); assert.equal(first.currentTime,60); assert.equal(next.currentTime,0);assert.deepEqual(next.playStarts,[]);
  } finally { await pausePlayback(api,frames,playback); }
});
