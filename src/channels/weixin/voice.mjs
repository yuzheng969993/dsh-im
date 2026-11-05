// voice.mjs — 微信渠道语音能力(渠道能力:语音条发送)
// 出站:文字 → DashScope qwen3-tts-flash 合成 → 转码为 SILK 或 Ogg/Opus →
//       微信 CDN 上传 → voice_item。SILK 是微信原生语音格式,依靠可选的
//       silk-wasm(纯 WASM,无原生依赖);缺失时自动改用 ffmpeg 可产出的
//       Ogg/Opus,并通过 encode_type 告知 iLink。
// 本模块只负责“把一段文字/一个音频文件变成微信 voice_item 所需的字节与元数据”,
// 网络上传与发送在 weixin-api.mjs。凭据经插件凭据库在运行时注入,不落盘、不进日志。
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_OPENAI_TTS_MODEL,
  DEFAULT_OPENAI_TTS_VOICE,
  DEFAULT_WEIXIN_VOICE_MAX_CHARS,
  WEIXIN_TTS_ENDPOINT,
  WEIXIN_VOICE_ENCODE_TYPE,
  WEIXIN_VOICE_SAMPLE_RATE,
  normalizeWeixinVoiceConfig,
} from './voice-config.mjs';

/** 微信语音条单条上限按保守值处理;iLink 对超长语音会拒绝或静默丢弃。 */
export const MAX_WEIXIN_VOICE_BYTES = 10 * 1024 * 1024;
export const MAX_TTS_AUDIO_BYTES = 20 * 1024 * 1024;
export const MAX_WEIXIN_VOICE_SECONDS = 60;

const EXTENSIONS = Object.freeze({
  'audio/ogg': 'ogg',
  'audio/oga': 'ogg',
  'audio/opus': 'opus',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/webm': 'webm',
  'audio/flac': 'flac',
  'audio/amr': 'amr',
  'audio/silk': 'silk',
});

function voiceError(code, message, cause) {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.code = code;
  return error;
}

function extensionFor(fileName, mediaType) {
  const key = typeof mediaType === 'string' ? mediaType.toLowerCase().split(';')[0].trim() : '';
  if (EXTENSIONS[key]) return EXTENSIONS[key];
  const match = /\.([a-z0-9]{2,5})$/iu.exec(String(fileName ?? ''));
  return match ? match[1].toLowerCase() : 'audio';
}

export function isSilkAudio(bytes) {
  const buffer = Buffer.from(bytes ?? []);
  return buffer.length >= 9
    && buffer.toString('ascii', 0, 9) === '#!SILK_V3'
    || (buffer.length >= 10 && buffer[0] === 0x02
      && buffer.toString('ascii', 1, 10) === '#!SILK_V3');
}

function isWavAudio(bytes) {
  const buffer = Buffer.from(bytes ?? []);
  return buffer.length >= 12
    && buffer.toString('ascii', 0, 4) === 'RIFF'
    && buffer.toString('ascii', 8, 12) === 'WAVE';
}

/** Duration in milliseconds from a canonical PCM/RIFF WAV, or null. */
export function wavDurationMs(bytes) {
  const buffer = Buffer.from(bytes ?? []);
  if (!isWavAudio(buffer) || buffer.length < 44) return null;
  let offset = 12;
  let byteRate = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ' && size >= 12 && body + 12 <= buffer.length) {
      byteRate = buffer.readUInt32LE(body + 8);
    } else if (id === 'data') {
      const dataSize = Math.min(size, buffer.length - body);
      if (!byteRate || byteRate <= 0 || dataSize <= 0) return null;
      const milliseconds = (dataSize / byteRate) * 1_000;
      return Number.isFinite(milliseconds) && milliseconds > 0
        ? Math.round(milliseconds) : null;
    }
    offset = body + size + (size % 2);
  }
  return null;
}

/**
 * Duration in milliseconds from the last Ogg page granule position.
 * Opus granules use 48 kHz, so the value does not depend on a codec lookup.
 */
