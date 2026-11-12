#!/usr/bin/env node
/**
 * 视频小工具的本地桥 —— 让单页 HTML 用上本机 ffmpeg。
 *
 * 浏览器不能启动进程，所以这里跑一个极小的本地 HTTP 服务：
 *   POST /upload?name=   把页面选中的文件落到临时目录，ffprobe 读元数据
 *   POST /render         按时间轴（每段的入点/出点）用 ffmpeg 渲成 mp4
 *   GET  /job/:id        进度
 *   GET  /download/:id   下载成片
 *   GET  /               顺便把旁边的 index.html 也发了（同源更省事）
 *
 * 只监听 127.0.0.1，没有依赖，任何 Node 18+ 都能跑。
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { basename, delimiter, extname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { renderTimeline } from './timeline-render.mjs';
import { createSpeechService } from './speech-service.mjs';
import { normalizeKeyframes } from './animation.mjs';
import { normalizeColorKey } from './color-key.mjs';
import { extractWaveform } from './waveform.mjs';

const PORT = Number(process.env.PORT || 8787);
const HOST = '127.0.0.1';
const WORK = join(tmpdir(), 'video-tool-bridge');
const IN_DIR = join(WORK, 'in');
const OUT_DIR = join(WORK, 'out');
const HERE = fileURLToPath(new URL('.', import.meta.url));
const PAGE = join(HERE, 'index.html');

function log(...args) {
  console.log('[bridge]', ...args);
}

/* --------------------------------------------------------------- ffmpeg 定位 */
function isFileSync(path) {
  try { return existsSync(path); } catch { return false; }
}
function findOnPath(names) {
  const raw = process.env.PATH ?? process.env.Path ?? '';
  for (const dir of raw.split(delimiter)) {
    const folder = dir.trim();
    if (!folder) continue;
    for (const name of names) {
      const candidate = join(folder, name);
      if (isFileSync(candidate)) return candidate;
    }
  }
  return undefined;
}
function normalize(candidate) {
  if (!candidate) return undefined;
  const value = String(candidate).trim().replace(/^"|"$/g, '');
  if (isFileSync(value)) return value;
  for (const exe of ['ffmpeg.exe', 'ffmpeg']) {
    const nested = join(value, exe);
    if (isFileSync(nested)) return nested;
  }
  return undefined;
}
function resolveBinaries() {
  const candidates = [];
  if (process.env.FFMPEG_PATH) candidates.push(process.env.FFMPEG_PATH);
  const onPath = findOnPath(['ffmpeg.exe', 'ffmpeg']);
  if (onPath) candidates.push(onPath);
  for (const candidate of candidates) {
    const ffmpeg = normalize(candidate);
    if (!ffmpeg) continue;
    const dir = ffmpeg.replace(/[\\/][^\\/]+$/, '');
    const ffprobe = (process.env.FFPROBE_PATH && isFileSync(process.env.FFPROBE_PATH) ? process.env.FFPROBE_PATH : undefined) || ['ffprobe.exe', 'ffprobe']
      .map((name) => join(dir, name))
      .find((path) => isFileSync(path)) || findOnPath(['ffprobe.exe', 'ffprobe']);
    return { ffmpeg, ffprobe };
  }
  return undefined;
}

const BIN = resolveBinaries();

/* --------------------------------------------------------------- 子进程 */
function run(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: true, cwd: options.cwd, signal: options.signal });
    let stderr = '';
    let stdout = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => { stdout += chunk; if (stdout.length > 262144) stdout = stdout.slice(-131072); });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
      if (stderr.length > 262144) stderr = stderr.slice(-131072);
      options.onStderr?.(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else {
        const tail = stderr.trim().split(/\r?\n/).filter(Boolean).slice(-6).join('\n');
        reject(new Error(tail || `${basename(file)} 退出码 ${code}`));
      }
    });
  });
}

