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

/** FFmpeg's native RGB-distance key; the timeline renderer preserves source alpha separately. */
export function colorKeyFilter(value) {
  const key=normalizeColorKey(value);if(!key)return '';
  return `colorkey=0x${key.color.slice(1)}:${key.similarity}:${key.blend}`;
}
