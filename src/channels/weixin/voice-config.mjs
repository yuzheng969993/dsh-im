// voice-config.mjs — 微信语音配置的纯数据归一化(浏览器安全,无 Node 内置模块)。
// 运行时合成/转码能力见 voice.mjs;此处只负责把每机器人配置校验为固定形状,
// 供 host 侧配置存储、RPC 校验与 client 侧设置页共用。
export const DEFAULT_WEIXIN_VOICE_SECRET_REF = 'DASHSCOPE_API_KEY';
export const DEFAULT_WEIXIN_TTS_MODEL = 'qwen3-tts-flash';
export const DEFAULT_WEIXIN_TTS_VOICE = 'Momo';
export const DEFAULT_WEIXIN_VOICE_MAX_CHARS = 200;
export const MAX_WEIXIN_VOICE_MAX_CHARS = 2_000;
export const WEIXIN_TTS_ENDPOINT = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';

export const DEFAULT_OPENAI_TTS_BASE_URL = 'https://api.openai.com/v1';
export const DEFAULT_OPENAI_TTS_MODEL = 'tts-1';
export const DEFAULT_OPENAI_TTS_VOICE = 'alloy';

/** 语音合成后端:DashScope 原生、OpenAI 兼容 /audio/speech、自定义 JSON 接口。 */
export const WEIXIN_TTS_PROVIDERS = Object.freeze(['dashscope', 'openai', 'custom']);

/** OpenAI 兼容接口可请求的音频容器;自定义接口只把 format 传进模板。 */
export const WEIXIN_TTS_RESPONSE_FORMATS = Object.freeze(['wav', 'mp3', 'ogg', 'opus', 'flac', 'aac']);

/** 自定义接口的响应形态。 */
export const WEIXIN_CUSTOM_RESPONSE_TYPES = Object.freeze(['audio', 'url', 'base64']);

/** 语音回复触发方式:仅收到语音消息时回复语音,或每条回复都附带语音。 */
export const WEIXIN_VOICE_REPLY_MODES = Object.freeze(['voice-input', 'always']);

/**
 * 出站语音编码:
 * - auto:优先 SILK(微信原生),缺少 silk-wasm 时改用 Ogg/Opus。
 * - silk:强制 SILK,不可用时明确失败。
 * - ogg-opus:强制 Ogg/Opus。
 */
export const WEIXIN_VOICE_CODECS = Object.freeze(['auto', 'silk', 'ogg-opus']);

/** 入站语音编码类型(silk-wasm 输出与微信客户端一致)。 */
export const WEIXIN_VOICE_ENCODE_TYPE = Object.freeze({
  silk: 6,
  'ogg-opus': 8,
});

export const WEIXIN_VOICE_SAMPLE_RATE = Object.freeze({
  silk: 24_000,
  'ogg-opus': 48_000,
});

function cleanString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeEndpoint(value) {
  const raw = cleanString(value);
  if (!raw) return null;
  let url;
  try {
    url = new URL(raw.includes('://') ? raw : `http://${raw}`);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  url.hash = '';
  return url.toString();
}

export function normalizeWeixinTtsProvider(value) {
  const provider = cleanString(value);
  return WEIXIN_TTS_PROVIDERS.includes(provider) ? provider : 'dashscope';
}

export function normalizeWeixinVoiceReplyMode(value) {
  const mode = cleanString(value);
  return WEIXIN_VOICE_REPLY_MODES.includes(mode) ? mode : 'voice-input';
}

export function normalizeWeixinVoiceCodec(value) {
  const codec = cleanString(value);
  return WEIXIN_VOICE_CODECS.includes(codec) ? codec : 'auto';
}

export function normalizeWeixinTtsResponseFormat(value) {
  const format = cleanString(value)?.toLowerCase();
  return WEIXIN_TTS_RESPONSE_FORMATS.includes(format) ? format : 'wav';
}

export function normalizeWeixinCustomResponseType(value) {
  const type = cleanString(value);
  return WEIXIN_CUSTOM_RESPONSE_TYPES.includes(type) ? type : 'audio';
}

function maxChars(value) {
  const number = Number(value);
  if (!Number.isInteger(number)) return DEFAULT_WEIXIN_VOICE_MAX_CHARS;
  return Math.min(MAX_WEIXIN_VOICE_MAX_CHARS, Math.max(50, number));
}

function normalizeCustomBody(value) {
  const raw = cleanString(value) ?? '{"text":"{{text}}","voice":"{{voice}}"}';
  if (raw.length > 8_000) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return JSON.stringify(parsed);
  } catch {
    return null;
  }
}

/**
 * 归一化每机器人语音配置。语音是可选的渠道能力:关闭或配置不完整时返回 null,
 * 与未配置行为完全一致。secretRef 走插件凭据库,密钥本身绝不进配置。
 *
 * DashScope 必须提供 secretRef;自建的 OpenAI 兼容/自定义服务可以不鉴权,
 * 因此这两类 provider 允许 secretRef 为空。
 */
export function normalizeWeixinVoiceConfig(value) {
  if (value == null || typeof value !== 'object' || Array.isArray(value) || value.enabled !== true) {
    return null;
  }
  const ttsProvider = normalizeWeixinTtsProvider(value.ttsProvider ?? value.provider);
  const rawSecretRef = cleanString(value.secretRef);
  if (rawSecretRef && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(rawSecretRef)) return null;
  const secretRef = rawSecretRef ?? null;
  if (ttsProvider === 'dashscope' && !secretRef) return null;

  let endpoint = null;
  if (ttsProvider === 'openai') {
    endpoint = normalizeEndpoint(value.endpoint ?? DEFAULT_OPENAI_TTS_BASE_URL);
    if (!endpoint) return null;
  } else if (ttsProvider === 'custom') {
    endpoint = normalizeEndpoint(value.endpoint);
    if (!endpoint) return null;
  }

  let customBody = null;
  if (ttsProvider === 'custom') {
    customBody = normalizeCustomBody(value.customBody);
    if (!customBody) return null;
  }

  return Object.freeze({
    enabled: true,
    ttsProvider,
    secretRef,
    endpoint,
    ttsModel: cleanString(value.ttsModel) ?? (ttsProvider === 'openai'
      ? DEFAULT_OPENAI_TTS_MODEL
      : ttsProvider === 'dashscope' ? DEFAULT_WEIXIN_TTS_MODEL : ''),
    ttsVoice: cleanString(value.ttsVoice) ?? (ttsProvider === 'openai'
      ? DEFAULT_OPENAI_TTS_VOICE
      : ttsProvider === 'dashscope' ? DEFAULT_WEIXIN_TTS_VOICE : ''),
    responseFormat: normalizeWeixinTtsResponseFormat(value.responseFormat),
    customBody,
    customResponse: normalizeWeixinCustomResponseType(value.customResponse),
    replyMode: normalizeWeixinVoiceReplyMode(value.replyMode),
    codec: normalizeWeixinVoiceCodec(value.codec),
    maxChars: maxChars(value.maxChars),
    ffmpeg: cleanString(value.ffmpeg),
  });
}