/* --------------------------------------------------------------- 工具函数 */
function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...cors(),
  });
  res.end(body);
}
function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Private-Network': 'true',
  };
}
function sanitize(name) {
  return basename(String(name || 'clip.mp4')).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(-120) || 'clip.mp4';
}
function clock(sec) {
  const v = Math.max(0, Number(sec) || 0);
  const m = Math.floor(v / 60);
  return `${String(m).padStart(2, '0')}:${(v % 60).toFixed(2).padStart(5, '0')}`;
}
function parseTime(text) {
  const m = /time=(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(text);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : undefined;
}

async function probe(file) {
  if (!BIN.ffprobe) return {};
  const { stdout } = await run(BIN.ffprobe, [
    '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file,
  ]);
  const data = JSON.parse(stdout || '{}');
  const streams = Array.isArray(data.streams) ? data.streams : [];
  const video = streams.find((s) => s.codec_type === 'video');
  const audio = streams.find((s) => s.codec_type === 'audio');
  const duration = Number(data.format?.duration ?? video?.duration ?? 0);
  return {
    duration: Number.isFinite(duration) ? duration : 0,
    width: Number(video?.width) || 0,
    height: Number(video?.height) || 0,
    hasAudio: Boolean(audio),
    hasAlpha: video?.pix_fmt ? /^(?:yuva|gbrap|rgba|bgra|argb|abgr|ya|ayuv|vuya|pal8)/i.test(video.pix_fmt)||Number(video.tags?.alpha_mode)===1 : undefined,
  };
}

/* --------------------------------------------------------------- 任务状态 */
const uploads = new Map();     // id -> {path,name,size,duration,width,height,hasAudio}
const overlays = new Map();    // id -> {path}
const speech = createSpeechService({ ffmpeg: BIN?.ffmpeg, run, probe, uploads, inDir: IN_DIR, workDir: OUT_DIR });
const jobs = new Map();        // id -> job
const queue = [];
let pumping = false;

function publicJob(job) {
  return {
    id: job.id,
    status: job.status,
    progress: Math.round(job.progress * 1000) / 1000,
    outName: job.outName,
    size: job.size,
    duration: job.duration,
    renderSpeed: job.renderSpeed,
    elapsedSeconds: job.startedAt?Math.max(0,((job.finishedAt||Date.now())-job.startedAt)/1000):0,
    error: job.error,
  };
}

async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    while (queue.length) {
      const job = queue.shift();
      await renderJob(job);
    }
  } finally {
    pumping = false;
  }
}

