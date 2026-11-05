import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  normalizeWeixinVoiceConfig,
} from '../../../src/channels/weixin/voice-config.mjs';
import {
  createVoiceTranscoder,
  createWeixinVoice,
  isSilkAudio,
  oggOpusDurationMs,
  plainTextForVoice,
  wavDurationMs,
} from '../../../src/channels/weixin/voice.mjs';

function oggPage(granule) {
  const page = Buffer.alloc(27);
  page.write('OggS', 0, 'ascii');
  page[4] = 0;
  page[5] = 0;
  page.writeBigInt64LE(BigInt(granule), 6);
  page.writeUInt32LE(1, 14);
  page.writeUInt32LE(0, 18);
  page.writeUInt32LE(0, 22);
  page[26] = 0;
  return page;
}

function wavBytes(samples = 24_000) {
  const data = Buffer.alloc(samples * 2, 1);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(24_000, 24);
  header.writeUInt32LE(48_000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

test('voice config defaults are bounded and invalid settings disable the capability', () => {
  const normalized = normalizeWeixinVoiceConfig({
    enabled: true,
    secretRef: 'DASHSCOPE_API_KEY',
    replyMode: 'unexpected',
    codec: 'unexpected',
    maxChars: 99_999,
  });
  assert.equal(normalized.replyMode, 'voice-input');
  assert.equal(normalized.codec, 'auto');
  assert.equal(normalized.maxChars, 2_000);
  assert.equal(normalized.ttsProvider, 'dashscope');
  assert.equal(normalizeWeixinVoiceConfig({ enabled: false, secretRef: 'K' }), null);
  assert.equal(normalizeWeixinVoiceConfig({ enabled: true, secretRef: 'bad ref' }), null);
  assert.equal(normalizeWeixinVoiceConfig({ enabled: true }), null, 'DashScope requires a credential');
});

test('self-hosted providers allow an empty credential and require an endpoint', () => {
  const openai = normalizeWeixinVoiceConfig({
    enabled: true,
    ttsProvider: 'openai',
    endpoint: 'http://127.0.0.1:9880/v1',
  });
  assert.equal(openai.ttsProvider, 'openai');
  assert.equal(openai.secretRef, null);
  assert.equal(openai.ttsModel, 'tts-1');
  assert.equal(openai.ttsVoice, 'alloy');
  assert.equal(openai.endpoint, 'http://127.0.0.1:9880/v1');

  const custom = normalizeWeixinVoiceConfig({
    enabled: true,
    ttsProvider: 'custom',
    endpoint: '192.168.1.20:9880/tts',
    customBody: '{"text":"{{text}}","speaker":"{{voice}}"}',
    customResponse: 'url',
    responseFormat: 'mp3',
  });
  assert.equal(custom.endpoint, 'http://192.168.1.20:9880/tts');
  assert.equal(custom.customResponse, 'url');
  assert.equal(custom.responseFormat, 'mp3');
  assert.equal(custom.secretRef, null);

  assert.equal(normalizeWeixinVoiceConfig({ enabled: true, ttsProvider: 'custom' }), null);
  assert.equal(normalizeWeixinVoiceConfig({
    enabled: true, ttsProvider: 'custom', endpoint: 'http://x/tts', customBody: 'not json',
  }), null);
});

test('voice text strips Markdown without reading syntax aloud', () => {
  const text = plainTextForVoice('## 标题\n**重点** `代码` [文档](https://example.com) 和 ![图](x.png)。', 100);
  assert.equal(text, '标题 重点 代码 文档 和 。');
  assert.equal(plainTextForVoice('一'.repeat(80), 20).length <= 21, true);
});

test('audio duration readers cover WAV and Ogg Opus', () => {
  assert.equal(wavDurationMs(wavBytes(24_000)), 1_000);
  assert.equal(oggOpusDurationMs(oggPage(96_000)), 2_000);
  assert.equal(isSilkAudio(Buffer.from('\x02#!SILK_V3payload', 'binary')), true);
  assert.equal(isSilkAudio(Buffer.from('RIFF')), false);
});

test('an injected SILK encoder produces a WeChat voice payload', async () => {
  let pcmWritten;
  const transcoder = createVoiceTranscoder({
    codec: 'silk',
    workDirectory: () => mkdtempSync(join(tmpdir(), 'dsh-weixin-voice-test-')),
    loadSilk: async () => ({
      encode: async (pcm) => {
        pcmWritten = pcm;
        return { data: Buffer.from('SILK-BYTES'), duration: 0 };
      },
    }),
    run: async (_bin, args) => {
      const output = args[args.length - 1];
      writeFileSync(output, Buffer.alloc(3_200));
    },
  });
  const prepared = await transcoder.prepare({
    bytes: wavBytes(24_000),
    fileName: 'reply.wav',
    mediaType: 'audio/wav',
  });
  assert.equal(pcmWritten.length, 3_200);
  assert.equal(prepared.bytes.toString(), 'SILK-BYTES');
  assert.equal(prepared.encodeType, 6);
  assert.equal(prepared.sampleRate, 24_000);
  assert.equal(prepared.playtimeMs, 67);
  assert.equal(prepared.mediaType, 'audio/silk');
});

test('auto codec falls back to Ogg/Opus when silk-wasm is unavailable', async () => {
  const transcoder = createVoiceTranscoder({
    codec: 'auto',
    workDirectory: () => mkdtempSync(join(tmpdir(), 'dsh-weixin-voice-test-')),
    loadSilk: async () => null,
    run: async (_bin, args) => {
      const output = args[args.length - 1];
      writeFileSync(output, oggPage(96_000));
    },
  });
  const prepared = await transcoder.prepare({
    bytes: wavBytes(24_000),
    fileName: 'reply.wav',
    mediaType: 'audio/wav',
  });
  assert.equal(prepared.encodeType, 8);
  assert.equal(prepared.sampleRate, 48_000);
  assert.equal(prepared.playtimeMs, 2_000);
  assert.equal(prepared.mediaType, 'audio/ogg');
});

test('TTS synthesis cleans the answer and forwards it to the transcoder', async () => {
  const requests = [];
  let preparedWith;
  const voice = createWeixinVoice({
    settings: {
      enabled: true, secretRef: 'DASHSCOPE_API_KEY', maxChars: 40,
    },
    secret: 'test-key',
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init });
      if (String(url).includes('multimodal-generation')) {
        return new Response(JSON.stringify({
          output: { audio: { url: 'https://cdn.example/tts.wav' } },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(Buffer.from('wav-bytes'), {
        status: 200,
        headers: { 'content-type': 'audio/wav' },
      });
    },
    transcoder: {
      prepare: async (options) => {
        preparedWith = options;
        return {
          bytes: Buffer.from('voice'), fileName: 'voice.silk', mediaType: 'audio/silk',
          encodeType: 6, sampleRate: 24_000, playtimeMs: 1_234,
        };
      },
    },
  });
  const audio = await voice.synthesize('## 标题\n**答案**内容');
  assert.equal(requests.length, 2);
  assert.equal(requests[0].init.headers.Authorization, 'Bearer test-key');
  const body = JSON.parse(requests[0].init.body);
  assert.equal(body.input.text, '标题 答案内容');
  assert.equal(body.input.voice, 'Momo');
  assert.equal(preparedWith.mediaType, 'audio/wav');
  assert.equal(audio.playtimeMs, 1_234);
});

test('voice reply is disabled when the credential is missing', () => {
  const voice = createWeixinVoice({
    settings: { enabled: true, secretRef: 'DASHSCOPE_API_KEY' },
    secret: null,
  });
  assert.deepEqual({ ...voice }, { enabled: false });
});

test('OpenAI-compatible TTS sends the standard /audio/speech request without a key', async () => {
  const requests = [];
  let preparedWith;
  const voice = createWeixinVoice({
    settings: {
      enabled: true,
      ttsProvider: 'openai',
      endpoint: 'http://127.0.0.1:9880/v1',
      ttsModel: 'custom-model',
      ttsVoice: 'custom-voice',
      responseFormat: 'mp3',
      maxChars: 60,
    },
    secret: null,
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init });
      return new Response(Buffer.from('mp3-audio'), {
        status: 200,
        headers: { 'content-type': 'audio/mpeg' },
      });
    },
    transcoder: {
      prepare: async (options) => {
        preparedWith = options;
        return {
          bytes: Buffer.from('voice'), fileName: 'voice.silk', mediaType: 'audio/silk',
          encodeType: 6, sampleRate: 24_000, playtimeMs: 900,
        };
      },
    },
  });

  await voice.synthesize('## 标题\n**答案**');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'http://127.0.0.1:9880/v1/audio/speech');
  assert.equal(requests[0].init.headers.Authorization, undefined);
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    model: 'custom-model',
    input: '标题 答案',
    voice: 'custom-voice',
    response_format: 'mp3',
  });
  assert.equal(preparedWith.mediaType, 'audio/mpeg');
});