export function oggOpusDurationMs(bytes, sampleRate = WEIXIN_VOICE_SAMPLE_RATE['ogg-opus']) {
  const buffer = Buffer.from(bytes ?? []);
  let offset = 0;
  let lastGranule = null;
  while (offset + 27 <= buffer.length) {
    if (buffer.toString('ascii', offset, offset + 4) !== 'OggS') break;
    const segments = buffer[offset + 26];
    const tableEnd = offset + 27 + segments;
    if (tableEnd > buffer.length) break;
    let payloadBytes = 0;
    for (let index = 0; index < segments; index += 1) {
      payloadBytes += buffer[offset + 27 + index];
    }
    const pageEnd = tableEnd + payloadBytes;
    if (pageEnd > buffer.length) break;
    const granule = buffer.readBigInt64LE(offset + 6);
    if (granule > 0n) lastGranule = granule;
    offset = pageEnd;
  }
  if (lastGranule === null) return null;
  const milliseconds = (Number(lastGranule) / sampleRate) * 1_000;
  return Number.isFinite(milliseconds) && milliseconds > 0
    ? Math.round(milliseconds) : null;
}

/** Remove Markdown syntax the synthesiser should not read aloud, then bound length. */
export function plainTextForVoice(text, maxChars = DEFAULT_WEIXIN_VOICE_MAX_CHARS) {
  const limit = Number.isInteger(maxChars) && maxChars > 0
    ? maxChars : DEFAULT_WEIXIN_VOICE_MAX_CHARS;
  let clean = String(text ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>\n]{1,200}>/g, ' ')
    .replace(/^\s{0,3}(?:#{1,6}|>|[-*+]|\d+[.)])\s+/gmu, '')
    .replace(/[*_~]{1,3}/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (clean.length > limit) {
    const window = clean.slice(0, limit);
    const cut = Math.max(
      window.lastIndexOf('。'), window.lastIndexOf('！'), window.lastIndexOf('？'),
      window.lastIndexOf('!'), window.lastIndexOf('?'), window.lastIndexOf('；'),
      window.lastIndexOf(';'), window.lastIndexOf('.'),
    );
    clean = cut >= Math.floor(limit * 0.5) ? window.slice(0, cut + 1) : window;
  }
  return clean.trim();
}

function runFfmpeg(bin, args, { signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
      ...(signal ? { signal } : {}),
    });
    let stderr = '';
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
      if (stderr.length > 2_000) stderr = stderr.slice(-2_000);
    });
    // A missing binary rejects through 'error', not a non-zero exit code.
    child.on('error', reject);
    child.on('close', (code) => (code === 0
      ? resolve()
      : reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-300)}`))));
  });
}

let silkModulePromise;

async function loadSilkModule() {
  if (silkModulePromise === undefined) {
    silkModulePromise = import('silk-wasm').catch(() => null);
  }
  return silkModulePromise;
}

function voicePayload(bytes, codec, playtimeMs, fileName) {
  const raw = Number(playtimeMs);
  if (!Number.isFinite(raw) || raw <= 0) {
    throw voiceError('voice-duration-unavailable', '微信语音的时长无法确定。');
  }
  const milliseconds = Math.max(1, Math.round(raw));
  return Object.freeze({
    bytes: Buffer.from(bytes),
    fileName,
    mediaType: codec === 'silk' ? 'audio/silk' : 'audio/ogg',
    codec,
    encodeType: WEIXIN_VOICE_ENCODE_TYPE[codec],
    sampleRate: WEIXIN_VOICE_SAMPLE_RATE[codec],
    bitsPerSample: 16,
    playtimeMs: milliseconds,
  });
}

function validateAudio(bytes, label) {
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) {
    throw new TypeError(`${label} must be audio bytes`);
  }
  const buffer = Buffer.from(bytes);
  if (buffer.length === 0) throw voiceError('voice-empty', '微信语音内容为空。');
  if (buffer.length > MAX_WEIXIN_VOICE_BYTES) {
    throw voiceError('voice-too-large', '微信语音超过 10 MB 上限。');
  }
  return buffer;
}

/**
 * Build the transcoder used by both automatic voice replies and audio artifacts
 * returned through the DSH harness file tool. `auto` prefers WeChat-native SILK
 * and falls back to Ogg/Opus when the optional silk-wasm module is unavailable.
 */
export function createVoiceTranscoder({
  ffmpeg = 'ffmpeg',
  codec = 'auto',
  logger,
  run = runFfmpeg,
  loadSilk = loadSilkModule,
  workDirectory = (prefix) => mkdtempSync(join(tmpdir(), prefix)),
  removeDirectory = (path) => rmSync(path, { recursive: true, force: true }),
} = {}) {
  if (typeof ffmpeg !== 'string' || !ffmpeg.trim()) {
    throw new TypeError('ffmpeg must be a command name or path');
  }
  if (!['auto', 'silk', 'ogg-opus'].includes(codec)) {
    throw new TypeError('voice codec must be auto, silk, or ogg-opus');
  }
  const binary = ffmpeg.trim();

  async function silkDuration(buffer) {
    const silk = await loadSilk();
    if (typeof silk?.getDuration === 'function') {
      try {
        const duration = silk.getDuration(buffer);
        if (Number.isFinite(duration) && duration > 0) return duration;
      } catch {
        // Fall through to decoding when the frame layout is unusual.
      }
    }
    if (typeof silk?.decode === 'function') {
      try {
        const decoded = await silk.decode(buffer, WEIXIN_VOICE_SAMPLE_RATE.silk);
        if (Number.isFinite(decoded?.duration) && decoded.duration > 0) return decoded.duration;
      } catch {
        // The caller reports an explicit codec failure below.
      }
    }
    return null;
  }

  async function encodeSilk(buffer, inputExtension, signal) {
    const silk = await loadSilk();
    if (typeof silk?.encode !== 'function') {
      throw voiceError('voice-codec-unavailable', 'SILK 编码器 silk-wasm 未安装。');
    }
    if (isSilkAudio(buffer)) {
      const duration = await silkDuration(buffer);
      if (!duration) throw voiceError('voice-duration-unavailable', '微信 SILK 语音的时长无法确定。');
      return voicePayload(buffer, 'silk', duration, 'voice.silk');
    }
    const directory = workDirectory('dsh-weixin-voice-');
    try {
      const input = join(directory, `in.${inputExtension}`);
      const output = join(directory, 'out.pcm');
      writeFileSync(input, buffer);
      await run(binary, [
        '-i', input, '-vn', '-ar', String(WEIXIN_VOICE_SAMPLE_RATE.silk),
        '-ac', '1', '-f', 's16le', '-c:a', 'pcm_s16le', output,
      ], { signal });
      signal?.throwIfAborted();
      const pcm = readFileSync(output);
      if (pcm.length === 0) throw voiceError('voice-encode-failed', '音频转码后为空。');
      const encoded = await silk.encode(pcm, WEIXIN_VOICE_SAMPLE_RATE.silk);
      if (!encoded?.data?.length) throw voiceError('voice-encode-failed', 'SILK 编码失败。');
      const playtimeMs = (pcm.length / (WEIXIN_VOICE_SAMPLE_RATE.silk * 2)) * 1_000;
      return voicePayload(encoded.data, 'silk', playtimeMs, 'voice.silk');
    } catch (error) {
      if (error?.code?.startsWith?.('voice-')) throw error;
      throw voiceError('voice-encode-failed', '音频转码为 SILK 失败。', error);
    } finally {
      removeDirectory(directory);
    }
  }

  async function encodeOggOpus(buffer, inputExtension, signal) {
    if (isSilkAudio(buffer)) {
      const silk = await loadSilk();
      if (typeof silk?.decode !== 'function') {
        throw voiceError('voice-codec-unavailable', 'Ogg/Opus 转码需要 silk-wasm 解码 SILK。');
      }
      let decoded;
      try {
        decoded = await silk.decode(buffer, WEIXIN_VOICE_SAMPLE_RATE.silk);
      } catch (error) {
        throw voiceError('voice-decode-failed', 'SILK 语音解码失败。', error);
      }
      if (!decoded?.data?.length) throw voiceError('voice-decode-failed', 'SILK 语音解码失败。');
      return encodeOggOpus(Buffer.from(decoded.data), 'pcm', signal);
    }
    const directory = workDirectory('dsh-weixin-voice-');
    try {
      const input = join(directory, `in.${inputExtension}`);
      const output = join(directory, 'out.ogg');
      writeFileSync(input, buffer);
      await run(binary, [
        '-i', input, '-vn', '-c:a', 'libopus', '-b:a', '32k',
        '-ar', String(WEIXIN_VOICE_SAMPLE_RATE['ogg-opus']), '-ac', '1', '-f', 'ogg', output,
      ], { signal });
      signal?.throwIfAborted();
      const ogg = readFileSync(output);
      const playtimeMs = oggOpusDurationMs(ogg) ?? wavDurationMs(buffer);
      if (!playtimeMs) throw voiceError('voice-duration-unavailable', '微信语音的时长无法确定。');
      return voicePayload(ogg, 'ogg-opus', playtimeMs, 'voice.ogg');
    } catch (error) {
      if (error?.code?.startsWith?.('voice-')) throw error;
      throw voiceError('voice-encode-failed', '音频转码为 Ogg/Opus 失败。', error);
    } finally {
      removeDirectory(directory);
    }
  }

  async function prepare({ bytes, fileName, mediaType, signal } = {}) {
    const buffer = validateAudio(bytes, 'Weixin voice audio');
    signal?.throwIfAborted();
    const extension = extensionFor(fileName, mediaType);
    let selected = codec;
    if (selected === 'auto') {
      const silk = await loadSilk();
      selected = typeof silk?.encode === 'function' ? 'silk' : 'ogg-opus';
    }
    if (selected === 'silk') return encodeSilk(buffer, extension, signal);
    return encodeOggOpus(buffer, extension, signal);
  }

  return Object.freeze({ prepare, codec, ffmpeg: binary });
}

/**
 * Build the per-bot voice capability. `settings` is the normalized voice config;
 * `secret` is the credential resolved from the store (required for DashScope,
 * optional for a self-hosted service). Missing required configuration means
 * "voice reply is disabled" while pre-existing audio artifacts can still be
 * transcoded by the caller's own transcoder.
 */
export function createWeixinVoice({
  settings,
  secret,
  logger,
  transcoder,
  fetchImpl = fetch,
  maxChars,
  ttsEndpoint = WEIXIN_TTS_ENDPOINT,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  const config = normalizeWeixinVoiceConfig(settings);
  const apiKey = typeof secret === 'string' && secret.trim() ? secret.trim() : null;
  if (!config || (config.ttsProvider === 'dashscope' && !apiKey)) {
    if (config) logger?.warn?.('[dsh-weixin-voice] 语音凭据缺失,语音已禁用');
    return Object.freeze({ enabled: false });
  }
  const voiceTranscoder = transcoder ?? createVoiceTranscoder({
    ffmpeg: config.ffmpeg ?? 'ffmpeg',
    codec: config.codec,
    logger,
  });
  const limit = Number.isInteger(maxChars) && maxChars > 0 ? maxChars : config.maxChars;
  const requestUrl = ttsRequestUrl(config, ttsEndpoint);

  async function synthesize(text, { signal } = {}) {
    const clean = plainTextForVoice(text, limit);
    if (!clean) return null;
    signal?.throwIfAborted();
    const request = ttsRequest(config, clean, apiKey, {
      // A stable hash lets idempotent self-hosted services reuse output for the
      // same text and voice, while a unique id prevents a constant cache key
      // (for example ttsd's default "line") from returning a previous answer's
      // audio. The hash includes the voice so changing it invalidates the cache.
      hash: createHash('sha256')
        .update(`${clean}\u0000${config.ttsVoice}\u0000${config.ttsModel}\u0000${config.responseFormat}`)
        .digest('hex')
        .slice(0, 16),
      id: randomUUID(),
    });
    let response;
    try {
      response = await fetchImpl(requestUrl, {
        method: 'POST',
        headers: request.headers,
        body: JSON.stringify(request.body),
        signal,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw voiceError('voice-tts-unreachable', '暂时无法访问语音合成服务。', error);
    }
    if (!response?.ok) {
      throw voiceError('voice-tts-rejected', `语音合成失败（HTTP ${response?.status ?? 'unknown'}）。`);
    }
    const { bytes, mediaType } = await ttsAudio(response, {
      fetchImpl,
      signal,
      requestUrl,
      apiKey,
      responseType: config.ttsProvider === 'custom' ? config.customResponse : 'auto',
    });
    const prepared = await voiceTranscoder.prepare({
      bytes,
      fileName: 'tts-audio',
      mediaType,
      signal,
    });
    if (prepared.playtimeMs > MAX_WEIXIN_VOICE_SECONDS * 1_000) {
      logger?.warn?.(
        `[dsh-weixin-voice] 合成语音 ${prepared.playtimeMs}ms 超过微信语音时长上限，仍按原样发送。`,
      );
    }
    return prepared;
  }

  return Object.freeze({
    enabled: true,
    config,
    synthesize,
    transcode: (options) => voiceTranscoder.prepare(options),
  });
}

function ttsRequestUrl(config, dashscopeEndpoint) {
  if (config.ttsProvider === 'dashscope') return new URL(dashscopeEndpoint);
  const url = new URL(config.endpoint);
  if (config.ttsProvider === 'openai'
    && !url.pathname.replace(/\/+$/u, '').endsWith('/audio/speech')) {
    url.pathname = `${url.pathname.replace(/\/+$/u, '')}/audio/speech`;
  }
  return url;
}

function authHeaders(apiKey) {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

function ttsRequest(config, text, apiKey, { hash = '', id = '' } = {}) {
  const headers = { 'Content-Type': 'application/json', ...authHeaders(apiKey) };
  if (config.ttsProvider === 'dashscope') {
    return {
      headers,
      body: {
        model: config.ttsModel || 'qwen3-tts-flash',
        input: { text, voice: config.ttsVoice || 'Momo' },
      },
    };
  }
  if (config.ttsProvider === 'openai') {
    // OpenAI's speech endpoint names the Ogg/Opus family "opus".
    const format = config.responseFormat === 'ogg' ? 'opus' : config.responseFormat;
    return {
      headers,
      body: {
        model: config.ttsModel || DEFAULT_OPENAI_TTS_MODEL,
        input: text,
        voice: config.ttsVoice || DEFAULT_OPENAI_TTS_VOICE,
        response_format: format,
      },
    };
  }
  let template;
  try {
    template = JSON.parse(config.customBody);
  } catch (error) {
    throw voiceError('voice-tts-invalid-template', '自定义语音接口的请求体不是有效 JSON。', error);
  }
  return {
    headers,
    body: substituteTemplate(template, {
      text,
      voice: config.ttsVoice,
      model: config.ttsModel,
      format: config.responseFormat,
      hash,
      id,
    }),
  };
}

function substituteTemplate(value, values) {
  if (Array.isArray(value)) return value.map((item) => substituteTemplate(item, values));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .map(([key, item]) => [key, substituteTemplate(item, values)]));
  }
  if (typeof value !== 'string') return value;
  return value.replace(/\{\{(text|voice|model|format|hash|id)\}\}/gu, (_match, name) => (
    typeof values[name] === 'string' ? values[name] : ''
  ));
}

function contentLength(response) {
  const value = Number(response?.headers?.get?.('content-length'));
  return Number.isFinite(value) && value >= 0 ? value : null;
}

async function readBodyBytes(response) {
  const declared = contentLength(response);
  if (declared !== null && declared > MAX_TTS_AUDIO_BYTES) {
    throw voiceError('voice-too-large', '合成的语音超过大小上限。');
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_TTS_AUDIO_BYTES) {
    throw voiceError('voice-too-large', '合成的语音超过大小上限。');
  }
  return bytes;
}

function isAudioContentType(value) {
  const type = String(value ?? '').toLowerCase();
  return type.startsWith('audio/') || type === 'application/octet-stream';
}

function pickPath(value, paths) {
  for (const path of paths) {
    let current = value;
    for (const key of path) {
      current = current?.[key];
      if (current === undefined || current === null) break;
    }
    if (typeof current === 'string' && current.trim()) return current.trim();
  }
  return null;
}

function audioUrlFromJson(body, baseUrl) {
  const raw = pickPath(body, [
    ['output', 'audio', 'url'],
    ['data', 'audio', 'url'],
    ['data', 'url'],
    ['result', 'url'],
    ['audio', 'url'],
    ['audio_url'],
    ['url'],
  ]);
  if (!raw) return null;
  try {
    const url = new URL(raw, baseUrl);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

function audioBase64FromJson(body) {
  const raw = pickPath(body, [
    ['audio_base64'],
    ['audio'],
    ['data', 'audio_base64'],
    ['data', 'audio'],
    ['data'],
    ['result', 'audio'],
    ['output', 'audio', 'base64'],
  ]);
  if (!raw) return null;
  const base64 = raw.startsWith('data:') ? raw.slice(raw.indexOf(',') + 1) : raw;
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(base64) || base64.length % 4 !== 0) return null;
  return Buffer.from(base64, 'base64');
}

async function downloadAudio(url, { fetchImpl, signal, requestUrl, apiKey }) {
  const sameOrigin = url.origin === requestUrl.origin;
  let response;
  try {
    response = await fetchImpl(url, {
      ...(sameOrigin ? { headers: authHeaders(apiKey) } : {}),
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw voiceError('voice-tts-unreachable', '暂时无法下载合成的语音。', error);
  }
  if (!response.ok) {
    throw voiceError('voice-tts-download-failed', `合成语音下载失败（HTTP ${response.status}）。`);
  }
  return {
    bytes: await readBodyBytes(response),
    mediaType: response.headers?.get?.('content-type') ?? 'audio/wav',
  };
}

async function ttsAudio(response, {
  fetchImpl,
  signal,
  requestUrl,
  apiKey,
  responseType = 'auto',
}) {
  const contentType = response.headers?.get?.('content-type') ?? '';
  const jsonLike = /json/iu.test(contentType);
  // A binary audio body is the normal OpenAI-compatible response, and also the
  // common shape for self-hosted servers. JSON is parsed only when the response
  // actually declares JSON; a URL/Base64 response type still gets its fallback.
  if (!jsonLike && isAudioContentType(contentType)) {
    return {
      bytes: await readBodyBytes(response),
      mediaType: contentType.startsWith('audio/') ? contentType : 'audio/wav',
    };
  }
  const body = jsonLike ? await response.json().catch(() => null) : null;
  const readUrl = () => {
    const url = audioUrlFromJson(body, requestUrl);
    return url
      ? downloadAudio(url, { fetchImpl, signal, requestUrl, apiKey })
      : null;
  };
  const readBase64 = () => {
    const bytes = audioBase64FromJson(body);
    return bytes ? { bytes, mediaType: 'audio/wav' } : null;
  };
  let audio = null;
  if (responseType === 'base64') audio = readBase64() ?? await readUrl();
  else audio = await readUrl() ?? readBase64();
  if (audio) return audio;
  if (!contentType) {
    // Some self-hosted servers omit Content-Type while returning raw audio.
    return {
      bytes: await readBodyBytes(response),
      mediaType: 'audio/wav',
    };
  }
  throw voiceError('voice-tts-invalid-audio', '语音合成服务没有返回可用的音频。');
}


