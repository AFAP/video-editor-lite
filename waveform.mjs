import { spawn } from 'node:child_process';

// Stream PCM into a fixed-size envelope; even a long video never buffers full audio.
export function extractWaveform(ffmpeg, source, bins=4096) {
  if (source.hasAudio === false) return Promise.resolve({duration:source.duration,peaks:[],hasAudio:false});
  return new Promise((resolve,reject) => {
    const peaks=new Float32Array(bins),rate=8000,total=Math.max(1,Math.ceil(source.duration*rate));
    let sample=0,carry=null,error='',settled=false;
    const child=spawn(ffmpeg,['-v','error','-nostdin','-i',source.path,'-vn','-ac','1','-ar',String(rate),'-f','s16le','pipe:1'],{windowsHide:true});
    const timer=setTimeout(()=>{child.kill();finish(Error('波形解析超时，可稍后重试'));},120000);
    function finish(failure){if(settled)return;settled=true;clearTimeout(timer);failure?reject(failure):resolve({duration:source.duration,peaks:Array.from(peaks),hasAudio:true});}
    const accept=value=>{const index=Math.min(bins-1,Math.floor(sample++/total*bins));peaks[index]=Math.max(peaks[index],Math.abs(value)/32768);};
    child.stdout.on('data',chunk=>{
      let i=0;
      if(carry!==null&&chunk.length){accept((carry|(chunk[0]<<8))<<16>>16);carry=null;i=1;}
      for(;i+1<chunk.length;i+=2)accept(chunk.readInt16LE(i));
      if(i<chunk.length)carry=chunk[i];
    });
    child.stderr.on('data',chunk=>{error=(error+chunk).slice(-2000);});
    child.on('error',finish);
    child.on('close',code=>finish(code===0?null:Error(error.trim()||'无法读取素材音轨')));
  });
}