test('custom TTS substitutes template placeholders and follows a JSON audio URL', async () => {
  const requests = [];
  let preparedWith;
  const voice = createWeixinVoice({
    settings: {
      enabled: true,
      ttsProvider: 'custom',
      endpoint: 'http://vps.local:9880/tts',
      secretRef: 'TTS_API_KEY',
      ttsModel: 'my-model',
      ttsVoice: 'speaker-1',
      responseFormat: 'wav',
      customBody: '{"text":"{{text}}","speaker":"{{voice}}","model":"{{model}}","fmt":"{{format}}"}',
      customResponse: 'url',
      maxChars: 60,
    },
    secret: 'custom-key',
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init });
      if (requests.length === 1) {
        return new Response(JSON.stringify({ data: { url: '/audio/reply.wav' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(Buffer.from('wav-audio'), {
        status: 200,
        headers: { 'content-type': 'audio/wav' },
      });
    },
    transcoder: {
      prepare: async (options) => {
        preparedWith = options;
        return {
          bytes: Buffer.from('voice'), fileName: 'voice.silk', mediaType: 'audio/silk',
          encodeType: 6, sampleRate: 24_000, playtimeMs: 900,
        };
      },
    },
  });

  await voice.synthesize('你好');
  assert.equal(requests[0].url, 'http://vps.local:9880/tts');
  assert.equal(requests[0].init.headers.Authorization, 'Bearer custom-key');
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    text: '你好', speaker: 'speaker-1', model: 'my-model', fmt: 'wav',
  });
  assert.equal(requests[1].url, 'http://vps.local:9880/audio/reply.wav');
  assert.equal(requests[1].init.headers.Authorization, 'Bearer custom-key');
  assert.equal(preparedWith.mediaType, 'audio/wav');
});

