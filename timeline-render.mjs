import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const bounded = (value,min,max,fallback=0) => Number.isFinite(Number(value)) ? Math.min(max,Math.max(min,Number(value))) : fallback;
const decimal = value => Number(value).toFixed(4);
const transition=(value,length)=>({type:['fade','wipeleft','wiperight','slideleft','slideright'].includes(value?.type)?value.type:'none',duration:bounded(value?.duration??.5,.01,Math.max(.01,length/2),Math.min(.5,Math.max(.01,length/2)))});

/** Compose independent, timed layers over a black canvas and mix their audio. */
export async function renderTimeline(job,{ffmpeg,run,overlays,work}) {
  const total = Math.max(Number(job.duration)||0,...job.clips.map(c=>c.start+c.out-c.in),...job.texts.map(t=>t.end));
  if (!(total>0)) throw new Error('时间线是空的');
  job.duration=total;
  const args=['-hide_banner','-loglevel','error','-stats','-stats_period','0.3','-nostdin','-y'];
  for(const clip of job.clips){
    const duration=clip.out-clip.in;
    if(clip.kind==='image') args.push('-loop','1','-t',decimal(duration),'-i',clip.path);
    else args.push('-ss',decimal(clip.in),'-t',decimal(duration),'-i',clip.path);
  }
  for(const text of job.texts)args.push('-loop','1','-t',decimal(total),'-i',overlays.get(text.id).path);
  const W=job.width,H=job.height;
  const filters=[`color=c=black:s=${W}x${H}:r=${job.fps}:d=${decimal(total)},setsar=1[base]`];
  let video='base';
  const visual=job.clips.map((clip,index)=>({clip,index})).filter(({clip})=>clip.kind!=='audio').sort((a,b)=>a.clip.layer-b.clip.layer||a.clip.start-b.clip.start);
  for(const {clip,index} of visual){
    const duration=clip.out-clip.in,scale=bounded(clip.scale,.1,3,1),opacity=bounded(clip.opacity,0,1,1);
    const x=Math.round(bounded(clip.ox,-.5,.5)*W),y=Math.round(bounded(clip.oy,-.5,.5)*H);
    const enter=transition(clip.transitionIn,duration),leave=transition(clip.transitionOut,duration),effects=[];
    const p=`clip(T/${decimal(enter.duration)},0,1)`,q=`clip((T-${decimal(duration-leave.duration)})/${decimal(leave.duration)},0,1)`;
    if(enter.type==='fade')effects.push(`fade=t=in:st=0:d=${decimal(enter.duration)}:alpha=1`);
    if(leave.type==='fade')effects.push(`fade=t=out:st=${decimal(duration-leave.duration)}:d=${decimal(leave.duration)}:alpha=1`);
    const masks=[];
    if(enter.type==='wipeleft')masks.push(`lte(X/W,${p})`);if(enter.type==='wiperight')masks.push(`gte(X/W,1-${p})`);
    if(leave.type==='wipeleft')masks.push(`gte(X/W,${q})`);if(leave.type==='wiperight')masks.push(`lte(X/W,1-${q})`);
    if(masks.length)effects.push(`geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*${masks.join('*')}'`);
    const progress=`clip((t-${decimal(clip.start)})/${decimal(enter.duration)},0,1)`,outProgress=`clip((t-${decimal(clip.start+duration-leave.duration)})/${decimal(leave.duration)},0,1)`;
    let move='';if(enter.type==='slideleft')move+=`+W*(1-${progress})`;if(enter.type==='slideright')move+=`-W*(1-${progress})`;
    if(leave.type==='slideleft')move+=`-W*${outProgress}`;if(leave.type==='slideright')move+=`+W*${outProgress}`;
    filters.push(`[${index}:v]trim=duration=${decimal(duration)},setpts=PTS-STARTPTS,`+
      `scale=${W}:${H}:force_original_aspect_ratio=decrease,`+
      `scale=w='max(2,trunc(iw*${decimal(scale)}/2)*2)':h='max(2,trunc(ih*${decimal(scale)}/2)*2)',`+
      `setsar=1,fps=${job.fps},format=rgba,colorchannelmixer=aa=${decimal(opacity)},${effects.length?effects.join(',')+',':''}setpts=PTS+${decimal(clip.start)}/TB[layer${index}]`);
    const next='composite'+index;
    filters.push(`[${video}][layer${index}]overlay=x='(W-w)/2+${x}${move}':y=(H-h)/2+${y}:`+
      `enable='gte(t,${decimal(clip.start)})*lt(t,${decimal(clip.start+duration)})':eof_action=pass:repeatlast=0[${next}]`);
    video=next;
  }
  job.texts.forEach((text,index)=>{
    const next='text'+index;
    filters.push(`[${video}][${job.clips.length+index}:v]overlay=0:0:`+
      `enable='gte(t,${decimal(text.start)})*lt(t,${decimal(text.end)})':eof_action=pass[${next}]`);
    video=next;
  });
  filters.push(`[${video}]format=yuv420p[vout]`);
  filters.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${decimal(total)}[silence]`);
  const audio=[];
  job.clips.forEach((clip,index)=>{
    const volume=bounded(clip.volume,0,2,1);
    if(!clip.hasAudio||clip.muted||!volume)return;
    const duration=clip.out-clip.in,fi=bounded(clip.fadeIn,0,duration),fo=bounded(clip.fadeOut,0,duration);
    const parts=[`atrim=duration=${decimal(duration)}`,'asetpts=PTS-STARTPTS','aresample=48000',
      'aformat=sample_fmts=fltp:channel_layouts=stereo',`volume=${decimal(volume)}`];
    if(fi)parts.push(`afade=t=in:st=0:d=${decimal(fi)}`);
    if(fo)parts.push(`afade=t=out:st=${decimal(duration-fo)}:d=${decimal(fo)}`);
    parts.push(`adelay=${Math.round(clip.start*1000)}:all=1`);
    filters.push(`[${index}:a]${parts.join(',')}[audio${index}]`);audio.push(`[audio${index}]`);
  });
  filters.push(audio.length
    ? `[silence]${audio.join('')}amix=inputs=${audio.length+1}:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.95:level=0:latency=1[aout]`
    : '[silence]anull[aout]');
  const script=join(work,'timeline-filter.txt');
  await writeFile(script,filters.join(';\n'),'utf8');
  args.push('-filter_complex_threads','1','-filter_complex_script',script,'-map','[vout]','-map','[aout]',
    '-t',decimal(total),'-c:v','libx264','-preset',job.preset,'-crf',String(job.crf),'-pix_fmt','yuv420p',
    '-c:a','aac','-b:a','192k','-ar','48000','-ac','2','-movflags','+faststart',job.outPath);
  await run(ffmpeg,args,{onStderr:chunk=>{
    const match=/time=(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(chunk);
    if(match)job.progress=Math.max(job.progress,Math.min(.99,(Number(match[1])*3600+Number(match[2])*60+Number(match[3]))/total));
  }});
}
