// Static visual settings. Animation continues to use source-relative keyframes.
export function normalizeVisualTransform(clip={}) {
  const fit=clip.fit??'contain',rotation=clip.rotation??0;
  if(!['contain','cover'].includes(fit))throw Error('画面适配方式无效');
  if(!Number.isFinite(rotation)||rotation < -180||rotation > 180)throw Error('旋转角度需为 -180～180 度');
  for(const key of ['flipX','flipY'])if(clip[key]!==undefined&&typeof clip[key]!=='boolean')throw Error('画面翻转参数无效');
  return {fit,rotation,flipX:clip.flipX===true,flipY:clip.flipY===true};
}

export function visualGeometry(iw,ih,W,H,clip={}) {
  const angle=(Number(clip.rotation)||0)*Math.PI/180,c=Math.abs(Math.cos(angle)),s=Math.abs(Math.sin(angle));
  const bw=iw*c+ih*s,bh=iw*s+ih*c;
  const k=(clip.fit==='cover'?Math.max((W*c+H*s)/iw,(W*s+H*c)/ih):Math.min(W/bw,H/bh))*(Number(clip.scale)||1);
  return {angle,k,dw:iw*k,dh:ih*k,bw:bw*k,bh:bh*k};
}
