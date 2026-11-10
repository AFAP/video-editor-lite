/** Keep user values out of filter expressions; the single-page renderer uses the same schema. */
export function normalizeColorKey(value) {
  if(value==null)return undefined;
  if(typeof value!=='object'||Array.isArray(value))throw Error('去背景参数无效');
  const mode=value.mode??'custom',presets={green:'#00ff00',black:'#000000'};
  if(!['green','black','custom'].includes(mode))throw Error('去背景模式无效');
  const color=value.color??presets[mode];
  if(typeof color!=='string'||!/^#[a-f0-9]{6}$/i.test(color))throw Error('去背景颜色无效');
  const similarity=value.similarity??(mode==='black'?.1:.3),blend=value.blend??.08;
  if(!Number.isFinite(similarity)||similarity<.01||similarity>1||!Number.isFinite(blend)||blend<0||blend>1)throw Error('去背景容差或柔边无效');
  return {mode,color:presets[mode]||color.toLowerCase(),similarity,blend};
}

/** RGB distance mask, multiplied by existing alpha to preserve transparent images. */
export function colorKeyFilter(value) {
  const key=normalizeColorKey(value);if(!key)return '';
  const rgb=key.color.slice(1).match(/../g).map(hex=>parseInt(hex,16));
  const distance=`sqrt(${rgb.map((channel,i)=>`pow(${['r','g','b'][i]}(X,Y)-${channel},2)`).join('+')})/sqrt(195075)`;
  const mask=key.blend?`clip(((${distance})-${key.similarity})/${key.blend},0,1)`:`gt(${distance},${key.similarity})`;
  return `geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*(${mask})'`;
}
