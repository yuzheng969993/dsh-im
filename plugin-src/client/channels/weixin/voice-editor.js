import * as React from 'react';

import { h } from '../../i18n.js';

// 微信语音条编辑器:开关 + 合成服务 + 凭据引用 + TTS 参数 + 触发方式 + 编码格式。
// 合成服务支持 DashScope 原生、OpenAI 兼容 /audio/speech、以及自定义 JSON 接口,
// 因此自建在 VPS 上的 TTS 也能接入。凭据值由插件凭据库管理,这里只保存 secretRef
// 名称——密钥本身不进入配置,也不经本表单传输。
const PROVIDER_DEFAULTS = Object.freeze({
  dashscope: Object.freeze({
    model: 'qwen3-tts-flash', voice: 'Momo', endpoint: '',
    modelPlaceholder: 'qwen3-tts-flash', voicePlaceholder: 'Momo',
    endpointPlaceholder: '',
  }),
  openai: Object.freeze({
    model: 'tts-1', voice: 'alloy', endpoint: 'https://api.openai.com/v1',
    modelPlaceholder: 'tts-1', voicePlaceholder: 'alloy',
    endpointPlaceholder: 'http://127.0.0.1:9880/v1',
  }),
  custom: Object.freeze({
    model: '', voice: '', endpoint: '',
    modelPlaceholder: 'model',
    voicePlaceholder: 'voice',
    endpointPlaceholder: 'http://127.0.0.1:9880/tts',
  }),
});

const DEFAULT_CUSTOM_BODY = '{"text":"{{text}}","voice":"{{voice}}"}';