async function renderJob(job) {
  job.status = 'running';
  job.startedAt = Date.now();
  const work = join(OUT_DIR, `work-${job.id}`);
  try {
    await mkdir(work, { recursive: true });
    if (job.timeline) {
      await renderTimeline(job, { ffmpeg: BIN.ffmpeg, run, overlays, work });
      job.size = (await stat(job.outPath)).size;
      job.progress = 1;
      job.status = 'done';
      log(`多轨合成完成 ${job.outName} (${clock(job.duration)})`);
      return;
    }
    const clips = job.clips.filter((c) => c.out - c.in > 0.01);
    if (!clips.length) throw new Error('没有可导出的片段');
    const total = clips.reduce((sum, c) => sum + (c.out - c.in), 0);
    job.duration = total;
    const list = [];
    let done = 0;

    for (let i = 0; i < clips.length; i += 1) {
      const clip = clips[i];
      const duration = clip.out - clip.in;
      const segment = `seg-${String(i).padStart(3, '0')}.mp4`;
      const W = job.width;
      const H = job.height;
      const scale = Math.min(4, Math.max(0.1, Number(clip.scale) || 1));
      const offsetX = Math.round(Math.max(-1, Math.min(1, Number(clip.ox) || 0)) * W);
      const offsetY = Math.round(Math.max(-1, Math.min(1, Number(clip.oy) || 0)) * H);
      const zoomed = Math.abs(scale - 1) > 0.002 || offsetX !== 0 || offsetY !== 0;

      const fit = `scale=${W}:${H}:force_original_aspect_ratio=decrease,` +
        `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1`;
      const chain = zoomed
        ? `[0:v]${fit}[fit];` +
          `[fit]scale=trunc(iw*${scale.toFixed(4)}/2)*2:trunc(ih*${scale.toFixed(4)}/2)*2:flags=bicubic[zoom];` +
          `color=c=black:s=${W}x${H}:r=${job.fps}:d=${duration.toFixed(3)}[bg];` +
          `[bg][zoom]overlay=x=(W-w)/2+${offsetX}:y=(H-h)/2+${offsetY}:shortest=1,fps=${job.fps},format=yuv420p[v]`
        : `[0:v]${fit},fps=${job.fps},format=yuv420p[v]`;

      const volume = Math.min(4, Math.max(0, Number(clip.volume)));
      const muted = clip.muted === true || volume <= 0;
      const fadeIn = Math.min(duration, Math.max(0, Number(clip.fadeIn) || 0));
      const fadeOut = Math.min(duration, Math.max(0, Number(clip.fadeOut) || 0));
      let audioChain;
      if (clip.hasAudio) {
        const parts = [`volume=${muted ? 0 : volume.toFixed(3)}`];
        if (fadeIn > 0.02) parts.push(`afade=t=in:st=0:d=${fadeIn.toFixed(3)}`);
        if (fadeOut > 0.02) parts.push(`afade=t=out:st=${Math.max(0, duration - fadeOut).toFixed(3)}:d=${fadeOut.toFixed(3)}`);
        audioChain = `[0:a]${parts.join(',')}[a]`;
      } else {
        audioChain = '[1:a]anull[a]';
      }

      const args = [
        '-hide_banner', '-loglevel', 'error', '-stats', '-stats_period', '0.5', '-nostdin', '-y',
      ];
      if (clip.kind === 'image') {
        args.push('-loop', '1', '-t', duration.toFixed(3), '-i', clip.path);
      } else {
        args.push('-ss', clip.in.toFixed(3), '-i', clip.path);
      }
      if (!clip.hasAudio) {
        args.push('-f', 'lavfi', '-t', duration.toFixed(3), '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');
      }
      args.push('-t', duration.toFixed(3));
      args.push('-filter_complex', chain + ';' + audioChain);
      args.push('-map', '[v]', '-map', '[a]');
      args.push('-c:v', 'libx264', '-preset', job.preset, '-crf', String(job.crf), '-pix_fmt', 'yuv420p');
      args.push('-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2');
      args.push('-movflags', '+faststart', segment);

      const base = done;
      await run(BIN.ffmpeg, args, {
        cwd: work,
        onStderr: (chunk) => {
          const seconds = parseTime(chunk);
          if (seconds !== undefined) {
            job.progress = Math.min(0.98, (base + Math.min(seconds, duration)) / total);
          }
        },
      });
      done += duration;
      job.progress = Math.min(0.98, done / total);
      list.push(`file '${segment}'`);
    }

    await writeFile(join(work, 'segments.txt'), `${list.join('\n')}\n`, 'utf8');
    await run(BIN.ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
      '-f', 'concat', '-safe', '0', '-i', 'segments.txt',
      '-c', 'copy', '-movflags', '+faststart', join(work, 'joined.mp4'),
    ], { cwd: work });

    // 文字层：浏览器已经渲染成整帧透明 PNG，这里按时间段叠上去
    const texts = job.texts.filter((t) => t.end > t.start + 0.01);
    if (texts.length) {
      job.progress = Math.max(job.progress, 0.9);
      const args = [
        '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
        '-i', join(work, 'joined.mp4'),
      ];
      for (const text of texts) {
        args.push('-loop', '1', '-t', total.toFixed(3), '-i', overlays.get(text.id).path);
      }
      let chain = '';
      let previous = '0:v';
      texts.forEach((text, index) => {
        const next = index === texts.length - 1 ? 'vout' : 'v' + (index + 1);
        chain += `[${previous}][${index + 1}:v]overlay=0:0:enable='between(t,${text.start.toFixed(
          3,
        )},${text.end.toFixed(3)})'[${next}];`;
        previous = next;
      });
      args.push('-filter_complex', chain.slice(0, -1));
      args.push('-map', '[vout]', '-map', '0:a?');
      args.push('-c:v', 'libx264', '-preset', job.preset, '-crf', String(job.crf), '-pix_fmt', 'yuv420p');
      args.push('-c:a', 'copy', '-movflags', '+faststart', job.outPath);
      await run(BIN.ffmpeg, args, { cwd: work });
      await rm(join(work, 'joined.mp4'), { force: true }).catch(() => {});
    } else {
      await rename(join(work, 'joined.mp4'), job.outPath).catch(async () => {
        await copyFile(join(work, 'joined.mp4'), job.outPath);
      });
    }

    const info = await stat(job.outPath);
    job.size = info.size;
    job.progress = 1;
    job.status = 'done';
    log(`完成 ${job.outName} (${(job.size / 1048576).toFixed(1)}MB, ${clock(total)})`);
  } catch (failure) {
    job.status = 'error';
    job.error = failure?.message || String(failure);
    log('失败', job.error);
  } finally {
    job.finishedAt = Date.now();
    rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

/* --------------------------------------------------------------- HTTP */
const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${HOST}:${PORT}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors());
    res.end();
    return;
  }

  try {
    if (url.pathname.startsWith('/speech/')) {
      // AI credentials and billable requests are available only to the local editor.
      const origin = req.headers.origin;
      const allowedOrigins = [`http://${HOST}:${PORT}`, `http://localhost:${PORT}`];
      if (origin && !allowedOrigins.includes(origin)) return json(res, 403, { ok: false, error: '请从本机桥接页面打开 AI 功能' });
      if (url.pathname === '/speech/config') {
        if (req.method === 'GET') return json(res, 200, { ok: true, config: speech.publicConfig() });
        if (req.method === 'POST') {
          const chunks = []; let size = 0;
          for await (const chunk of req) { size += chunk.length; if (size > 16384) throw new Error('设置内容过大'); chunks.push(chunk); }
          return json(res, 200, { ok: true, config: speech.configure(JSON.parse(Buffer.concat(chunks).toString('utf8'))) });
        }
      }
      if (url.pathname === '/speech/jobs' && req.method === 'POST') {
        const chunks = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > 262144) throw new Error('AI 请求内容过大'); chunks.push(chunk); }
        return json(res, 200, { ok: true, job: speech.start(JSON.parse(Buffer.concat(chunks).toString('utf8'))) });
      }
      const task = /^\/speech\/jobs\/([a-f0-9]+)(\/cancel)?$/.exec(url.pathname);
      if (task && (req.method === 'GET' || req.method === 'POST' && task[2])) {
        const job = task[2] ? speech.cancel(task[1]) : speech.get(task[1]);
        return json(res, job ? 200 : 404, job ? { ok: true, job } : { ok: false, error: '没有这个 AI 任务' });
      }
      const audio = /^\/speech\/audio\/([a-f0-9]+)$/.exec(url.pathname);
      if (audio && req.method === 'GET') {
        const source = uploads.get(audio[1]);
        if (!source?.generatedSpeech) return json(res, 404, { ok: false, error: '找不到生成的配音，请重新合成' });
        const info = await stat(source.path);
        const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
        const start = range ? Number(range[1]) : 0, end = range && range[2] ? Math.min(info.size - 1, Number(range[2])) : info.size - 1;
        if (start > end || start >= info.size) { res.writeHead(416, { 'Content-Range': `bytes */${info.size}`, ...cors() }); res.end(); return; }
        res.writeHead(range ? 206 : 200, { 'Content-Type': 'audio/wav', 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes',
          ...(range ? { 'Content-Range': `bytes ${start}-${end}/${info.size}` } : {}), ...cors() });
        createReadStream(source.path, { start, end }).pipe(res); return;
      }
      return json(res, 404, { ok: false, error: '没有这个 AI 接口' });
    }
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      if (!isFileSync(PAGE)) return json(res, 404, { ok: false, error: '找不到 index.html' });
      const html = await readFile(PAGE);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': html.length, 'Cache-Control': 'no-store' });
      res.end(html);
      return;
    }

    const iconTypes = { '/favicon.svg': 'image/svg+xml', '/favicon.ico': 'image/x-icon', '/favicon.png': 'image/png' };
    if (req.method === 'GET' && Object.hasOwn(iconTypes, url.pathname)) {
      const icon = await readFile(join(HERE, url.pathname.slice(1)));
      res.writeHead(200, { 'Content-Type': iconTypes[url.pathname], 'Content-Length': icon.length, 'Cache-Control': 'public, max-age=3600' });
      res.end(icon);
      return;
    }

    if (url.pathname === '/ping') {
      let version = '';
      try {
        const { stdout } = await run(BIN.ffmpeg, ['-version']);
        version = (stdout.split(/\r?\n/)[0] || '').trim();
      } catch (failure) {
        return json(res, 200, { ok: false, error: failure.message, ffmpeg: BIN.ffmpeg || '' });
      }
      return json(res, 200, { ok: true, port: PORT, ffmpeg: BIN.ffmpeg, ffprobe: BIN.ffprobe || '', version,capabilities:{colorKey:true} });
    }

    if (url.pathname === '/upload' && req.method === 'POST') {
      const name = sanitize(url.searchParams.get('name'));
      const ext = extname(name).toLowerCase() || '.mp4';
      const id = randomUUID().slice(0, 8);
      const target = join(IN_DIR, `${id}${ext}`);
      await mkdir(IN_DIR, { recursive: true });
      await pipeline(req, createWriteStream(target));
      const info = await stat(target);
      if (!info.size) {
        await rm(target, { force: true });
        return json(res, 400, { ok: false, error: '上传内容为空' });
      }
      const meta = await probe(target).catch(() => ({}));
      const record = {
        id,
        name,
        path: target,
        size: info.size,
        duration: meta.duration || 0,
        width: meta.width || 0,
        height: meta.height || 0,
        hasAudio: meta.hasAudio !== false,
        hasAlpha: meta.hasAlpha,
      };
      uploads.set(id, record);
      log(`收到 ${name} (${(info.size / 1048576).toFixed(1)}MB, ${clock(record.duration)})`);
      return json(res, 200, { ok: true, ...record });
    }

    const waveformMatch = /^\/waveform\/([a-f0-9]+)$/.exec(url.pathname);
    if (waveformMatch && req.method === 'GET') {
      const source = uploads.get(waveformMatch[1]);
      if (!source) return json(res, 404, {ok:false,error:'找不到波形素材'});
      if (!source.waveformPromise) source.waveformPromise = extractWaveform(BIN.ffmpeg,source).catch(error=>{delete source.waveformPromise;throw error;});
      return json(res,200,{ok:true,...await source.waveformPromise});
    }

    if (url.pathname === '/overlay' && req.method === 'POST') {
      const id = randomUUID().slice(0, 8);
      const target = join(IN_DIR, `ov-${id}.png`);
      await mkdir(IN_DIR, { recursive: true });
      await pipeline(req, createWriteStream(target));
      const info = await stat(target);
      if (!info.size) {
        await rm(target, { force: true });
        return json(res, 400, { ok: false, error: '文字图层是空的' });
      }
      overlays.set(id, { path: target });
      return json(res, 200, { ok: true, id, size: info.size });
    }

    if (url.pathname === '/render' && req.method === 'POST') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch {
        return json(res, 400, { ok: false, error: '请求体不是合法 JSON' });
      }
      const clips = Array.isArray(body.clips) ? body.clips : [];
      if (!clips.length && body.timeline !== true) return json(res, 400, { ok: false, error: '没有片段' });
      const prepared = [];
      for (const clip of clips) {
        const isImage = clip.kind === 'image';
        const source = isImage ? overlays.get(String(clip.id || '')) || uploads.get(String(clip.id || '')) : uploads.get(String(clip.id || ''));
        if (!source) return json(res, 400, { ok: false, error: `找不到素材 ${clip.id}` });
        const inPoint = Math.max(0, Number(clip.in) || 0);
        const outPoint = isImage
          ? Math.max(inPoint + 0.1, Number(clip.out) || inPoint + 5)
          : Math.min(Number(clip.out) || source.duration, source.duration || Number(clip.out) || 0);
        if (!(outPoint > inPoint)) return json(res, 400, { ok: false, error: '片段区间无效' });
        let keyframes,colorKey;
        try { keyframes = normalizeKeyframes(clip.keyframes);colorKey=normalizeColorKey(clip.colorKey); }
        catch (error) { return json(res,400,{ok:false,error:error.message}); }
        if(colorKey&&body.timeline!==true)return json(res,400,{ok:false,error:'去背景需要使用多轨时间线导出'});
        prepared.push({
          kind: isImage ? 'image' : clip.kind === 'audio' ? 'audio' : 'video',
          start: Math.max(0, Number(clip.start) || 0),
          layer: Number(clip.layer) || 0,
          opacity: clip.opacity === undefined ? 1 : Math.min(1, Math.max(0, Number(clip.opacity) || 0)),
          transitionIn: clip.transitionIn,
          transitionOut: clip.transitionOut,
          keyframes,colorKey:clip.kind==='audio'?undefined:colorKey,
          animationOffset: inPoint,
          path: source.path,
          in: isImage ? 0 : inPoint,
          out: isImage ? outPoint - inPoint : outPoint,
          hasAudio: isImage ? false : source.hasAudio,
          hasAlpha: isImage ? true : source.hasAlpha,
          scale: Number(clip.scale) || 1,
          ox: Number(clip.ox) || 0,
          oy: Number(clip.oy) || 0,
          volume: clip.volume === undefined ? 1 : Number(clip.volume),
          muted: clip.muted === true,
          fadeIn: Number(clip.fadeIn) || 0,
          fadeOut: Number(clip.fadeOut) || 0,
        });
      }
      const texts = (Array.isArray(body.texts) ? body.texts : [])
        .filter((text) => text && overlays.has(String(text.id)))
        .map((text) => ({ id: String(text.id), start: Math.max(0, Number(text.start) || 0), end: Number(text.end) || 0 }))
        .filter((text) => text.end > text.start);
      const width = Math.max(16, Math.round((Number(body.width) || 1280) / 2) * 2);
      const height = Math.max(16, Math.round((Number(body.height) || 720) / 2) * 2);
      const fps = Math.min(120, Math.max(1, Number(body.fps) || 30));
      const quality = body.quality === 'high' ? 20 : body.quality === 'low' ? 28 : 23;
      const preset = body.quality === 'high' ? 'medium' : body.quality === 'low' ? 'veryfast' : 'veryfast';
      const id = randomUUID().slice(0, 8);
      const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
      const outName = sanitize((body.name || '剪辑').replace(/\.[a-z0-9]+$/i, '') + '-' + stamp + '.mp4');
      const outPath = join(OUT_DIR, `${id}.mp4`);
      await mkdir(OUT_DIR, { recursive: true });
      const job = {
        id,
        status: 'queued',
        progress: 0,
        clips: prepared,
        timeline: body.timeline === true,
        texts,
        width,
        height,
        fps,
        crf: quality,
        preset,
        outPath,
        outName,
        size: 0,
        duration: body.timeline === true ? Math.max(0, Number(body.duration) || 0) : 0,
        error: '',
      };
      jobs.set(id, job);
      queue.push(job);
      void pump();
      log(`排队 ${outName} · ${prepared.length} 段 · ${width}×${height}@${fps}`);
      return json(res, 200, { ok: true, job: publicJob(job) });
    }

    const jobMatch = /^\/job\/([0-9a-f]+)$/.exec(url.pathname);
    if (jobMatch) {
      const job = jobs.get(jobMatch[1]);
      if (!job) return json(res, 404, { ok: false, error: '没有这个任务' });
      return json(res, 200, { ok: true, job: publicJob(job) });
    }

    const dlMatch = /^\/download\/([0-9a-f]+)$/.exec(url.pathname);
    if (dlMatch) {
      const job = jobs.get(dlMatch[1]);
      if (!job || job.status !== 'done') return json(res, 404, { ok: false, error: '文件还没好' });
      const info = await stat(job.outPath).catch(() => undefined);
      if (!info) return json(res, 404, { ok: false, error: '文件已被清理' });
      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Content-Length': info.size,
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(job.outName)}`,
        ...cors(),
      });
      createReadStream(job.outPath).pipe(res);
      return;
    }

    return json(res, 404, { ok: false, error: `没有这个接口：${url.pathname}` });
  } catch (failure) {
    log('请求出错', failure?.message || failure);
    try { json(res, 500, { ok: false, error: failure?.message || String(failure) }); } catch { /* 已经发过头了 */ }
  }
});

await mkdir(IN_DIR, { recursive: true });
await mkdir(OUT_DIR, { recursive: true });

if (!BIN?.ffmpeg) {
  console.error('[bridge] 没找到 ffmpeg：把它加进 PATH，或设 FFMPEG_PATH 环境变量后重试。');
  process.exit(1);
}

server.listen(PORT, HOST, () => {
  log(`已启动 http://${HOST}:${PORT}`);
  log(`ffmpeg: ${BIN.ffmpeg}`);
  log(`用浏览器打开 http://${HOST}:${PORT}/ （或者直接双击 index.html，页面会自动连上来）`);
});