test('custom TTS accepts a Base64 JSON response', async () => {
  let preparedWith;
  const voice = createWeixinVoice({
    settings: {
      enabled: true,
      ttsProvider: 'custom',
      endpoint: 'http://vps.local:9880/tts',
      customResponse: 'base64',
      customBody: '{"text":"{{text}}"}',
    },
    secret: null,
    fetchImpl: async () => new Response(JSON.stringify({
      audio_base64: Buffer.from('base64-audio').toString('base64'),
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
    transcoder: {
      prepare: async (options) => {
        preparedWith = options;
        return {
          bytes: Buffer.from('voice'), fileName: 'voice.silk', mediaType: 'audio/silk',
          encodeType: 6, sampleRate: 24_000, playtimeMs: 900,
        };
      },
    },
  });
  await voice.synthesize('你好');
  assert.equal(preparedWith.bytes.toString(), 'base64-audio');
  assert.equal(preparedWith.mediaType, 'audio/wav');
});

test('custom TTS exposes a stable text hash and a unique request id', async () => {
  const bodies = [];
  const settings = {
    enabled: true,
    ttsProvider: 'custom',
    endpoint: 'http://vps.local:9880/tts',
    ttsVoice: 'voice-a',
    customBody: '{"text":"{{text}}","hash":"{{hash}}","id":"{{id}}"}',
  };
  const makeVoice = (ttsVoice) => createWeixinVoice({
    settings: { ...settings, ttsVoice },
    secret: null,
    fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      return new Response(Buffer.from('wav'), {
        status: 200, headers: { 'content-type': 'audio/wav' },
      });
    },
    transcoder: {
      prepare: async () => ({
        bytes: Buffer.from('voice'), fileName: 'voice.silk', mediaType: 'audio/silk',
        encodeType: 6, sampleRate: 24_000, playtimeMs: 900,
      }),
    },
  });

  const a = makeVoice('voice-a');
  await a.synthesize('同一句话');
  await a.synthesize('同一句话');
  await makeVoice('voice-b').synthesize('同一句话');

  assert.equal(bodies[0].hash, bodies[1].hash, 'same text and voice share a cache key');
  assert.notEqual(bodies[0].hash, bodies[2].hash, 'changing the voice invalidates the cache key');
  assert.notEqual(bodies[0].id, bodies[1].id, 'each request gets a unique id');
  assert.match(bodies[0].hash, /^[0-9a-f]{16}$/);
});
