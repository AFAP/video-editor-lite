// Source-relative, linear keyframes shared by the bridge's validation and renderer.
export const ANIMATION_LIMITS = Object.freeze({scale:[.1,3],ox:[-.5,.5],oy:[-.5,.5],opacity:[0,1],volume:[0,2]});
export function normalizeKeyframes(input) {
  if (input === undefined) return {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('关键帧格式无效');
  const result = {};
  for (const [key, points] of Object.entries(input)) {
    const limits = ANIMATION_LIMITS[key];
    if (!limits || !Array.isArray(points) || points.length > 128) throw Error('关键帧属性或数量无效');
    let previous = -1;
    result[key] = points.map(point => {
      if (!point || !Number.isFinite(point.time) || point.time < 0 || point.time > 864000 || point.time <= previous ||
          !Number.isFinite(point.value) || point.value < limits[0] || point.value > limits[1]) throw Error('关键帧时间或数值无效');
      previous = point.time;
      return {time:point.time,value:point.value};
    });
  }
  return result;
}
export function keyframeExpression(clip, key, variable, fallback) {
  const points = clip.keyframes?.[key];
  if (!points?.length) return String(fallback);
  const v = `(${variable}+${Number(clip.animationOffset ?? clip.in) || 0})`;
  let expression = String(points.at(-1).value);
  for (let i=points.length-2;i>=0;i--) {
    const a=points[i],b=points[i+1];
    expression=`if(lt(${v},${b.time}),${a.value}+(${b.value-a.value})*(${v}-${a.time})/${b.time-a.time},${expression})`;
  }
  return `if(lte(${v},${points[0].time}),${points[0].value},${expression})`;
}
