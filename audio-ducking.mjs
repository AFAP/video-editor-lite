// Track configuration and source-relative gain envelopes, shared with the single page.
export const MAX_DUCKING_POINTS=16384;
export function normalizeDuckingConfig(value){
  if(value==null)return undefined;
  if(typeof value!=='object'||Array.isArray(value)||!Array.isArray(value.voiceTrackIds)||!value.voiceTrackIds.length||value.voiceTrackIds.length>300||value.voiceTrackIds.some(id=>typeof id!=='string'||!/^[va]\d+$/.test(id)))throw Error('人声轨道配置无效');
  const result={voiceTrackIds:[...new Set(value.voiceTrackIds)]};
  for(const [key,min,max,fallback]of [['level',0,1,.25],['attack',.01,3,.15],['release',.01,5,.5],['hold',0,3,.2],['threshold',.001,1,.02]]){
    const number=value[key]??fallback;if(!Number.isFinite(number)||number<min||number>max)throw Error('人声避让参数无效');result[key]=number;
  }
  if(value.useWaveform!==undefined&&typeof value.useWaveform!=='boolean')throw Error('停顿检测参数无效');
  result.useWaveform=value.useWaveform!==false;return result;
}
export function normalizeDuckingPoints(points){
  if(points===undefined)return [];
  if(!Array.isArray(points)||points.length>MAX_DUCKING_POINTS)throw Error('人声避让曲线数量无效');
  let previous=-1;
  return points.map(point=>{if(!point||!Number.isFinite(point.time)||point.time<0||point.time>864000||point.time<=previous||!Number.isFinite(point.value)||point.value<0||point.value>1)throw Error('人声避让曲线数值无效');previous=point.time;return {time:point.time,value:point.value};});
}
export function duckingGain(points,time){
  if(!points?.length)return 1;
  if(time<=points[0].time)return points[0].value;
  if(time>=points.at(-1).time)return points.at(-1).value;
  let lo=0,hi=points.length-1;
  while(hi-lo>1){const mid=(lo+hi)>>1;if(points[mid].time<=time)lo=mid;else hi=mid;}
  const a=points[lo],b=points[hi];return a.value+(b.value-a.value)*(time-a.time)/(b.time-a.time);
}
export function buildDuckingEnvelope(intervals,config){
  const {attack,release,hold,level}=config,merged=[];
  for(const [a,b]of intervals.filter(([a,b])=>Number.isFinite(a)&&Number.isFinite(b)&&a>=0&&b>a).sort((x,y)=>x[0]-y[0])){
    const last=merged.at(-1);if(last&&a-last[1]<=hold+release+attack+.000001)last[1]=Math.max(last[1],b);else merged.push([a,b]);
  }
  // Bound filter size on very long projects by combining only the shortest pauses.
  let simplified=0;
  if(merged.length>1000){
    const joins=new Set(merged.slice(1).map((row,index)=>({index,gap:row[0]-merged[index][1]})).sort((a,b)=>a.gap-b.gap||a.index-b.index).slice(0,merged.length-1000).map(row=>row.index));
    const compact=[];for(let i=0;i<merged.length;i++){if(i&&joins.has(i-1)){compact.at(-1)[1]=merged[i][1];simplified++;}else compact.push(merged[i]);}merged.splice(0,merged.length,...compact);
  }
  const values=new Map();
  const point=(time,value)=>{time=Math.max(0,time);values.set(time,Math.min(value,values.get(time)??1));};
  for(const [a,b]of merged){point(a-attack,1);point(a,level);point(b+hold,level);point(b+hold+release,1);}
  return {points:[...values].sort((a,b)=>a[0]-b[0]).map(([time,value])=>({time,value})),intervals:merged,simplified};
}
export function clipDuckingEnvelope(points,clip){
  if(!points?.length)return [];
  const start=clip.start,end=start+clip.out-clip.in,values=new Map([[clip.in,duckingGain(points,start)],[clip.out,duckingGain(points,end)]]);
  for(const point of points)if(point.time>start&&point.time<end)values.set(clip.in+point.time-start,point.value);
  const result=[...values].sort((a,b)=>a[0]-b[0]).map(([time,value])=>({time,value}));
  return result.some(p=>p.value<1-.000001)?result:[];
}
export function duckingExpression(points,variable='t',offset=0){
  if(!points?.length)return '1';
  if(points.length===1)return String(points[0].value);
  const time=`(${variable}+${Number(offset)||0})`;
  const piece=(lo,hi)=>{
    if(lo===hi){const a=points[lo],b=points[lo+1];return a.value===b.value?String(a.value):`${a.value}+(${b.value-a.value})*(${time}-${a.time})/${b.time-a.time}`;}
    const mid=(lo+hi)>>1;return `if(lt(${time},${points[mid+1].time}),${piece(lo,mid)},${piece(mid+1,hi)})`;
  };
  return `if(lte(${time},${points[0].time}),${points[0].value},if(gte(${time},${points.at(-1).time}),${points.at(-1).value},${piece(0,points.length-2)}))`;
}