export function WeixinVoiceEditor({ value = null, disabled = false, onSave }) {
  const [enabled, setEnabled] = React.useState(value != null);
  const [provider, setProvider] = React.useState(value?.ttsProvider ?? 'dashscope');
  const [endpoint, setEndpoint] = React.useState(value?.endpoint ?? '');
  const [secretRef, setSecretRef] = React.useState(value?.secretRef
    ?? ((value?.ttsProvider ?? 'dashscope') === 'dashscope' ? 'DASHSCOPE_API_KEY' : ''));
  const [ttsModel, setTtsModel] = React.useState(value?.ttsModel ?? 'qwen3-tts-flash');
  const [ttsVoice, setTtsVoice] = React.useState(value?.ttsVoice ?? 'Momo');
  const [responseFormat, setResponseFormat] = React.useState(value?.responseFormat ?? 'wav');
  const [customBody, setCustomBody] = React.useState(value?.customBody ?? DEFAULT_CUSTOM_BODY);
  const [customResponse, setCustomResponse] = React.useState(value?.customResponse ?? 'audio');
  const [replyMode, setReplyMode] = React.useState(value?.replyMode ?? 'voice-input');
  const [codec, setCodec] = React.useState(value?.codec ?? 'auto');
  const [maxChars, setMaxChars] = React.useState(String(value?.maxChars ?? 200));
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState(null);
  const titleId = React.useId();
  const helpId = `${titleId}-help`;

  React.useEffect(() => {
    setEnabled(value != null);
    if (value) {
      const savedProvider = value.ttsProvider ?? 'dashscope';
      setProvider(savedProvider);
      setEndpoint(value.endpoint ?? '');
      setSecretRef(value.secretRef ?? (savedProvider === 'dashscope' ? 'DASHSCOPE_API_KEY' : ''));
      setTtsModel(value.ttsModel
        ?? (savedProvider === 'dashscope' ? 'qwen3-tts-flash' : ''));
      setTtsVoice(value.ttsVoice
        ?? (savedProvider === 'dashscope' ? 'Momo' : ''));
      setResponseFormat(value.responseFormat ?? 'wav');
      setCustomBody(value.customBody ?? DEFAULT_CUSTOM_BODY);
      setCustomResponse(value.customResponse ?? 'audio');
      setReplyMode(value.replyMode ?? 'voice-input');
      setCodec(value.codec ?? 'auto');
      setMaxChars(String(value.maxChars ?? 200));
    }
  }, [value]);

  const defaults = PROVIDER_DEFAULTS[provider] ?? PROVIDER_DEFAULTS.dashscope;

  const changeProvider = (next) => {
    const previous = PROVIDER_DEFAULTS[provider] ?? PROVIDER_DEFAULTS.dashscope;
    const target = PROVIDER_DEFAULTS[next] ?? PROVIDER_DEFAULTS.dashscope;
    setProvider(next);
    // Only replace values still equal to the previous provider defaults, so a
    // user-entered model, voice or endpoint is never silently discarded.
    if (!ttsModel || ttsModel === previous.model) setTtsModel(target.model);
    if (!ttsVoice || ttsVoice === previous.voice) setTtsVoice(target.voice);
    if (!endpoint || endpoint === previous.endpoint) setEndpoint(target.endpoint);
    if (next === 'dashscope' && !secretRef) setSecretRef('DASHSCOPE_API_KEY');
    // Never carry the DashScope credential reference into a self-hosted service
    // by accident: it would otherwise send that key to the configured VPS.
    if (next !== 'dashscope' && secretRef === 'DASHSCOPE_API_KEY') setSecretRef('');
  };

  const persist = async (payload) => {
    if (saving || disabled) return;
    setSaving(true);
    setError(null);
    try {
      await onSave?.(payload);
    } catch (cause) {
      setError(cause?.message ?? '语音设置保存失败，请重试。');
    } finally {
      setSaving(false);
    }
  };

  const save = () => persist(enabled ? {
    enabled: true,
    ttsProvider: provider,
    endpoint: provider === 'dashscope' ? null : endpoint,
    secretRef: secretRef.trim() || null,
    ttsModel,
    ttsVoice,
    responseFormat,
    customBody: provider === 'custom' ? customBody : null,
    customResponse: provider === 'custom' ? customResponse : 'audio',
    replyMode,
    codec,
    maxChars: Number(maxChars) || 200,
  } : null);

  // 切到“关闭”立即持久化 null:关闭态没有保存按钮,若不在这里落盘,
  // 后台会一直保持原配置,用户以为语音已停而实际仍在发送语音。
  const toggle = (next) => {
    setEnabled(next);
    if (!next) void persist(null);
  };

  const input = (label, state, setState, placeholder, type = 'text') => h('label', {
    className: 'dim-feishuVoiceField',
  },
  h('span', { className: 'dim-feishuVoiceLabel' }, label),
  h('input', {
    type,
    className: 'dim-feishuVoiceInput',
    value: state,
    placeholder,
    disabled: disabled || saving,
    onChange: (event) => setState(event.target.value),
  }),
  );

  const select = (label, state, setState, options) => h('label', {
    className: 'dim-feishuVoiceField',
  },
  h('span', { className: 'dim-feishuVoiceLabel' }, label),
  h('select', {
    className: 'dim-feishuGroupSelect',
    value: state,
    disabled: disabled || saving,
    onChange: (event) => setState(event.target.value),
  }, options.map(([optionValue, text]) => h('option', {
    key: optionValue, value: optionValue,
  }, text))),
  );

  const textarea = (label, state, setState, placeholder) => h('label', {
    className: 'dim-feishuVoiceField',
  },
  h('span', { className: 'dim-feishuVoiceLabel' }, label),
  h('textarea', {
    className: 'dim-feishuVoiceInput dim-weixinVoiceTextarea',
    value: state,
    placeholder,
    rows: 4,
    spellCheck: false,
    disabled: disabled || saving,
    onChange: (event) => setState(event.target.value),
  }),
  );

  const secretRequired = provider === 'dashscope';

  return h('section', {
    className: 'dim-feishuGroupControl',
    'aria-labelledby': titleId,
  },
  h('div', { className: 'dim-feishuGroupControlHeader' },
    h('div', { className: 'dim-presetTitle' },
      h('h3', { id: titleId }, '语音交互'),
      h('span', { className: 'dim-presetHelp' },
        h('button', {
          type: 'button',
          className: 'dim-presetHelpButton',
          'aria-label': '查看微信语音说明',
          'aria-describedby': helpId,
        }, h('span', { 'aria-hidden': 'true' }, '?')),
        h('span', {
          id: helpId,
          className: 'dim-presetTooltip',
          role: 'tooltip',
        }, '开启后，机器人会把答案合成为微信语音条发送，文字回复仍会保留。可使用 DashScope、OpenAI 兼容接口，或填写自定义 JSON 请求体接入自建 TTS。SILK 编码依赖可选的 silk-wasm，缺失时自动改用 Ogg/Opus。iLink 出站语音在部分账号可能不显示，可切换编码或改用音频文件。'))),
    saving
      ? h('span', { className: 'dim-feishuGroupControlStatus', role: 'status' }, '保存中…')
      : null),
  h('select', {
    className: 'dim-feishuGroupSelect',
    value: enabled ? 'on' : 'off',
    disabled: disabled || saving,
    'aria-label': '语音交互开关',
    onChange: (event) => toggle(event.target.value === 'on'),
  },
  h('option', { value: 'off' }, '关闭'),
  h('option', { value: 'on' }, '开启(文字回答与语音条)')),
  enabled
    ? h('div', { className: 'dim-feishuVoiceForm' },
        select('语音合成服务', provider, changeProvider, [
          ['dashscope', 'DashScope（阿里云）'],
          ['openai', 'OpenAI 兼容接口'],
          ['custom', '自定义 JSON 接口'],
        ]),
        provider === 'dashscope'
          ? null
          : input('服务地址', endpoint, setEndpoint, defaults.endpointPlaceholder),
        input(
          secretRequired ? '凭据引用(环境变量名)' : '凭据引用(环境变量名，可留空)',
          secretRef,
          setSecretRef,
          secretRequired ? 'DASHSCOPE_API_KEY' : '可留空',
        ),
        input('合成模型(TTS)', ttsModel, setTtsModel, defaults.modelPlaceholder),
        input('回复音色', ttsVoice, setTtsVoice, defaults.voicePlaceholder),
        provider === 'dashscope'
          ? null
          : select('返回格式', responseFormat, setResponseFormat, [
              ['wav', 'WAV'],
              ['mp3', 'MP3'],
              ['ogg', 'OGG'],
              ['opus', 'Opus'],
              ['flac', 'FLAC'],
              ['aac', 'AAC'],
            ]),
        provider === 'custom'
          ? textarea('自定义请求体 (JSON)', customBody, setCustomBody,
              DEFAULT_CUSTOM_BODY)
          : null,
        provider === 'custom'
          ? select('自定义响应类型', customResponse, setCustomResponse, [
              ['audio', '直接返回音频'],
              ['url', 'JSON 中的音频 URL'],
              ['base64', 'JSON 中的 Base64 音频'],
            ])
          : null,
        select('语音回复方式', replyMode, setReplyMode, [
          ['voice-input', '仅当用户发送语音时回复语音'],
          ['always', '每条回复都附带语音'],
        ]),
        select('语音编码格式', codec, setCodec, [
          ['auto', '自动（优先 SILK）'],
          ['silk', 'SILK（微信原生）'],
          ['ogg-opus', 'Ogg/Opus（兼容）'],
        ]),
        input('语音文本上限(字符)', maxChars, setMaxChars, '200', 'number'),
        h('p', { className: 'dim-feishuGroupHelp' },
          'DashScope 需要凭据库中的 DashScope 密钥；自建 OpenAI 兼容或自定义接口可留空凭据。自定义请求体支持 {{text}}、{{voice}}、{{model}}、{{format}}、{{hash}}、{{id}} 占位符（{{hash}} 对相同文本和音色稳定，{{id}} 每次请求唯一），响应可为音频字节、JSON 中的音频 URL 或 Base64。需要本机可用 ffmpeg；微信语音条约 60 秒上限，超出部分仍保留在文字回复中。'),
        h('div', { className: 'dim-feishuVoiceActions' },
          h('button', {
            type: 'button',
            className: 'dim-feishuVoiceSave',
            onClick: () => void save(),
            disabled: disabled || saving || (secretRequired && !secretRef.trim())
              || (provider !== 'dashscope' && !endpoint.trim()),
          }, '保存语音设置')))
    : h('p', { className: 'dim-feishuGroupHelp' }, '默认关闭;开启后机器人会用微信语音条补充回答。'),
  error ? h('p', {
    className: 'dim-feishuGroupError',
    role: 'alert',
  }, error) : null);
}
