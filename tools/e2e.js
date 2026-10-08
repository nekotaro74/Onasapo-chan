// 挿絵生成の縦切りを、モック ComfyUI に対して実際にブラウザで実行して確認する実験用スクリプト。
// 実行: node tools/e2e.js   （Chrome が必要）
'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 8123;
const DEBUG_PORT = 9333;

const CHROME_CANDIDATES = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
].filter(Boolean);
const chromePath = CHROME_CANDIDATES.find(p => fs.existsSync(p));

// 1x1 の PNG
const PNG_1PX = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64');

// 短い無音 WAV。Audio が復号できて onended が発火する長さ
function makeWav(ms) {
    const rate = 8000;
    const samples = Math.max(1, Math.round(rate * ms / 1000));
    const data = Buffer.alloc(samples * 2); // 16bit mono 無音
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + data.length, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);        // PCM
    header.writeUInt16LE(1, 22);        // mono
    header.writeUInt32LE(rate, 24);
    header.writeUInt32LE(rate * 2, 28); // byte rate
    header.writeUInt16LE(2, 32);        // block align
    header.writeUInt16LE(16, 34);       // bits
    header.write('data', 36);
    header.writeUInt32LE(data.length, 40);
    return Buffer.concat([header, data]);
}

// 参照ボイス一覧のモック。Irodori の形（id + ref_* ）で返す
const MOCK_IRODORI_VOICES = {
    object: 'list',
    data: [
        { id: 'momo', object: 'voice', ref_wav: 'momo.wav', ref_wavs: [], ref_latent: null, ref_latents: [], ref_embed: null, no_ref: false },
        { id: 'rima', object: 'voice', ref_wav: null, ref_latent: null, ref_latents: ['rima.pt'], ref_embed: null, no_ref: false },
        { id: 'none', object: 'voice', ref_wav: null, ref_latent: null, ref_latents: [], ref_embed: null, no_ref: true },
    ],
};
let voicesRequests = [];

let lastPromptBody = null;
let ttsRequests = [];
let historyPolls = 0;
let promptPosts = 0;
let objectInfoRequests = 0;
let loraFiles = [{ name: 'animeDetail.safetensors' }, { name: 'inkSketch.safetensors' }];

function createServer() {
    return http.createServer((req, res) => {
        const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

        // OpenAI Compatible な audio/speech もどき
        if (url.pathname === '/mock-tts/v1/audio/speech' && req.method === 'POST') {
            let body = '';
            req.on('data', chunk => { body += chunk; });
            req.on('end', () => {
                let parsed = null;
                try { parsed = JSON.parse(body); } catch (_) { /* 非 JSON */ }
                ttsRequests.push({
                    body: parsed,
                    raw: body,
                    auth: req.headers['authorization'] || null,
                    contentType: req.headers['content-type'] || null,
                });
                res.setHeader('Content-Type', 'audio/wav');
                res.end(makeWav(20));
            });
            return;
        }
        if (url.pathname === '/mock-tts/requests' && req.method === 'DELETE') {
            ttsRequests = [];
            res.setHeader('Content-Type', 'application/json');
            res.end('[]');
            return;
        }
        if (url.pathname === '/mock-tts/requests') {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(ttsRequests));
            return;
        }

        // 参照ボイス一覧（Irodori 形）。取得回数とヘッダーを記録する
        if (url.pathname === '/mock-tts/v1/audio/voices' && req.method === 'GET') {
            voicesRequests.push({
                path: url.pathname,
                auth: req.headers['authorization'] || null,
                contentType: req.headers['content-type'] || null,
            });
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(MOCK_IRODORI_VOICES));
            return;
        }
        // /audio/voices が無く /voices だけ持つサーバー（Kokoro-FastAPI 形の戻り値）
        if (url.pathname === '/mock-tts-alt/v1/audio/voices' && req.method === 'GET') {
            voicesRequests.push({ path: url.pathname, auth: null, contentType: null });
            res.statusCode = 404;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'not found' }));
            return;
        }
        if (url.pathname === '/mock-tts-alt/v1/voices' && req.method === 'GET') {
            voicesRequests.push({ path: url.pathname, auth: null, contentType: null });
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ voices: ['af_heart', 'af_bella'] }));
            return;
        }
        // APIキーを求められるサーバー（他の候補も同じ認証で落ちるため、1 回で止まるはず）
        if (url.pathname === '/mock-tts-auth/v1/audio/voices' && req.method === 'GET') {
            voicesRequests.push({
                path: url.pathname,
                auth: req.headers['authorization'] || null,
                contentType: req.headers['content-type'] || null,
            });
            res.statusCode = 401;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'unauthorized' }));
            return;
        }
        // 一覧を一切返さないサーバー（全候補 404 → 「非対応」の案内）
        if (url.pathname.startsWith('/mock-tts-missing/') && req.method === 'GET') {
            voicesRequests.push({ path: url.pathname, auth: null, contentType: null });
            res.statusCode = 404;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'not found' }));
            return;
        }
        if (url.pathname === '/mock-tts/voices-requests' && req.method === 'DELETE') {
            voicesRequests = [];
            res.setHeader('Content-Type', 'application/json');
            res.end('[]');
            return;
        }
        if (url.pathname === '/mock-tts/voices-requests') {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(voicesRequests));
            return;
        }

        if (url.pathname.startsWith('/mock-comfy/')) {
            const endpoint = url.pathname.replace('/mock-comfy/', '');
            res.setHeader('Content-Type', 'application/json');
            if (endpoint === 'system_stats') {
                res.end(JSON.stringify({ system: { comfy_version: 'mock' } }));
                return;
            }
            if (endpoint === 'prompt' && req.method === 'POST') {
                promptPosts++;
                let body = '';
                req.on('data', chunk => { body += chunk; });
                req.on('end', () => {
                    lastPromptBody = body;
                    res.end(JSON.stringify({ prompt_id: 'mock-pid' }));
                });
                return;
            }
            if (endpoint.startsWith('history/')) {
                historyPolls++;
                if (historyPolls < 2) {
                    res.end(JSON.stringify({})); // 最初は未完了
                    return;
                }
                res.end(JSON.stringify({
                    'mock-pid': {
                        outputs: { '9': { images: [{ filename: 'mock_00001_.png', subfolder: '', type: 'output' }] } },
                        status: { status_str: 'success', status_details: {} },
                    },
                }));
                return;
            }
            if (endpoint === 'view') {
                res.setHeader('Content-Type', 'image/png');
                res.end(PNG_1PX);
                return;
            }
            if (endpoint === 'set-loras' && req.method === 'POST') {
                let body = '';
                req.on('data', chunk => { body += chunk; });
                req.on('end', () => {
                    try { loraFiles = JSON.parse(body); } catch (e) { loraFiles = []; }
                    res.end(JSON.stringify({ ok: true }));
                });
                return;
            }
            if (endpoint === 'models/loras') {
                res.end(JSON.stringify(loraFiles));
                return;
            }
            if (endpoint === 'object_info') {
                objectInfoRequests++;
                // UnetLoaderGGUF は意図的に返さない（無い環境での劣化確認用）
                res.end(JSON.stringify({
                    KSampler: {
                        input: {
                            required: {
                                sampler_name: [['euler_a', 'dpmpp_2m'], {}],
                                scheduler: [['karras', 'normal'], {}],
                            },
                        },
                    },
                    KSamplerAdvanced: {
                        input: { required: { sampler_name: [['dpmpp_2m_sde'], {}], scheduler: [['sgm_uniform'], {}] } },
                    },
                    CheckpointLoaderSimple: { input: { required: { ckpt_name: [['illustrious_xl.safetensors', 'v1.5.safetensors'], {}] } } },
                    UNETLoader: { input: { required: { unet_name: [['flux_unet.safetensors'], {}] } } },
                    VAELoader: { input: { required: { vae_name: [['ae.safetensors'], {}] } } },
                    TextEncoderLoader: { input: { required: { text_name1: [['clip_l.safetensors'], {}] } } },
                    // extraFromObjectInfo は /models/loras には無い名前。LoRA 一覧が object_info 由来であることを証明する
                    LoraLoader: { input: { required: { lora_name: [['animeDetail.safetensors', 'inkSketch.safetensors', 'extraFromObjectInfo.safetensors'], {}] } } },
                }));
                return;
            }
            res.statusCode = 404;
            res.end(JSON.stringify({ error: 'unknown mock endpoint ' + endpoint }));
            return;
        }

        // 静的ファイル
        const relative = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
        const filePath = path.join(ROOT, relative);
        if (!filePath.startsWith(ROOT) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
            res.statusCode = 404;
            res.end('not found');
            return;
        }
        const ext = path.extname(filePath).toLowerCase();
        const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.json': 'application/json' };
        res.setHeader('Content-Type', types[ext] || 'application/octet-stream');
        res.end(fs.readFileSync(filePath));
    });
}

const PAGE_SCRIPT = `(async () => {
    const pageErrors = [];
    window.addEventListener('error', e => pageErrors.push(String(e.message)));

    // 設定（実際の保存経路ではなく state に直接入れてよい。UI 経由は別確認）
    state.settings.apiProvider = 'gemini';
    state.settings.apiKey = 'test-key';
    state.settings.illustrationEnabled = true;
    state.settings.illustrationMode = 'manual';
    state.settings.comfyBaseUrl = location.origin + '/mock-comfy';
    // SillyTavern の既定ワークフローと同じトークン群＋文中埋め込み＋カスタム プレースホルダ
    state.settings.comfyWorkflows = [{
        id: 'wf-main',
        name: 'メイン',
        json: JSON.stringify({
            '2': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: '%model%' } },
            '12': { class_type: 'VAELoader', inputs: { vae_name: '%vae%' } },
            '13': { class_type: 'TextEncoderLoader', inputs: { text_name1: '%text_encoder%' } },
            '3': { class_type: 'CLIPTextEncode', inputs: { text: 'masterpiece, %prompt%' } },
            '4': { class_type: 'CLIPTextEncode', inputs: { text: '%negative_prompt%' } },
            '14': { class_type: 'CLIPSetLastLayer', inputs: { clip_skip: '%clip_skip%' } },
            '5': {
                class_type: 'KSampler',
                inputs: {
                    seed: '%seed%', width: '%width%', height: '%height%', steps: '%steps%', cfg: '%cfg%',
                    sampler_name: '%sampler%', scheduler: '%scheduler%', denoise: '%denoise%',
                },
            },
            '15': { class_type: 'Note', inputs: { text: '%outfit%' } },
            '9': { class_type: 'SaveImage', inputs: { images: null } },
        }),
    }];
    state.settings.comfyActiveWorkflowId = 'wf-main';
    state.settings.comfyCustomPlaceholders = [{ find: 'outfit', replace: '1girl, school uniform' }];
    state.settings.comfyModel = 'illustrious_xl.safetensors';
    state.settings.comfyVae = 'ae.safetensors';
    state.settings.comfyTextEncoder = 'clip_l.safetensors';
    state.settings.comfySampler = 'euler_a';
    state.settings.comfyScheduler = 'karras';
    state.settings.comfyDenoise = 0.85;
    state.settings.comfyClipSkip = 2;
    state.settings.comfyPromptPrefix = 'best quality';
    state.settings.comfyCharacterPrefix = '1girl, silver hair';
    state.settings.comfyNegativePrompt = 'lowres';
    state.settings.comfyWidth = 640;
    state.settings.comfyHeight = 480;
    state.settings.comfySeed = 12345;
    state.settings.comfyPollIntervalMs = 50;
    state.settings.aiName = '詩織';
    state.settings.userName = 'あなた';

    // モーダルは待たない
    uiUtils.showCustomAlert = async () => {};
    uiUtils.showCustomConfirm = async () => true;

    // 会話履歴（本編は完了済みという想定）
    state.currentMessages = [
        { role: 'user', content: '公園のベンチで語り合う場面を書いて', timestamp: Date.now() - 5000 },
        { role: 'model', content: '二人は公園のベンチに座り、夕暮れの中で語った。', timestamp: Date.now() - 4000 },
    ];
    uiUtils.renderChatMessages();

    // quiet 生成だけモックに差し替える（本編の LLM 経路は通さない）
    let quietRequest = null;
    const originalHandleSend = appLogic.handleSend.bind(appLogic);
    appLogic.handleSend = async (isRetry, retryIndex, context, isTop) => {
        quietRequest = {
            isBackground: !!context,
            historyLength: context && context.messages ? context.messages.length : 0,
            inputText: context ? context.inputText : null,
            systemPrompt: context ? context.systemPrompt : null,
        };
        return { content: 'a park at dusk, 1 man 1 woman, sitting on a bench, she is smiling' };
    };

    await appLogic.generateIllustration();
    appLogic.handleSend = originalHandleSend;

    const target = state.currentMessages[1];
    const renderedImage = document.querySelector('.message-illustration-image');

    // 履歴復元: 保存したチャットを読み直して挿絵が残っているか
    const chatId = state.currentChatId;
    let restored = false;
    if (chatId) {
        const raw = await dbUtils.getChat(chatId);
        restored = !!(raw && raw.messages && raw.messages[1] && raw.messages[1].illustration
            && Array.isArray(raw.messages[1].illustration.images)
            && raw.messages[1].illustration.images.length > 0
            && typeof raw.messages[1].illustration.images[0].dataUrl === 'string'
            && raw.messages[1].illustration.images[0].dataUrl.startsWith('data:image/'));
    }

    return {
        pageErrors: pageErrors,
        quietTemplate: illustrationUtils.substituteSessionNames(state.settings.comfyImagePromptTemplate),
        quietRequest: quietRequest,
        illustrationStatus: target.illustration ? target.illustration.status : null,
        illustrationError: target.illustration ? (target.illustration.error || null) : null,
        hasDataUrl: !!(target.illustration && Array.isArray(target.illustration.images)
            && target.illustration.images.length > 0
            && typeof target.illustration.images[0].dataUrl === 'string'
            && target.illustration.images[0].dataUrl.startsWith('data:image/')),
        seed: target.illustration ? target.illustration.seed : null,
        renderedImage: !!renderedImage,
        restoredFromDb: restored,
        mainTextIntact: state.currentMessages[1].content.indexOf('公園のベンチ') !== -1,
    };
})()`;

// 本編の送信を apiUtils.callGeminiApi だけ差し替えて流し、自動/手動の起動条件を観察する
const scenarioScript = (mode) => `(async () => {
    state.settings.illustrationMode = '${mode}';
    state.currentMessages = [];
    state.currentChatId = null;
    state.illustrationJob = null;
    uiUtils.renderChatMessages();
    const apiCalls = [];
    const originalCallGeminiApi = apiUtils.callGeminiApi;
    apiUtils.callGeminiApi = async (apiKey, model, messages) => {
        const last = messages[messages.length - 1];
        const content = last && last.parts ? last.parts.map(p => p.text || '').join('') : (last && last.content) || '';
        apiCalls.push({ content: content });
        const isQuiet = apiCalls.length > 1;
        const text = isQuiet ? 'a park at dusk, 1 man 1 woman, sitting on a bench' : '本編の応答です。';
        return { json: async () => ({ candidates: [{ content: { parts: [{ text: text }] }, finishReason: 'STOP' }] }) };
    };
    elements.userInput.value = '公園の場面を書いて';
    await appLogic.handleSend();
    if ('${mode}' === 'auto') {
        // 自動トリガーは setTimeout(0) で走る。起動を待ち、完了まで待つ
        for (let i = 0; i < 80 && !state.illustrationJob; i++) await new Promise(r => setTimeout(r, 25));
        for (let i = 0; i < 200 && state.illustrationJob; i++) await new Promise(r => setTimeout(r, 25));
    } else {
        // 手動では走らないはずなので、走るには十分な時間だけ待つ
        await new Promise(r => setTimeout(r, 1200));
    }
    apiUtils.callGeminiApi = originalCallGeminiApi;
    const modelMessage = state.currentMessages.find(m => m.role === 'model');
    return {
        mode: '${mode}',
        apiCallCount: apiCalls.length,
        quietUsedTemplate: apiCalls.length > 1
            && apiCalls[1].content === illustrationUtils.substituteSessionNames(state.settings.comfyImagePromptTemplate),
        mainText: modelMessage ? modelMessage.content : null,
        illustrationStatus: modelMessage && modelMessage.illustration ? modelMessage.illustration.status : null,
        hasImage: !!(modelMessage && modelMessage.illustration
            && Array.isArray(modelMessage.illustration.images)
            && modelMessage.illustration.images.length > 0),
    };
})()`;

// 失敗系: ComfyUI が落ちていても本編は使える / 不正ワークフロー / 連打 / Service Worker
const FAILURE_SCRIPT = `(async () => {
    const unreachableBase = 'http://127.0.0.1:1';
    const validWorkflows = JSON.parse(JSON.stringify(state.settings.comfyWorkflows));

    // 1) ComfyUI に届かない: 本編は残り、挿絵だけ失敗する
    state.settings.illustrationMode = 'auto';
    state.settings.comfyBaseUrl = unreachableBase;
    state.currentMessages = [];
    state.currentChatId = null;
    state.illustrationJob = null;
    uiUtils.renderChatMessages();
    const originalCallGeminiApi = apiUtils.callGeminiApi;
    apiUtils.callGeminiApi = async () => ({ json: async () => ({ candidates: [{ content: { parts: [{ text: '本編は使える' }] }, finishReason: 'STOP' }] }) });
    elements.userInput.value = '続けて';
    await appLogic.handleSend();
    for (let i = 0; i < 80 && !state.illustrationJob; i++) await new Promise(r => setTimeout(r, 25));
    for (let i = 0; i < 200 && state.illustrationJob; i++) await new Promise(r => setTimeout(r, 25));
    apiUtils.callGeminiApi = originalCallGeminiApi;

    const modelMessage = state.currentMessages.find(m => m.role === 'model');
    const unreachableResult = {
        mainText: modelMessage ? modelMessage.content : null,
        status: modelMessage && modelMessage.illustration ? modelMessage.illustration.status : null,
        mentionsCors: !!(modelMessage && modelMessage.illustration && /--enable-cors-header/.test(modelMessage.illustration.error || '')),
        error: modelMessage && modelMessage.illustration ? modelMessage.illustration.error : null,
        shownInDom: !!(document.querySelector('.message-illustration-error') && /--enable-cors-header/.test(document.querySelector('.message-illustration-error').textContent)),
    };

    // 2) UI形式のワークフローは、LLMを呼ぶ前に理由付きで拒否される
    const originalHandleSendForWorkflow = appLogic.handleSend.bind(appLogic);
    let workflowCaseLlmCalls = 0;
    appLogic.handleSend = async () => { workflowCaseLlmCalls++; return { content: 'a bench, 1 man 1 woman' }; };
    state.settings.comfyWorkflows = [{ id: 'wf-bad', name: 'UI形式', json: JSON.stringify({ nodes: [{ id: 1 }], links: [] }) }];
    state.settings.comfyActiveWorkflowId = 'wf-bad';
    state.currentMessages = [
        { role: 'user', content: 'x', timestamp: Date.now() },
        { role: 'model', content: 'y', timestamp: Date.now() },
    ];
    uiUtils.renderChatMessages();
    // ページ内で ComfyUI への投入回数を見る
    const originalSubmitWithClient = appLogic.submitWithClient.bind(appLogic);
    let postsDuringCases = 0;
    appLogic.submitWithClient = (...args) => { postsDuringCases++; return originalSubmitWithClient(...args); };
    await appLogic.generateIllustration();
    const badWorkflowResult = {
        status: state.currentMessages[1].illustration ? state.currentMessages[1].illustration.status : null,
        mentionsUiFormat: /UI形式/.test(state.currentMessages[1].illustration.error || ''),
        error: state.currentMessages[1].illustration.error,
        spentLlmCall: workflowCaseLlmCalls > 0,
        posted: postsDuringCases > 0,
    };

    // 2b) 未対応のプレースホルダ: ComfyUI へ送らず、LLM も消費せず、トークン名を表示する
    state.settings.comfyBaseUrl = location.origin + '/mock-comfy';
    state.settings.comfyWorkflows = [{
        id: 'wf-unknown', name: '未知トークン',
        json: JSON.stringify({
            '3': { class_type: 'CLIPTextEncode', inputs: { text: '%nonexistent_token%' } },
            '9': { class_type: 'SaveImage', inputs: { images: null } },
        }),
    }];
    state.settings.comfyActiveWorkflowId = 'wf-unknown';
    state.currentMessages = [
        { role: 'user', content: 'x', timestamp: Date.now() },
        { role: 'model', content: 'y', timestamp: Date.now() },
    ];
    uiUtils.renderChatMessages();
    const llmCallsBeforeUnknown = workflowCaseLlmCalls;
    const postsBeforeUnknown = postsDuringCases;
    await appLogic.generateIllustration();
    const unknownTokenResult = {
        status: state.currentMessages[1].illustration ? state.currentMessages[1].illustration.status : null,
        error: state.currentMessages[1].illustration ? state.currentMessages[1].illustration.error : null,
        namesToken: /nonexistent_token/.test(state.currentMessages[1].illustration.error || ''),
        posted: postsDuringCases > postsBeforeUnknown,
        spentLlmCall: workflowCaseLlmCalls > llmCallsBeforeUnknown,
    };
    appLogic.submitWithClient = originalSubmitWithClient;
    appLogic.handleSend = originalHandleSendForWorkflow;
    state.settings.comfyWorkflows = validWorkflows;
    state.settings.comfyActiveWorkflowId = validWorkflows[0].id;

    // 3) 連打: 実行中の再要求は断られ、ComfyUI への投入は1件のまま
    state.settings.comfyBaseUrl = location.origin + '/mock-comfy';
    state.currentMessages = [
        { role: 'user', content: 'x', timestamp: Date.now() },
        { role: 'model', content: 'z', timestamp: Date.now() },
    ];
    uiUtils.renderChatMessages();
    const originalHandleSend = appLogic.handleSend.bind(appLogic);
    appLogic.handleSend = async () => ({ content: 'a bench, 1 man 1 woman' });
    const first = appLogic.generateIllustration();
    const second = appLogic.generateIllustration();
    await Promise.all([first, second]);
    appLogic.handleSend = originalHandleSend;
    const rapidTapResult = {
        status: state.currentMessages[1].illustration ? state.currentMessages[1].illustration.status : null,
        jobReleased: state.illustrationJob === null,
    };

    // 4) Service Worker: 登録され、キャッシュ名が上がっている
    let swVersion = null;
    let swRegistered = false;
    try {
        const registration = await navigator.serviceWorker.ready;
        swRegistered = !!registration;
        const text = await (await fetch('./sw.js')).text();
        const match = text.match(/CACHE_NAME = '([^']+)'/);
        swVersion = match ? match[1] : null;
    } catch (e) { /* SW 不可の環境 */ }

    return {
        unreachableResult, badWorkflowResult, unknownTokenResult, rapidTapResult,
        swRegistered, swVersion,
    };
})()`;

// 保存 → ページを開き直す → 履歴から挿絵が表示されるか
const RELOAD_SETUP = `(async () => {
    state.settings.apiProvider = 'gemini';
    state.settings.apiKey = 'test-key';
    state.settings.illustrationEnabled = true;
    state.settings.illustrationMode = 'manual';
    state.settings.comfyBaseUrl = location.origin + '/mock-comfy';
    state.settings.comfyWorkflows = [{
        id: 'wf-reload', name: 'リロード確認',
        json: JSON.stringify({
            '3': { class_type: 'CLIPTextEncode', inputs: { text: '%prompt%' } },
            '5': { class_type: 'KSampler', inputs: { seed: '%seed%', width: '%width%', height: '%height%' } },
            '9': { class_type: 'SaveImage', inputs: { images: null } },
        }),
    }];
    state.settings.comfyActiveWorkflowId = 'wf-reload';
    state.settings.comfyImagePromptTemplate = 'keywords please {{char}} {{user}}';
    state.settings.aiName = '詩織';
    state.settings.userName = 'あなた';
    uiUtils.showCustomAlert = async () => {};
    uiUtils.showCustomConfirm = async () => true;

    // 設定を UI 経由で保存し、開き直後に復元されることを確認する
    uiUtils.applySettingsToUI();
    await appLogic.saveSettings(false);

    state.currentChatId = null;
    state.illustrationJob = null;
    state.currentMessages = [
        { role: 'user', content: 'リロード確認', timestamp: Date.now() - 3000 },
        { role: 'model', content: 'リロード前に表示されていた本編', timestamp: Date.now() - 2000 },
    ];
    uiUtils.renderChatMessages();
    const originalHandleSend = appLogic.handleSend.bind(appLogic);
    appLogic.handleSend = async () => ({ content: 'a bench at dusk, 1 man 1 woman' });
    await appLogic.generateIllustration();
    appLogic.handleSend = originalHandleSend;
    await dbUtils.saveChat();
    return { chatId: state.currentChatId, status: state.currentMessages[1].illustration ? state.currentMessages[1].illustration.status : null, error: state.currentMessages[1].illustration ? state.currentMessages[1].illustration.error : null, workflow: JSON.stringify(state.settings.comfyWorkflows), activeId: state.settings.comfyActiveWorkflowId, base: state.settings.comfyBaseUrl };
})()`;

const RELOAD_VERIFY = `(async () => {
    // ページを開き直した直後の状態。設定も履歴も IndexedDB から復元されているはず
    const chatId = ${'__CHAT_ID__'};
    await appLogic.loadChat(chatId);
    const image = document.querySelector('.message-illustration-image');
    return {
        settingsRestored: !!state.settings.comfyBaseUrl && state.settings.illustrationEnabled === true,
        templateRestored: /詩織/.test(illustrationUtils.substituteSessionNames(state.settings.comfyImagePromptTemplate)),
        illustrationStatus: state.currentMessages[1] && state.currentMessages[1].illustration
            ? state.currentMessages[1].illustration.status : null,
        imageRendered: !!image,
        imageSrcIsDataUrl: !!(image && String(image.src).startsWith('data:image/')),
    };
})()`;

// 一覧取得 → プルダウン反映、ワークフロー CRUD、挿絵削除ボタン
const CHOICES_SCRIPT = `(async () => {
    uiUtils.applyIllustrationSettingsToUI();
    const before = document.querySelectorAll('#comfy-model-select option').length;
    const result = await comfyWorkflowUtils.refreshChoices(elements.comfyObjectInfoStatus, true);
    const optionText = (select) => Array.from(select.options).map(o => o.value);
    const labelOf = (select) => {
        const opt = Array.from(select.options).find(o => o.value === select.value);
        return opt ? opt.textContent : null;
    };
    // 一覧に無い値は消さずに表示する
    state.settings.comfyModel = 'removed_model.safetensors';
    comfyWorkflowUtils.renderTokenDropdowns();
    const staleKept = Array.from(elements.comfyModelSelect.options).some(o => o.value === 'removed_model.safetensors');
    state.settings.comfyModel = 'illustrious_xl.safetensors';
    comfyWorkflowUtils.renderTokenDropdowns();

    // ワークフロー CRUD
    const added = await comfyWorkflowUtils.addWorkflow('{"9":{"class_type":"SaveImage","inputs":{}}}', 'テスト');
    const renamed = added.ok;
    await comfyWorkflowUtils.renameWorkflow(added.workflow.id, 'テスト');
    const sameNameKept = comfyWorkflowUtils.findWorkflow(added.workflow.id).name === 'テスト';
    await comfyWorkflowUtils.duplicateWorkflow(added.workflow.id);
    const duplicated = comfyWorkflowUtils.getList().length === 3;
    await comfyWorkflowUtils.deleteWorkflow(added.workflow.id);
    const afterDelete = comfyWorkflowUtils.getList().length === 2
        && !!illustrationUtils.activeWorkflow();
    const uiRejected = (await comfyWorkflowUtils.addWorkflow('{"nodes":[],"links":[]}', 'bad')).ok === false;

    // LoRA も object_info から一緒に取れる（/models/loras には無い名前が入っていれば object_info 由来の証明）
    const lorasFromObjectInfo = (comfyWorkflowUtils.loraChoices || []).includes('extraFromObjectInfo.safetensors');
    // 生成経路も illustrationUtils.loraCache を使うので、そこに同じ一覧が入っていれば生成時の再取得は省ける
    const loraCached = !!(illustrationUtils.loraCache && illustrationUtils.loraCache.names.includes('extraFromObjectInfo.safetensors'));
    const loraStatusShown = /LoRA 取得OK/.test(elements.comfyLoraStatus.textContent);
    const loraSlotHasChoices = Array.from(elements.comfyLoraRows.querySelectorAll('select'))
        .every(select => Array.from(select.options).some(o => o.value === 'extraFromObjectInfo.safetensors'));

    // 編集画面のトークン検出
    comfyWorkflowUtils.renderEditor();
    const tokenListText = document.getElementById('comfy-token-status-list').textContent;

    return {
        refreshOk: result.ok,
        optionsBefore: before,
        models: optionText(elements.comfyModelSelect),
        vaes: optionText(elements.comfyVaeSelect),
        textEncoders: optionText(elements.comfyTextEncoderSelect),
        samplers: optionText(elements.comfySamplerSelect),
        schedulers: optionText(elements.comfySchedulerSelect),
        ggufAbsent: !optionText(elements.comfyModelSelect).some(v => /gguf/i.test(v)),
        modelLabelReadable: labelOf(elements.comfyModelSelect),
        vaeLabelReadable: labelOf(elements.comfyVaeSelect),
        textEncoderLabelReadable: labelOf(elements.comfyTextEncoderSelect),
        staleValueKept: staleKept,
        lorasFromObjectInfo: lorasFromObjectInfo,
        loraCached: loraCached,
        loraStatusShown: loraStatusShown,
        loraSlotHasChoices: loraSlotHasChoices,
        crudOk: renamed && sameNameKept && duplicated && afterDelete && uiRejected,
        tokenDetected: /model/.test(tokenListText) && /clip_skip/.test(tokenListText),
    };
})()`;

// 「接続確認＆モデル一覧取得」ボタン: system_stats で接続を見てから object_info を取り、LoRA も一緒に取る
const CONNECTION_BUTTON_SCRIPT = `(async () => {
    state.settings.comfyBaseUrl = location.origin + '/mock-comfy';
    uiUtils.applyIllustrationSettingsToUI();
    comfyWorkflowUtils.objectInfoCache = null;
    comfyWorkflowUtils.choices = null;
    comfyWorkflowUtils.loraChoices = null;
    illustrationUtils.loraCache = null;
    elements.comfyObjectInfoStatus.textContent = '';
    elements.comfyLoraStatus.textContent = '';
    const label = elements.comfyConnectionTestBtn.textContent.trim();
    elements.comfyConnectionTestBtn.click();
    // 接続OKを先に出し、その後に一覧とLoRAが進むので、LoRA欄が埋まるまで待つ
    let waited = 0;
    while (waited < 5000 && !/LoRA 取得OK/.test(elements.comfyLoraStatus.textContent)) {
        await new Promise(resolve => setTimeout(resolve, 50));
        waited += 50;
    }
    return {
        label: label,
        connection: elements.comfyConnectionStatus.textContent,
        objectInfo: elements.comfyObjectInfoStatus.textContent,
        lora: elements.comfyLoraStatus.textContent,
        models: Array.from(elements.comfyModelSelect.options).map(o => o.value),
        loraChoices: comfyWorkflowUtils.loraChoices || [],
    };
})()`;

// DeepSeek: モデル欄は model id をそのまま表示し、パラメータの効きが条件付きだと注釈に書く
const DEEPSEEK_UI_SCRIPT = `(() => {
    const select = elements.deepSeekModelNameSelect;
    const options = Array.from(select.options).filter(option => option.value);
    const groups = Array.from(select.querySelectorAll('optgroup')).map(group => group.label);
    const currentIds = options
        .filter(option => option.parentElement && option.parentElement.label === '現行')
        .map(option => option.value).join(',');
    const note = document.querySelector('#settings-group-deepseek-other-params p');
    const noteText = note ? note.textContent : '';
    return {
        labelsMatchValues: options.length > 0 && options.every(option => option.textContent.trim() === option.value),
        currentIds: currentIds === 'deepseek-flash,deepseek-v4-pro',
        retiredSplit: groups.some(label => /世代廃止/.test(label)) && groups.some(label => /廃止済み/.test(label)),
        datedNote: /2026-10-07/.test(noteText),
        temperatureConditional: /temperature.*Thinking OFF のときだけ効きます/s.test(noteText),
        topPConditional: /top_p.*Thinking ON のときだけ効きます/s.test(noteText),
        penaltiesIneffective: /presence_penalty.*効果はありません/s.test(noteText),
    };
})()`;

// 複数枚の表示・削除・全画面・プロンプト編集・書き出し名
const GALLERY_SCRIPT = `(async () => {
    state.settings.illustrationEnabled = true;
    state.settings.comfyBaseUrl = location.origin + '/mock-comfy';
    state.illustrationJob = null;
    state.currentMessages = [
        { role: 'user', content: 'x', timestamp: Date.now() },
        { role: 'model', content: '画像を複数枚持つ応答 ' + '本文。'.repeat(300), timestamp: Date.now() },
    ];
    state.currentMessages[1].illustration = {
        status: 'done', prompt: '保存済みのプロンプト', negativePrompt: 'lowres', seed: 1,
        images: [
            { dataUrl: 'data:image/png;base64,AAAA', seed: 1, prompt: 'p1' },
            { dataUrl: 'data:image/png;base64,BBBB', seed: 2, prompt: 'p2' },
        ],
        viewIndex: 1,
    };
    uiUtils.renderChatMessages();

    const imageEl = () => document.querySelector('.message-illustration-image');
    const counter = () => {
        const el = document.querySelector('.message-illustration-counter');
        return el ? el.textContent.trim() : null;
    };

    // ◀ で古い方、▶ で新しい方
    const newestSrc = imageEl().src;
    document.querySelector('.js-illustration-prev-btn').click();
    const olderSrc = imageEl().src;
    const counterAfterPrev = counter();
    document.querySelector('.js-illustration-next-btn').click();
    const backToNewestSrc = imageEl().src;
    const counterAfterNext = counter();

    // スクロール位置の維持。同じ寸法の画像へ差し替えても、ブロックを一瞬潰すと
    // 文書が縮んでビューが飛ぶ（画像の上端だけが見える位置へジャンプする）
    const square = (color) => 'data:image/svg+xml;utf8,' + encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="600">'
        + '<rect width="300" height="600" fill="' + color + '"/></svg>');
    const galleryIllustration = state.currentMessages[1].illustration;
    galleryIllustration.images[0].dataUrl = square('#666');
    galleryIllustration.images[1].dataUrl = square('#888');
    galleryIllustration.viewIndex = 1;
    uiUtils.rerenderIllustration(1);
    await new Promise(r => setTimeout(r, 400));
    const mainContent = elements.chatScreen.querySelector('.main-content');
    const scrollable = mainContent.scrollHeight > mainContent.clientHeight + 200;

    mainContent.scrollTop = mainContent.scrollHeight;
    await new Promise(r => setTimeout(r, 150));
    const scrollBeforeCycle = mainContent.scrollTop;
    document.querySelector('.js-illustration-prev-btn').click();
    await new Promise(r => setTimeout(r, 400));
    const scrollAfterCycle = mainContent.scrollTop;

    mainContent.scrollTop = mainContent.scrollHeight;
    await new Promise(r => setTimeout(r, 150));
    const scrollBeforeReceive = mainContent.scrollTop;
    illustrationUtils.pushImage(galleryIllustration,
        { dataUrl: square('#aaa'), seed: 3, prompt: 'p3', createdAt: Date.now() });
    uiUtils.rerenderIllustration(1);
    await new Promise(r => setTimeout(r, 500));
    const scrollAfterReceive = mainContent.scrollTop;

    // クリックで全画面。画像をタップしても閉じず、✕ ボタンと画像外のタップで閉じる
    imageEl().click();
    const lightboxOpened = !!document.querySelector('.illustration-lightbox');
    let lightbox = document.querySelector('.illustration-lightbox');
    if (lightbox) lightbox.querySelector('img').click();
    const staysOpenOnImageTap = !!document.querySelector('.illustration-lightbox');
    lightbox = document.querySelector('.illustration-lightbox');
    if (lightbox) lightbox.querySelector('.illustration-lightbox-close').click();
    const closedByCloseButton = !document.querySelector('.illustration-lightbox');
    imageEl().click();
    lightbox = document.querySelector('.illustration-lightbox');
    if (lightbox) lightbox.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    const closedByOutsideTap = !document.querySelector('.illustration-lightbox');

    // 画像プロンプト欄: コピーボタンがあり、展開中は編集できる（削除の前に確認する）
    const copyButtonExists = !!document.querySelector('.js-illustration-prompt-copy-btn');
    const promptTextarea = document.querySelector('textarea.message-illustration-prompt-input');
    let editedSaved = false;
    if (promptTextarea) {
        promptTextarea.value = '編集後のプロンプト';
        promptTextarea.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise(r => setTimeout(r, 250));
        editedSaved = !!(state.currentMessages[1].illustration
            && state.currentMessages[1].illustration.prompt === '編集後のプロンプト');
    }

    // 削除はアプリ内ダイアログで確認し、1枚と全枚で文言が違う
    const confirmTexts = [];
    const originalConfirm = uiUtils.showCustomConfirm;
    uiUtils.showCustomConfirm = async (message) => { confirmTexts.push(message); return true; };
    document.querySelector('.js-illustration-delete-one-btn').click();
    await new Promise(r => setTimeout(r, 250));
    const imagesAfterOneDelete = state.currentMessages[1].illustration
        ? state.currentMessages[1].illustration.images.length : 0;
    document.querySelector('.js-illustration-delete-all-btn').click();
    await new Promise(r => setTimeout(r, 250));
    const illustrationAfterAllDelete = state.currentMessages[1].illustration;
    uiUtils.showCustomConfirm = originalConfirm;

    return {
        newestSrc: newestSrc,
        olderSrc: olderSrc,
        backToNewestSrc: backToNewestSrc,
        counterAfterPrev: counterAfterPrev,
        counterAfterNext: counterAfterNext,
        scrollable: scrollable,
        scrollBeforeCycle: scrollBeforeCycle, scrollAfterCycle: scrollAfterCycle,
        scrollBeforeReceive: scrollBeforeReceive, scrollAfterReceive: scrollAfterReceive,
        lightboxOpened: lightboxOpened,
        staysOpenOnImageTap: staysOpenOnImageTap,
        closedByCloseButton: closedByCloseButton,
        closedByOutsideTap: closedByOutsideTap,
        confirmTexts: confirmTexts,
        imagesAfterOneDelete: imagesAfterOneDelete,
        illustrationAfterAllDelete: illustrationAfterAllDelete,
        copyButtonExists: copyButtonExists,
        editedSaved: editedSaved,
        fileStamp: comfyWorkflowUtils.fileTimestamp(),
        exportName: comfyWorkflowUtils.safeFileName('my flow/v1') + '-' + comfyWorkflowUtils.fileTimestamp() + '.json',
    };
})()`;

// 挿絵の自動/手動ボタンは文字がはみ出さず、読み上げのメガホンはまだ出さない
const FOOTER_BUTTON_SCRIPT = `(async () => {
    state.settings.illustrationEnabled = false;
    uiUtils.updateIllustrationFooterButtons();
    const toggle = elements.illustrationModeToggleBtn;
    const hiddenWhenDisabled = toggle.classList.contains('hidden');
    state.settings.illustrationEnabled = true;
    state.settings.illustrationMode = 'auto';
    uiUtils.updateIllustrationFooterButtons();
    // background-color に transition があるので、読み取る前に落ち着かせる
    await new Promise(r => setTimeout(r, 400));
    const autoLabel = toggle.textContent;
    const autoClasses = toggle.classList.contains('mode-auto') && !toggle.classList.contains('mode-manual');
    const autoStyle = getComputedStyle(toggle);
    const noOverflow = autoStyle.whiteSpace === 'nowrap' && toggle.scrollWidth <= toggle.clientWidth + 1;
    const rgb = (value) => value.replace(/\\s/g, '');
    const autoColors = rgb(autoStyle.color) === 'rgb(255,255,255)'
        && rgb(autoStyle.backgroundColor) === 'rgb(198,40,40)';
    state.settings.illustrationMode = 'manual';
    uiUtils.updateIllustrationFooterButtons();
    await new Promise(r => setTimeout(r, 400));
    const manualLabel = toggle.textContent;
    const manualClasses = toggle.classList.contains('mode-manual') && !toggle.classList.contains('mode-auto');
    const manualColors = rgb(getComputedStyle(toggle).backgroundColor) === 'rgb(117,117,117)';
    state.settings.illustrationMode = 'manual';
    uiUtils.updateIllustrationFooterButtons();
    // 読み上げの自動/手動ボタン。自動は赤地に白のメガホン、手動はグレー地に白のメガホン
    const megaphone = document.getElementById('tts-mode-toggle-btn');
    const megaphoneHiddenWhenDisabled = megaphone.classList.contains('hidden');
    state.settings.ttsEnabled = true;
    state.settings.ttsMode = 'auto';
    uiUtils.updateTtsFooterButton();
    await new Promise(r => setTimeout(r, 400));
    const ttsAutoClasses = megaphone.classList.contains('mode-auto') && !megaphone.classList.contains('mode-manual');
    const ttsAutoStyle = getComputedStyle(megaphone);
    const ttsAutoColors = rgb(ttsAutoStyle.color) === 'rgb(255,255,255)'
        && rgb(ttsAutoStyle.backgroundColor) === 'rgb(198,40,40)';
    state.settings.ttsMode = 'manual';
    uiUtils.updateTtsFooterButton();
    await new Promise(r => setTimeout(r, 400));
    const ttsManualClasses = megaphone.classList.contains('mode-manual') && !megaphone.classList.contains('mode-auto');
    const ttsManualColors = rgb(getComputedStyle(megaphone).backgroundColor) === 'rgb(117,117,117)';
    const ttsVisibleWhenEnabled = !megaphone.classList.contains('hidden');
    state.settings.ttsEnabled = false;
    uiUtils.updateTtsFooterButton();
    return {
        hiddenWhenDisabled: hiddenWhenDisabled,
        autoLabel: autoLabel, manualLabel: manualLabel,
        autoClasses: autoClasses, manualClasses: manualClasses,
        noOverflow: noOverflow, autoColors: autoColors, manualColors: manualColors,
        megaphoneIcon: !!megaphone.querySelector('svg'),
        megaphoneHidden: megaphoneHiddenWhenDisabled,
        ttsVisibleWhenEnabled: ttsVisibleWhenEnabled,
        ttsAutoClasses: ttsAutoClasses, ttsAutoColors: ttsAutoColors,
        ttsManualClasses: ttsManualClasses, ttsManualColors: ttsManualColors,
    };
})()`;

// LLM 応答のストリーミング表示に追従してスクロールしない（ユーザーが動かした位置を保つ）
const STREAM_SCROLL_SCRIPT = `(async () => {
    state.settings.autoScrollOnNewMessage = true;
    state.currentMessages = [{ role: 'user', content: '長く返して', timestamp: Date.now() }];
    uiUtils.renderChatMessages();
    const index = state.currentMessages.length;
    state.currentMessages.push({ role: 'model', content: '', timestamp: Date.now() });
    uiUtils.appendMessage('model', '', index, true);
    const mainContent = elements.chatScreen.querySelector('.main-content');
    const chunk = 'いちにさんしごろくしちはちじゅう。';
    state.partialStreamContent = '';
    for (let i = 0; i < 150; i++) state.partialStreamContent += chunk;
    await uiUtils.updateStreamingMessage(index, chunk, false);
    await new Promise(r => setTimeout(r, 200));
    const scrollable = mainContent.scrollHeight > mainContent.clientHeight + 200;
    mainContent.scrollTop = 400;
    await new Promise(r => setTimeout(r, 150));
    const before = mainContent.scrollTop;
    for (let i = 0; i < 40; i++) {
        state.partialStreamContent += chunk;
        await uiUtils.updateStreamingMessage(index, chunk, false);
    }
    await new Promise(r => setTimeout(r, 250));
    const during = mainContent.scrollTop;
    state.currentMessages[index].content = state.partialStreamContent;
    uiUtils.finalizeStreamingMessage(index);
    await new Promise(r => setTimeout(r, 250));
    const afterFinalize = mainContent.scrollTop;
    return {
        scrollable: scrollable, before: before, during: during, afterFinalize: afterFinalize,
    };
})()`;

// 読み上げの設定欄と、応答ごとのメガホンボタン
const TTS_UI_SCRIPT = `(() => {
    const group = document.getElementById('settings-group-tts');
    const requiredIds = [
        'tts-enabled-toggle', 'tts-auto-speak-toggle', 'tts-endpoint', 'tts-api-key', 'tts-model',
        'tts-voices', 'tts-speed', 'tts-default-voice', 'tts-generic-voice', 'tts-speaker-rows',
        'tts-narrate-dialogue-only-toggle', 'tts-regex-enabled-toggle', 'tts-regex-pattern',
        'tts-connection-test-btn', 'tts-voice-test-btn', 'tts-stop-btn',
        'tts-voice-list', 'tts-voice-list-status',
    ];
    const missingIds = requiredIds.filter(id => !document.getElementById(id));

    state.settings.ttsEnabled = true;
    state.settings.ttsVoices = 'alloy, echo, nova';
    state.settings.ttsSpeakers = [{ name: 'まゆみ', voice: 'echo' }];
    uiUtils.applyTtsSettingsToUI();

    const speakerRows = elements.ttsSpeakerRows.querySelectorAll('input.js-tts-speaker-name').length;
    const voiceOptions = Array.from(elements.ttsDefaultVoiceSelect.options).map(o => o.value);
    const speakerVoiceValue = elements.ttsSpeakerRows
        .querySelector('select.js-tts-speaker-voice').value;

    // 応答本文にメガホンボタンが付くか
    const modelIndex = state.currentMessages.findIndex(m => m.role === 'model');
    const megaphones = document.querySelectorAll('.message-actions .js-tts-btn');
    const megaphoneForModel = modelIndex !== -1
        && !!document.querySelector('.message-actions .js-tts-btn[data-index="' + modelIndex + '"] svg');

    // 後続の再読込テストに影響しないよう戻す
    state.settings.ttsEnabled = false;
    state.settings.ttsVoices = '';
    state.settings.ttsSpeakers = [];

    return {
        groupExists: !!group,
        missingIds: missingIds,
        speakerRows: speakerRows,
        voiceOptions: voiceOptions,
        speakerVoiceValue: speakerVoiceValue,
        megaphoneCount: megaphones.length,
        megaphoneForModel: megaphoneForModel,
    };
})()`;

// 参照ボイス一覧: サーバーから取得してチェックボックスで選び、一覧非対応でも手入力は生かす
const TTS_VOICES_SCRIPT = `(async () => {
    const settingsSnapshot = JSON.parse(JSON.stringify(state.settings));
    const waitStatus = async () => {
        let waited = 0;
        while ((elements.ttsStatus.textContent === '確認中…' || elements.ttsStatus.textContent === '再生中…')
            && waited < 8000) {
            await new Promise(r => setTimeout(r, 100));
            waited += 100;
        }
        await new Promise(r => setTimeout(r, 150));
    };
    const options = () => Array.from(elements.ttsDefaultVoiceSelect.options).map(o => o.value);
    const speakerOptions = () => Array.from(
        elements.ttsSpeakerRows.querySelector('select.js-tts-speaker-voice').options).map(o => o.value);
    const boxes = () => Array.from(elements.ttsVoiceList.querySelectorAll('input.js-tts-voice-check'));
    const checked = () => boxes().filter(b => b.checked).map(b => b.value);
    const labels = () => boxes().map(b => b.parentElement.textContent.trim());
    const json = async (path) => await (await fetch(path)).json();
    // 一覧取得は未保存の URL でも試せるよう入力欄を優先するので、テストも入力欄側で切り替える
    const setEndpoint = (path) => {
        state.settings.ttsEndpoint = path;
        elements.ttsEndpointInput.value = path;
    };

    state.settings.ttsEnabled = true;
    setEndpoint(location.origin + '/mock-tts/v1');
    state.settings.ttsApiKey = '';
    state.settings.ttsModel = 'mock-tts-model';
    state.settings.ttsVoices = '';
    state.settings.ttsDefaultVoice = '';
    state.settings.ttsGenericVoice = '';
    state.settings.ttsSpeakers = [{ name: 'まゆみ', voice: '' }];
    ttsUtils.voicesCache = null;
    uiUtils.applyTtsSettingsToUI();
    const beforeFetch = options();
    const emptyListText = elements.ttsVoiceList.textContent;

    // 新規（未設定）で取得: no_ref 専用だけ OFF、他は ON
    elements.ttsTestBtn.click();
    await waitStatus();
    const statusFirstFetch = elements.ttsStatus.textContent;
    const checksFirstFetch = checked();
    const labelsFirstFetch = labels();
    const listStatusFirstFetch = elements.ttsVoiceListStatus.textContent;
    const afterFirstFetch = options();
    const inputFirstFetch = elements.ttsVoicesInput.value;

    // 既存の選択がある状態で再取得: 既存選択は ON のまま、カタログの新規は OFF
    state.settings.ttsVoices = 'alloy, echo,';
    state.settings.ttsDefaultVoice = 'alloy';
    state.settings.ttsSpeakers = [{ name: 'まゆみ', voice: 'echo' }];
    uiUtils.applyTtsSettingsToUI();
    elements.ttsTestBtn.click();
    await waitStatus();
    const checksSecondFetch = checked();
    const labelsSecondFetch = labels();
    const afterSecondFetch = options();
    const afterSecondFetchSpeaker = speakerOptions();

    // チェックを外すと ttsVoices・入力欄・話者選択から消える
    const momo = boxes().find(b => b.value === 'momo');
    momo.checked = true;
    momo.dispatchEvent(new Event('change'));
    const afterCheckMomo = state.settings.ttsVoices;
    const momoBox = boxes().find(b => b.value === 'momo');
    momoBox.checked = false;
    momoBox.dispatchEvent(new Event('change'));
    const afterUncheck = state.settings.ttsVoices;
    const inputAfterUncheck = elements.ttsVoicesInput.value;
    const optionsAfterUncheck = options();

    // 一覧 API が無いサーバー: /voices へフォールバックし、Kokoro 形は「種別不明」
    setEndpoint(location.origin + '/mock-tts-alt/v1');
    elements.ttsTestBtn.click();
    await waitStatus();
    const statusFallback = elements.ttsStatus.textContent;
    const checksFallback = checked();
    const labelsFallback = labels();

    // APIキーを求められるサーバーは全候補を回さず、1 回で止まる
    await fetch('/mock-tts/voices-requests', { method: 'DELETE' });
    setEndpoint(location.origin + '/mock-tts-auth/v1');
    elements.ttsTestBtn.click();
    await waitStatus();
    const statusAuth = elements.ttsStatus.textContent;
    const authRequests = await json('/mock-tts/voices-requests');

    // 一覧非対応（全候補 404）でも、詳細欄の入力は話者選択へ反映される
    setEndpoint(location.origin + '/mock-tts-missing/v1');
    elements.ttsVoicesInput.value = 'nope1, nope2';
    elements.ttsTestBtn.click();
    await waitStatus();
    const statusMissing = elements.ttsStatus.textContent;
    const afterMissing = options();
    const inputAfterMissing = elements.ttsVoicesInput.value;

    // 疎通が失敗する先ではプルダウンもチェック一覧も変えない
    const checksBeforeDown = checked();
    setEndpoint('http://127.0.0.1:1/v1');
    elements.ttsVoicesInput.value = 'nope3';
    elements.ttsTestBtn.click();
    await waitStatus();
    const statusDown = elements.ttsStatus.textContent;
    const checksAfterDown = checked();
    const optionsAfterDown = options();

    // キャッシュ: force なしは 2 回目が cached:true でリクエストを増やさない
    setEndpoint(location.origin + '/mock-tts/v1');
    await fetch('/mock-tts/voices-requests', { method: 'DELETE' });
    await ttsUtils.fetchVoices({ force: true });
    const secondCall = await ttsUtils.fetchVoices({ force: false });
    const cacheRequests = await json('/mock-tts/voices-requests');

    // 設定の再描画は再取得しない（自動取得が無いこと）
    uiUtils.applyTtsSettingsToUI();
    const requestsAfterApply = (await json('/mock-tts/voices-requests')).length;

    // GET に Content-Type を付けず、APIキーが空なら Authorization も送らない
    const firstVoiceRequest = cacheRequests[0] || {};

    // テスト再生: 設定のデフォルトが空なら、チェック済み最初のもので合成する
    state.settings.ttsVoices = 'rima,';
    state.settings.ttsDefaultVoice = '';
    uiUtils.applyTtsSettingsToUI();
    await fetch('/mock-tts/requests', { method: 'DELETE' });
    elements.ttsVoiceTestBtn.click();
    await waitStatus();
    const speechRequests = await json('/mock-tts/requests');

    // 保存時の末尾カンマと空項目除外（詳細欄の入力がそのまま保存される）
    elements.ttsVoicesInput.value = 'alloy, echo';
    await appLogic.saveSettings(false);
    const savedVoices = state.settings.ttsVoices;
    const savedChoices = ttsUtils.voiceChoices();

    state.settings = settingsSnapshot;
    ttsUtils.voicesCache = null;
    ttsUtils.stopAll();
    return {
        beforeFetch: beforeFetch, emptyListText: emptyListText,
        statusFirstFetch: statusFirstFetch, checksFirstFetch: checksFirstFetch,
        labelsFirstFetch: labelsFirstFetch, listStatusFirstFetch: listStatusFirstFetch,
        afterFirstFetch: afterFirstFetch, inputFirstFetch: inputFirstFetch,
        checksSecondFetch: checksSecondFetch, labelsSecondFetch: labelsSecondFetch,
        afterSecondFetch: afterSecondFetch, afterSecondFetchSpeaker: afterSecondFetchSpeaker,
        afterCheckMomo: afterCheckMomo, afterUncheck: afterUncheck,
        inputAfterUncheck: inputAfterUncheck, optionsAfterUncheck: optionsAfterUncheck,
        statusFallback: statusFallback, checksFallback: checksFallback, labelsFallback: labelsFallback,
        statusAuth: statusAuth, authRequests: authRequests,
        statusMissing: statusMissing, afterMissing: afterMissing, inputAfterMissing: inputAfterMissing,
        checksBeforeDown: checksBeforeDown, statusDown: statusDown,
        checksAfterDown: checksAfterDown, optionsAfterDown: optionsAfterDown,
        secondCallCached: secondCall.cached, cacheRequests: cacheRequests,
        firstVoiceRequest: firstVoiceRequest,
        requestsAfterApply: requestsAfterApply,
        speechRequests: speechRequests,
        savedVoices: savedVoices, savedChoices: savedChoices,
        label: (elements.ttsTestBtn.textContent || '').trim(),
        testLabel: (elements.ttsVoiceTestBtn.textContent || '').trim(),
    };
})()`;

// 読み上げ: モック OpenAI Compatible サーバーへ実際に送り、キュー再生・停止・本文抽出を確認する
const TTS_PLAY_SCRIPT = `(async () => {
    // 再生を重ねないことを数えるため Audio を包む
    const RealAudio = window.Audio;
    let concurrent = 0, maxConcurrent = 0;
    window.Audio = function (src) {
        const a = new RealAudio(src);
        const origPlay = a.play.bind(a);
        a.play = () => {
            concurrent++;
            if (concurrent > maxConcurrent) maxConcurrent = concurrent;
            const done = () => { concurrent = Math.max(0, concurrent - 1); };
            a.addEventListener('ended', done);
            a.addEventListener('error', done);
            return origPlay();
        };
        return a;
    };

    const drain = async () => {
        let waited = 0;
        while ((ttsUtils.queue.length > 0 || ttsUtils.playing) && waited < 10000) {
            await new Promise(r => setTimeout(r, 100));
            waited += 100;
        }
        return ttsUtils.queue.length === 0 && !ttsUtils.playing;
    };
    const recorded = async () => await (await fetch('/mock-tts/requests')).json();

    state.settings.ttsEnabled = true;
    state.settings.ttsMode = 'manual';
    state.settings.ttsEndpoint = location.origin + '/mock-tts/v1';
    state.settings.ttsApiKey = 'mock-tts-key';
    state.settings.ttsModel = 'mock-tts-model';
    state.settings.ttsVoices = 'alloy, echo';
    state.settings.ttsDefaultVoice = 'alloy';
    state.settings.ttsGenericVoice = 'echo';
    state.settings.ttsSpeakers = [{ name: 'まゆみ', voice: 'echo' }, { name: 'れな', voice: 'alloy' }];
    state.settings.ttsNarrateDialogueOnly = false;
    state.settings.ttsRegexEnabled = false;
    state.settings.ttsSpeed = 1;
    ttsUtils.stopAll();

    const modelIndex = state.currentMessages.findIndex(m => m.role === 'model');
    const originalContent = state.currentMessages[modelIndex].content;

    // 1. 実際に送る内容とヘッダー
    await fetch('/mock-tts/requests', { method: 'DELETE' });
    state.currentMessages[modelIndex].content = 'まゆみ「いち」れな「に」';
    const added = ttsUtils.enqueueMessage(modelIndex);
    const drained = await drain();
    const requests = await recorded();

    // 2. 停止はキューを破棄する
    ttsUtils.stopAll();
    const queuedAgain = ttsUtils.enqueueMessage(modelIndex);
    ttsUtils.stopAll();
    const stoppedClean = ttsUtils.queue.length === 0 && ttsUtils.playing === false;

    // 3. 地の文を読まずセリフだけ読み上げる
    await fetch('/mock-tts/requests', { method: 'DELETE' });
    state.settings.ttsNarrateDialogueOnly = true;
    state.currentMessages[modelIndex].content = '夜風が吹いていた。まゆみ「いち」';
    ttsUtils.enqueueMessage(modelIndex);
    await drain();
    const dialogueOnlyRequests = await recorded();

    // 4. CORS 失敗は挿絵生成と同じように対処法を案内する
    const realAlert = uiUtils.showCustomAlert;
    const alerts = [];
    uiUtils.showCustomAlert = (m) => { alerts.push(m); return Promise.resolve(); };
    state.settings.ttsEndpoint = 'http://127.0.0.1:1/v1';   // 届かない先
    state.currentMessages[modelIndex].content = 'まゆみ「いち」';
    appLogic.speakMessage(modelIndex, false);
    await drain();
    uiUtils.showCustomAlert = realAlert;
    ttsUtils.stopAll();

    window.Audio = RealAudio;
    state.currentMessages[modelIndex].content = originalContent;
    state.settings.ttsEnabled = false;
    state.settings.ttsNarrateDialogueOnly = false;
    state.settings.ttsSpeakers = [];

    return {
        added: added, drained: drained, maxConcurrent: maxConcurrent,
        requestCount: requests.length,
        keySets: Array.from(new Set(requests.map(r => Object.keys(r.body || {}).sort().join(',')))),
        auths: Array.from(new Set(requests.map(r => r.auth))),
        models: Array.from(new Set(requests.map(r => r.body && r.body.model))),
        voices: requests.map(r => r.body && r.body.voice),
        inputs: requests.map(r => r.body && r.body.input),
        queuedAgain: queuedAgain, stoppedClean: stoppedClean,
        dialogueOnlyInputs: dialogueOnlyRequests.map(r => r.body && r.body.input),
        corsAlerts: alerts,
    };
})()`;

// 送信前編集: オンのときだけ初回生成後に編集でき、キャンセルなら送らない
const EDIT_PROMPT_SCRIPT = `(async () => {
    state.settings.illustrationEnabled = true;
    state.settings.illustrationMode = 'manual';
    state.settings.comfyBaseUrl = location.origin + '/mock-comfy';
    state.settings.comfyWorkflows = [{
        id: 'wf-edit', name: '編集確認',
        json: JSON.stringify({
            '3': { class_type: 'CLIPTextEncode', inputs: { text: '%prompt%' } },
            '9': { class_type: 'SaveImage', inputs: { images: null } },
        }),
    }];
    state.settings.comfyActiveWorkflowId = 'wf-edit';

    const runWithEdit = async (editSetting, dialogResult, editedText) => {
        state.settings.comfyEditPromptBeforeSend = editSetting;
        state.illustrationJob = null;
        state.currentMessages = [
            { role: 'user', content: 'x', timestamp: Date.now() },
            { role: 'model', content: '編集確認の応答', timestamp: Date.now() },
        ];
        const originalHandleSend = appLogic.handleSend.bind(appLogic);
        appLogic.handleSend = async () => ({ content: 'a park, 1 man 1 woman' });
        let sent = null;
        const originalSubmit = appLogic.submitWithClient.bind(appLogic);
        appLogic.submitWithClient = async (b, workflow, signal) => { sent = workflow; return originalSubmit(b, workflow, signal); };
        let dialogOpened = false;
        const originalDialog = uiUtils.showCustomDialog;
        uiUtils.showCustomDialog = async () => {
            dialogOpened = true;
            elements.illustrationPromptEditInput.value = editedText;
            return dialogResult;
        };
        await appLogic.generateIllustration(1);
        uiUtils.showCustomDialog = originalDialog;
        appLogic.handleSend = originalHandleSend;
        appLogic.submitWithClient = originalSubmit;
        const illustration = state.currentMessages[1].illustration;
        return {
            sent: sent ? sent['3'].inputs.text : null,
            dialogOpened: dialogOpened,
            status: illustration ? illustration.status : null,
        };
    };
    const editOff = await runWithEdit(false, 'ok', '使われない文章');
    const editCancel = await runWithEdit(true, 'cancel', 'キャンセルする文章');
    const editOk = await runWithEdit(true, 'ok', '編集後の送信文章');

    // 再生成は編集ダイアログを通らず、保存済み（編集済み）の文章をそのまま送る
    state.settings.comfyEditPromptBeforeSend = true;
    state.illustrationJob = null;
    const originalHandleSend2 = appLogic.handleSend.bind(appLogic);
    appLogic.handleSend = async () => { throw new Error('再生成で LLM を呼んではいけない'); };
    let sentAgain = null;
    const originalSubmit2 = appLogic.submitWithClient.bind(appLogic);
    appLogic.submitWithClient = async (b, workflow, signal) => { sentAgain = workflow; return originalSubmit2(b, workflow, signal); };
    let dialogOpenedOnRegen = false;
    const originalDialog2 = uiUtils.showCustomDialog;
    uiUtils.showCustomDialog = async () => { dialogOpenedOnRegen = true; return 'ok'; };
    await appLogic.generateIllustration(1);
    uiUtils.showCustomDialog = originalDialog2;
    appLogic.handleSend = originalHandleSend2;
    appLogic.submitWithClient = originalSubmit2;

    state.settings.comfyEditPromptBeforeSend = false;
    return {
        editOff: editOff, editCancel: editCancel, editOk: editOk,
        regenDialogOpened: dialogOpenedOnRegen,
        regenSent: sentAgain ? sentAgain['3'].inputs.text : null,
    };
})()`;

// 再生成は quiet プロンプトを作り直さず、画像は古いものを残す
const REGENERATE_SCRIPT = `(async () => {
    state.settings.illustrationEnabled = true;
    state.settings.illustrationMode = 'manual';
    state.settings.comfyBaseUrl = location.origin + '/mock-comfy';
    state.illustrationJob = null;
    state.settings.comfyWorkflows = [{
        id: 'wf-regen', name: '再生成確認',
        json: JSON.stringify({
            '3': { class_type: 'CLIPTextEncode', inputs: { text: 'masterpiece, %prompt%' } },
            '9': { class_type: 'SaveImage', inputs: { images: null } },
        }),
    }];
    state.settings.comfyActiveWorkflowId = 'wf-regen';
    state.currentMessages = [
        { role: 'user', content: 'x', timestamp: Date.now() },
        { role: 'model', content: '再生成する応答', timestamp: Date.now() },
    ];
    state.currentMessages[1].illustration = {
        status: 'done', prompt: '使い回すプロンプト', negativePrompt: 'lowres', seed: 1,
        images: [{ dataUrl: 'data:image/png;base64,AAAA', seed: 1, prompt: '使い回すプロンプト' }],
        viewIndex: 0,
    };
    uiUtils.renderChatMessages();

    let quietCalls = 0;
    const originalHandleSend = appLogic.handleSend.bind(appLogic);
    appLogic.handleSend = async () => { quietCalls++; return { content: 'should not be used' }; };
    let sentPrompt = null;
    const originalSubmit = appLogic.submitWithClient.bind(appLogic);
    appLogic.submitWithClient = async (base, workflow, signal) => {
        sentPrompt = workflow['3'] ? workflow['3'].inputs.text : null;
        return originalSubmit(base, workflow, signal);
    };
    await appLogic.generateIllustration(1);
    appLogic.handleSend = originalHandleSend;
    appLogic.submitWithClient = originalSubmit;

    const illustration = state.currentMessages[1].illustration;
    return {
        quietCalls: quietCalls,
        imageCount: illustration.images.length,
        viewIndex: illustration.viewIndex,
        keptOldImage: illustration.images[0].dataUrl,
        sentPrompt: sentPrompt,
        status: illustration.status,
        error: illustration.error || null,
        activeWorkflowName: illustrationUtils.activeWorkflow() ? illustrationUtils.activeWorkflow().name : null,
    };
})()`;

// LoRA: 使う / 使わない（ファイルあり）/ 使わない（フォルダ空）/ 使うがフォルダ空 / 同梱規定① / 同梱規定②（rgthree）
const LORA_SCRIPT = `(async () => {
    const base = location.origin + '/mock-comfy';
    const setLoras = async (files) => {
        await fetch(base + '/set-loras', { method: 'POST', body: JSON.stringify(files) });
        illustrationUtils.loraCache = null;
        comfyWorkflowUtils.loraChoices = null;
    };
    const loraWorkflow = {
        '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: '%model%' } },
        '2': { class_type: 'LoraLoader', inputs: { model: ['1', 0], clip: ['1', 1], lora_name: '%lora1%', strength_model: '%lora_str1%', strength_clip: '%lora_str1%' } },
        '3': { class_type: 'CLIPTextEncode', inputs: { clip: ['2', 1], text: '%prompt%' } },
        '4': { class_type: 'KSampler', inputs: { model: ['2', 0], positive: ['3', 0], seed: 1 } },
        '9': { class_type: 'SaveImage', inputs: { images: ['4', 0] } },
    };
    const useWorkflow = (obj) => {
        state.settings.comfyWorkflows = [{ id: 'wf-lora', name: 'LoRA 付き', json: JSON.stringify(obj) }];
        state.settings.comfyActiveWorkflowId = 'wf-lora';
    };
    const runOnce = async () => {
        state.illustrationJob = null;
        state.currentMessages = [
            { role: 'user', content: 'x', timestamp: Date.now() },
            { role: 'model', content: 'LoRA 確認の応答', timestamp: Date.now() },
        ];
        const originalHandleSend = appLogic.handleSend.bind(appLogic);
        appLogic.handleSend = async () => ({ content: 'a cat' });
        let sent = null;
        const originalSubmit = appLogic.submitWithClient.bind(appLogic);
        appLogic.submitWithClient = async (b, workflow, signal) => {
            sent = workflow;
            return originalSubmit(b, workflow, signal);
        };
        await appLogic.generateIllustration(1);
        appLogic.handleSend = originalHandleSend;
        appLogic.submitWithClient = originalSubmit;
        return sent;
    };

    // 1) 使うスロット
    await setLoras([{ name: 'animeDetail.safetensors' }, { name: 'inkSketch.safetensors' }]);
    state.settings.comfyLoras = [
        { name: 'inkSketch.safetensors', strength: 0.7 },
        { name: '', strength: 1 }, { name: '', strength: 1 }, { name: '', strength: 1 },
    ];
    useWorkflow(JSON.parse(JSON.stringify(loraWorkflow)));
    const usedPrompt = await runOnce();
    const usedNode = usedPrompt && usedPrompt['2'] ? usedPrompt['2'].inputs : null;

    // 2) 使わないスロット + ファイルあり: ノードは残り、先頭ファイルと強度0
    state.settings.comfyLoras = [{ name: '', strength: 1 }, { name: '', strength: 1 }, { name: '', strength: 1 }, { name: '', strength: 1 }];
    useWorkflow(JSON.parse(JSON.stringify(loraWorkflow)));
    const unusedPrompt = await runOnce();
    const unusedNode = unusedPrompt && unusedPrompt['2'] ? unusedPrompt['2'].inputs : null;

    // 3) 使わないスロット + フォルダ空: そのノードだけ外れて直結される
    await setLoras([]);
    useWorkflow(JSON.parse(JSON.stringify(loraWorkflow)));
    const emptyFolderPrompt = await runOnce();

    // 4) 使うスロット + フォルダ空: 送らない
    state.settings.comfyLoras = [{ name: 'animeDetail.safetensors', strength: 1 }, { name: '', strength: 1 }, { name: '', strength: 1 }, { name: '', strength: 1 }];
    useWorkflow(JSON.parse(JSON.stringify(loraWorkflow)));
    const blockedPrompt = await runOnce();
    const blockedIllustration = state.currentMessages[1].illustration;

    // 5) 同梱の規定①は Turbo LoRA が固定。loras フォルダが空でも触られず、生成できる
    await setLoras([]);
    state.settings.comfyLoras = [{ name: '', strength: 1 }, { name: '', strength: 1 }, { name: '', strength: 1 }, { name: '', strength: 1 }];
    state.settings.comfyWorkflows = buildDefaultComfyWorkflows();
    state.settings.comfyActiveWorkflowId = state.settings.comfyWorkflows[0].id;
    const defaultPrompt = await runOnce();
    const defaultLoraNode = defaultPrompt && defaultPrompt['50'] ? defaultPrompt['50'].inputs : null;

    // 6) 同梱の規定②は rgthree。選んだスロットだけ on: true になる
    await setLoras([{ name: 'one.safetensors' }, { name: 'two.safetensors' }]);
    state.settings.comfyLoras = [
        { name: 'two.safetensors', strength: 0.5 },
        { name: '', strength: 1 }, { name: '', strength: 1 }, { name: '', strength: 1 },
    ];
    state.settings.comfyActiveWorkflowId = state.settings.comfyWorkflows[1].id;
    const rgthreePrompt = await runOnce();
    const rgthreeNode = rgthreePrompt && rgthreePrompt['50'] ? rgthreePrompt['50'].inputs : null;

    // 7) 受け取れる数より大きいスロットは選ばせない（loraWorkflow は %lora1% のみ = 1スロット）
    useWorkflow(JSON.parse(JSON.stringify(loraWorkflow)));
    state.settings.comfyLoras = [{ name: '', strength: 1 }, { name: '', strength: 1 }, { name: '', strength: 1 }, { name: '', strength: 1 }];
    const oneTokenCapacity = comfyWorkflowUtils.workflowLoraCapacity(illustrationUtils.activeWorkflow());
    comfyWorkflowUtils.renderLoraRows();
    const oneTokenDisabled = Array.from(elements.comfyLoraRows.children)
        .filter(row => row.tagName === 'DIV')
        .map(row => { const select = row.querySelector('select'); return select ? select.disabled : null; });
    await comfyWorkflowUtils.setLoraSlot(1, { name: 'inkSketch.safetensors' });
    const blockedSlotName = state.settings.comfyLoras[1].name;
    await comfyWorkflowUtils.setLoraSlot(0, { name: 'inkSketch.safetensors' });
    const allowedSlotName = state.settings.comfyLoras[0].name;

    // 8) 同梱の規定①は LoRA ノードが固定名なので、4スロットとも無効になる
    state.settings.comfyWorkflows = buildDefaultComfyWorkflows();
    state.settings.comfyActiveWorkflowId = state.settings.comfyWorkflows[0].id;
    const turboCapacity = comfyWorkflowUtils.workflowLoraCapacity(illustrationUtils.activeWorkflow());
    comfyWorkflowUtils.renderLoraRows();
    const turboDisabled = Array.from(elements.comfyLoraRows.children)
        .filter(row => row.tagName === 'DIV')
        .map(row => { const select = row.querySelector('select'); return select ? select.disabled : null; });

    return {
        usedNode: usedNode,
        unusedNode: unusedNode,
        emptyFolderHasLoraNode: !!(emptyFolderPrompt && emptyFolderPrompt['2']),
        emptyFolderKSamplerModel: emptyFolderPrompt && emptyFolderPrompt['4'] ? emptyFolderPrompt['4'].inputs.model : null,
        emptyFolderClip: emptyFolderPrompt && emptyFolderPrompt['3'] ? emptyFolderPrompt['3'].inputs.clip : null,
        blockedPromptSent: blockedPrompt !== null,
        blockedError: blockedIllustration && blockedIllustration.error ? blockedIllustration.error : null,
        defaultWorkflowSent: defaultPrompt !== null,
        defaultWorkflowLoraName: defaultLoraNode ? defaultLoraNode.lora_name : null,
        defaultWorkflowLoraStrength: defaultLoraNode ? defaultLoraNode.strength_model : null,
        defaultWorkflowSampler: defaultPrompt && defaultPrompt['19'] ? defaultPrompt['19'].inputs.sampler_name : null,
        rgthreeSent: rgthreePrompt !== null,
        rgthreeChosenOn: rgthreeNode ? rgthreeNode.lora_1.on : null,
        rgthreeChosenName: rgthreeNode ? rgthreeNode.lora_1.lora : null,
        rgthreeChosenStrength: rgthreeNode ? rgthreeNode.lora_1.strength : null,
        rgthreeUnusedOn: rgthreeNode ? rgthreeNode.lora_2.on : null,
        oneTokenCapacity: oneTokenCapacity,
        oneTokenDisabled: oneTokenDisabled,
        blockedSlotName: blockedSlotName,
        allowedSlotName: allowedSlotName,
        turboCapacity: turboCapacity,
        turboDisabled: turboDisabled,
        defaultWorkflowError: (state.currentMessages[1].illustration && state.currentMessages[1].illustration.error) || null,
    };
})()`;

async function waitForDebuggerReady() {
    for (let i = 0; i < 60; i++) {
        try {
            const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
            return await res.json();
        } catch (e) {
            await new Promise(r => setTimeout(r, 250));
        }
    }
    throw new Error('Chrome のデバッガーに接続できません');
}

function connect(wsUrl) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(wsUrl);
        ws.onopen = () => resolve(ws);
        ws.onerror = () => reject(new Error('WebSocket 接続失敗'));
    });
}

async function main() {
    if (!chromePath) throw new Error('Chrome が見つかりません。CHROME_PATH を設定してください。');

    const server = createServer();
    await new Promise(resolve => server.listen(PORT, '127.0.0.1', resolve));

    // 実行ごとにプロフィール（IndexedDB も含む）を捨てて、実行間の混入を防ぐ
    const profileDir = path.join(require('os').tmpdir(), 'onasapo-e2e-profile');
    fs.rmSync(profileDir, { recursive: true, force: true });

    const chrome = spawn(chromePath, [
        '--headless=new',
        `--remote-debugging-port=${DEBUG_PORT}`,
        '--disable-gpu',
        '--no-sandbox',
        // 読み上げの再生テストはユーザー操作なしで Audio.play() を呼ぶ
        '--autoplay-policy=no-user-gesture-required',
        '--mute-audio',
        '--user-data-dir=' + path.join(require('os').tmpdir(), 'onasapo-e2e-profile'),
        'about:blank',
    ], { stdio: 'ignore' });

    let ws;
    try {
        const version = await waitForDebuggerReady();
        const targetInfo = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`)).json();
        const page = targetInfo.find(t => t.type === 'page');
        if (!page) throw new Error('ページが見つかりません');
        ws = await connect(page.webSocketDebuggerUrl);

        let id = 0;
        const pending = new Map();
        ws.onmessage = event => {
            const message = JSON.parse(event.data);
            if (message.id && pending.has(message.id)) {
                pending.get(message.id)(message);
                pending.delete(message.id);
            }
        };
        const send = (method, params) => new Promise(resolve => {
            id++;
            pending.set(id, resolve);
            ws.send(JSON.stringify({ id, method, params: params || {} }));
        });

        await send('Runtime.enable');
        await send('Page.enable');
        await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html` });
        await new Promise(r => setTimeout(r, 2500));

        const evaluate = async (expression) => {
            const response = await send('Runtime.evaluate', {
                expression: expression,
                awaitPromise: true,
                returnByValue: true,
            });
            const evaluation = response.result || {};
            if (evaluation.exceptionDetails) {
                throw new Error('ページ内で例外: ' + JSON.stringify(
                    (evaluation.exceptionDetails.exception && evaluation.exceptionDetails.exception.description)
                    || evaluation.exceptionDetails.text));
            }
            return evaluation.result && evaluation.result.value;
        };

        const pageResult = await evaluate(PAGE_SCRIPT);
        const sentForManual = lastPromptBody;
        const comfyPollsForFirst = historyPolls;

        lastPromptBody = null;
        historyPolls = 0;
        const autoResult = await evaluate(scenarioScript('auto'));
        const sentForAuto = lastPromptBody;
        const comfyPollsForAuto = historyPolls;

        lastPromptBody = null;
        historyPolls = 0;
        const manualResult = await evaluate(scenarioScript('manual'));
        const comfyPollsForManual = historyPolls;

        lastPromptBody = null;
        historyPolls = 0;
        promptPosts = 0;
        objectInfoRequests = 0;
        const failureResult = await evaluate(FAILURE_SCRIPT);
        const promptPostsAfterFailure = promptPosts;

        const choicesResult = await evaluate(CHOICES_SCRIPT);
        objectInfoRequests = 0;
        const connectionResult = await evaluate(CONNECTION_BUTTON_SCRIPT);
        const objectInfoRequestsForConnection = objectInfoRequests;
        const deepSeekUiResult = await evaluate(DEEPSEEK_UI_SCRIPT);
        const galleryResult = await evaluate(GALLERY_SCRIPT);
        const regenerateResult = await evaluate(REGENERATE_SCRIPT);
        const loraResult = await evaluate(LORA_SCRIPT);
        const footerResult = await evaluate(FOOTER_BUTTON_SCRIPT);
        const ttsUiResult = await evaluate(TTS_UI_SCRIPT);
        const ttsPlayResult = await evaluate(TTS_PLAY_SCRIPT);
        const ttsVoicesResult = await evaluate(TTS_VOICES_SCRIPT);
        const editResult = await evaluate(EDIT_PROMPT_SCRIPT);
        const streamScrollResult = await evaluate(STREAM_SCROLL_SCRIPT);

        // ページを開き直して、保存済み挿絵が履歴に表示されるか
        const savedChat = await evaluate(RELOAD_SETUP);
        await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html` });
        await new Promise(r => setTimeout(r, 2500));
        const reloadResult = await evaluate(RELOAD_VERIFY.replace('__CHAT_ID__', JSON.stringify(savedChat.chatId)));
        console.log('── ページ内の結果 ──');
        console.log(JSON.stringify(pageResult, null, 2));

        const sent = sentForManual ? JSON.parse(sentForManual) : null;
        console.log('\n── ComfyUI に届いた内容（手動生成）──');
        console.log(JSON.stringify({
            hasClientId: !!(sent && sent.client_id),
            prompt: sent && sent.prompt ? sent.prompt['3'].inputs.text : null,
            negative: sent && sent.prompt ? sent.prompt['4'].inputs.text : null,
            width: sent && sent.prompt ? sent.prompt['5'].inputs.width : null,
            height: sent && sent.prompt ? sent.prompt['5'].inputs.height : null,
            seed: sent && sent.prompt ? sent.prompt['5'].inputs.seed : null,
            steps: sent && sent.prompt ? sent.prompt['5'].inputs.steps : null,
            cfg: sent && sent.prompt ? sent.prompt['5'].inputs.cfg : null,
            model: sent && sent.prompt ? sent.prompt['2'].inputs.ckpt_name : null,
            vae: sent && sent.prompt ? sent.prompt['12'].inputs.vae_name : null,
            sampler: sent && sent.prompt ? sent.prompt['5'].inputs.sampler_name : null,
            scheduler: sent && sent.prompt ? sent.prompt['5'].inputs.scheduler : null,
            denoise: sent && sent.prompt ? sent.prompt['5'].inputs.denoise : null,
            clip_skip: sent && sent.prompt ? sent.prompt['14'].inputs.clip_skip : null,
            custom: sent && sent.prompt ? sent.prompt['15'].inputs.text : null,
        }, null, 2));

        console.log('\n── 開き直しの結果 ──');
        console.log(JSON.stringify({ savedChat, reloadResult }, null, 2));
        console.log('\n── 失敗系の結果 ──');
        console.log(JSON.stringify(failureResult, null, 2));
        console.log('promptPosts =', promptPostsAfterFailure);

        // キャッシュ名はアプリ更新のたびに上げる。数値を固定すると上げるたびにこの検査が
        // 落ちるため、本リポジトリの名前であることと v6 以降であることを見る。
        const swCacheName = String(failureResult.swVersion || '');
        const swCacheSeq = Number(swCacheName.replace(/^onasapo-chan-cache-v/, ''));

        const checks = [
            ['ページエラーが無い', pageResult.pageErrors.length === 0],
            ['quiet 生成は背景実行で、履歴を文脈にしている', pageResult.quietRequest && pageResult.quietRequest.isBackground && pageResult.quietRequest.historyLength === 2],
            ['quiet 指示はシステムプロンプトではなく発話として送る', pageResult.quietRequest && pageResult.quietRequest.systemPrompt === '' && pageResult.quietRequest.inputText === pageResult.quietTemplate],
            ['表示名がテンプレートに置換されている', pageResult.quietRequest && /詩織/.test(pageResult.quietRequest.inputText || '')],
            ['挿絵が完了状態になる', pageResult.illustrationStatus === 'done'],
            ['画像が data URL として残る', pageResult.hasDataUrl],
            ['メッセージ直下に画像が表示される', pageResult.renderedImage],
            ['history をポーリングしている', comfyPollsForFirst >= 2],
            ['保存済み挿絵が履歴から復元できる', pageResult.restoredFromDb],
            ['本編テキストはそのまま', pageResult.mainTextIntact],
            ['client_id を送っている', !!(sent && sent.client_id)],
            ['文中へ埋め込んだ prompt も差し替わる', !!sent && sent.prompt['3'].inputs.text.startsWith('masterpiece, ') && /a park at dusk/.test(sent.prompt['3'].inputs.text)],
            ['合成後の prompt が ComfyUI に届く', !!sent && /best quality/.test(sent.prompt['3'].inputs.text) && /a park at dusk/.test(sent.prompt['3'].inputs.text)],
            ['ネガティブプロンプトが届く', !!sent && sent.prompt['4'].inputs.text === 'lowres'],
            ['寸法・steps・cfg・seed が数値で届く', !!sent && sent.prompt['5'].inputs.width === 640 && sent.prompt['5'].inputs.height === 480 && typeof sent.prompt['5'].inputs.steps === 'number' && sent.prompt['5'].inputs.seed === 12345],
            // 報告された不具合: SillyTavern 系のトークンが未差し込みのまま送られていた
            ['%model% が差し替わる', !!sent && sent.prompt['2'].inputs.ckpt_name === 'illustrious_xl.safetensors'],
            ['%vae% が差し替わる', !!sent && sent.prompt['12'].inputs.vae_name === 'ae.safetensors'],
            ['%text_encoder% が差し替わる', !!sent && sent.prompt['13'].inputs.text_name1 === 'clip_l.safetensors'],
            ['%sampler% / %scheduler% が差し替わる', !!sent && sent.prompt['5'].inputs.sampler_name === 'euler_a' && sent.prompt['5'].inputs.scheduler === 'karras'],
            ['%denoise% が数値で届く', !!sent && sent.prompt['5'].inputs.denoise === 0.85],
            ['%clip_skip% は負の値で届く', !!sent && sent.prompt['14'].inputs.clip_skip === -2],
            ['カスタム プレースホルダが差し替わる', !!sent && sent.prompt['15'].inputs.text === '1girl, school uniform'],
            ['未差し込みのプレースホルダを ComfyUI に送っていない', !!sent && !/%[a-z_]+%/.test(JSON.stringify(sent.prompt))],

            ['自動: 応答完了直後に本編+quietの2回だけLLMを呼ぶ', autoResult.apiCallCount === 2],
            ['自動: quiet生成は設定されたテンプレートを使う', autoResult.quietUsedTemplate],
            ['自動: 挿絵が生成される', autoResult.illustrationStatus === 'done' && autoResult.hasImage],
            ['自動: 本編テキストはそのまま', autoResult.mainText === '本編の応答です。'],
            ['自動: ComfyUI へ届いている', !!sentForAuto && /a park at dusk/.test(JSON.parse(sentForAuto).prompt['3'].inputs.text)],
            ['手動: 応答完了後も勝手に走らない', manualResult.apiCallCount === 1 && manualResult.illustrationStatus === null && comfyPollsForManual === 0],

            ['ComfyUI 落ちても本編テキストは残る', failureResult.unreachableResult.mainText === '本編は使える'],
            ['ComfyUI 到達不可は挿絵だけ失敗し、CORS の対処を出す', failureResult.unreachableResult.status === 'error' && failureResult.unreachableResult.mentionsCors],
            ['失敗はメッセージ直下に表示される', failureResult.unreachableResult.shownInDom],
            ['UI形式ワークフローは理由付きで拒否', failureResult.badWorkflowResult.status === 'error' && failureResult.badWorkflowResult.mentionsUiFormat],
            ['連打でも ComfyUI への投入は1件', promptPostsAfterFailure === 1],
            ['連打後もジョブは解除される', failureResult.rapidTapResult.jobReleased && failureResult.rapidTapResult.status === 'done'],
            ['Service Worker が登録される', failureResult.swRegistered],
            ['Service Worker のキャッシュ版が上がっている', /^onasapo-chan-cache-v\d+$/.test(swCacheName) && swCacheSeq >= 6],
            ['不正ワークフローでは LLM を消費しない', failureResult.badWorkflowResult.spentLlmCall === false],
            ['UI形式ワークフローは ComfyUI へ送らない', failureResult.badWorkflowResult.posted === false],
            ['未知のプレースホルダは ComfyUI へ送らない', failureResult.unknownTokenResult.posted === false],
            ['未知のプレースホルダでは LLM を消費しない', failureResult.unknownTokenResult.spentLlmCall === false],
            ['未知のプレースホルダはトークン名を表示する', failureResult.unknownTokenResult.status === 'error' && failureResult.unknownTokenResult.namesToken],

            ['object_info を1回だけ取得する', objectInfoRequests >= 1],
            ['モデルの選択肢が揃う', choicesResult.refreshOk && choicesResult.models.includes('illustrious_xl.safetensors') && choicesResult.models.includes('flux_unet.safetensors')],
            ['GGUF ローダーが無い環境でも落ちない', choicesResult.ggufAbsent],
            ['VAE / テキストエンコーダ / サンプラ / スケジューラが揃う',
                choicesResult.vaes.includes('ae.safetensors')
                && choicesResult.textEncoders.includes('clip_l.safetensors')
                && choicesResult.samplers.includes('euler_a') && choicesResult.samplers.includes('dpmpp_2m_sde')
                && choicesResult.schedulers.includes('karras') && choicesResult.schedulers.includes('sgm_uniform')],
            ['モデル / VAE / エンコーダはファイル名を省略しない',
                choicesResult.modelLabelReadable === 'illustrious_xl.safetensors'
                && choicesResult.vaeLabelReadable === 'ae.safetensors'
                && choicesResult.textEncoderLabelReadable === 'clip_l.safetensors'],
            ['サーバーに無い保存値は消さない', choicesResult.staleValueKept],
            ['一覧取得で LoRA も object_info から一緒に取る', choicesResult.lorasFromObjectInfo],
            ['取得した LoRA は生成経路のキャッシュにも入り、生成時の再取得を省く', choicesResult.loraCached],
            ['LoRA 欄に取得件数が出る', choicesResult.loraStatusShown],
            ['LoRA 1〜4 のプルダウンに一覧が並ぶ', choicesResult.loraSlotHasChoices],
            ['接続確認ボタンの名称が「接続確認＆モデル一覧取得」', connectionResult.label === '接続確認＆モデル一覧取得'],
            ['接続確認ボタンで接続OKが先に出る', /^接続OK/.test(connectionResult.connection)],
            ['接続確認ボタンでモデル一覧も取得される',
                /取得OK（モデル /.test(connectionResult.objectInfo)
                && connectionResult.models.includes('illustrious_xl.safetensors')],
            ['接続確認ボタンで LoRA も同じ一覧取得で取れる',
                /LoRA 取得OK（3 件）/.test(connectionResult.lora)
                && connectionResult.loraChoices.includes('extraFromObjectInfo.safetensors')],
            ['接続確認で object_info は1回だけ取る', objectInfoRequestsForConnection === 1],
            ['DeepSeek モデル欄は model id をそのまま表示する', deepSeekUiResult.labelsMatchValues],
            ['DeepSeek の現行候補は deepseek-flash と deepseek-v4-pro', deepSeekUiResult.currentIds],
            ['DeepSeek は世代廃止と廃止済み欄を分ける', deepSeekUiResult.retiredSplit],
            ['DeepSeek のパラメータ注釈に時点の日付がある', deepSeekUiResult.datedNote],
            ['temperature は Thinking OFF でだけ効くと注釈している', deepSeekUiResult.temperatureConditional],
            ['top_p は Thinking ON でだけ効くと注釈している', deepSeekUiResult.topPConditional],
            ['penalty 系はどちらでも効果なしと注釈している', deepSeekUiResult.penaltiesIneffective],
            ['ワークフローの追加・改名・複製・削除・UI形式拒否', choicesResult.crudOk],
            ['編集画面にプレースホルダ検出が出る', choicesResult.tokenDetected],
            ['挿絵の ◀▶ で古い画像 / 新しい画像へ切れる',
                galleryResult.olderSrc !== galleryResult.newestSrc
                && galleryResult.backToNewestSrc === galleryResult.newestSrc
                && galleryResult.counterAfterPrev === '1 / 2' && galleryResult.counterAfterNext === '2 / 2'],
            ['挿絵の ◀▶ 切替でスクロール位置が飛ばない',
                galleryResult.scrollable === true && galleryResult.scrollAfterCycle === galleryResult.scrollBeforeCycle],
            ['挿絵の画像を受信した瞬間にスクロール位置が飛ばない',
                galleryResult.scrollAfterReceive === galleryResult.scrollBeforeReceive],
            ['挿絵のクリックで全画面が開く', galleryResult.lightboxOpened === true],
            ['全画面で画像をタップしても閉じない', galleryResult.staysOpenOnImageTap === true],
            ['全画面は ✕ ボタンで閉じる', galleryResult.closedByCloseButton === true],
            ['全画面は画像外のタップで閉じる', galleryResult.closedByOutsideTap === true],
            ['この画像を削除は 1 枚だけ消し、専用の確認文を出す',
                // スクロール確認で 3 枚目に増やしているので、1 枚削除後は 2 枚
                galleryResult.confirmTexts[0] === 'この画像を本当に削除しますか？' 
                && galleryResult.imagesAfterOneDelete === 2],
            ['すべて削除は別の確認文で全枚消す',
                galleryResult.confirmTexts[1] === 'この応答に対して生成された画像を全て削除しますか？'
                && galleryResult.illustrationAfterAllDelete === null],
            ['画像プロンプトにコピーボタンがある', galleryResult.copyButtonExists === true],
            ['画像プロンプトは展開中に編集でき、保存される', galleryResult.editedSaved === true],
            ['書き出し名はワークフロー名 + 日付 + 時刻', /^my flow_v1-\d{8}-\d{6}\.json$/.test(galleryResult.exportName)],

            ['挿絵ボタンは挿絵生成オフで隠れる', footerResult.hiddenWhenDisabled === true],
            ['挿絵の自動/手動ボタンは「絵:自動」「絵:手動」で文字がはみ出さない',
                footerResult.autoLabel === '絵:自動' && footerResult.manualLabel === '絵:手動' && footerResult.noOverflow === true],
            ['挿絵の自動は赤地に白文字', footerResult.autoClasses === true && footerResult.autoColors === true],
            ['挿絵の手動はグレー地に白文字', footerResult.manualClasses === true && footerResult.manualColors === true],
            ['読み上げのメガホンボタンは入力欄付近にあり、アイコンは SVG',
                footerResult.megaphoneIcon === true && footerResult.megaphoneHidden === true],
            ['読み上げオフでメガホンボタンが隠れ、オンで出る',
                footerResult.megaphoneHidden === true && footerResult.ttsVisibleWhenEnabled === true],
            ['読み上げの自動は赤地に白のメガホン',
                footerResult.ttsAutoClasses === true && footerResult.ttsAutoColors === true],
            ['読み上げの手動はグレー地に白のメガホン',
                footerResult.ttsManualClasses === true && footerResult.ttsManualColors === true],

            ['ストリーミング表示に追従してスクロールしない',
                streamScrollResult.scrollable === true && streamScrollResult.during === streamScrollResult.before],
            ['応答の受信完了でもスクロール位置を維持する',
                streamScrollResult.afterFinalize === streamScrollResult.before],
            ['読み上げの設定欄がある', ttsUiResult.groupExists === true && ttsUiResult.missingIds.length === 0],
            ['話者割当は登場人物 1〜5 の 5 行', ttsUiResult.speakerRows === 5],
            ['ボイス一覧はカンマ区切りから作る',
                JSON.stringify(ttsUiResult.voiceOptions) === JSON.stringify(['', 'alloy', 'echo', 'nova'])],
            ['話者割当の保存値が選択に残る', ttsUiResult.speakerVoiceValue === 'echo'],
            ['応答ごとにメガホンボタンが付く', ttsUiResult.megaphoneForModel === true],

            ['読み上げ: audio/speech へ実際に送る', ttsPlayResult.requestCount === 2 && ttsPlayResult.drained === true],
            ['読み上げ: body は model / voice / input のみ',
                JSON.stringify(ttsPlayResult.keySets) === JSON.stringify(['input,model,voice'])],
            ['読み上げ: model 名を送る', ttsPlayResult.models[0] === 'mock-tts-model'],
            ['読み上げ: APIキーを Bearer で送る', ttsPlayResult.auths[0] === 'Bearer mock-tts-key'],
            ['読み上げ: 話者ごとにボイスを切り替える',
                JSON.stringify(ttsPlayResult.voices) === JSON.stringify(['echo', 'alloy'])],
            ['読み上げ: セリフだけを送る',
                JSON.stringify(ttsPlayResult.inputs) === JSON.stringify(['いち', 'に'])],
            ['読み上げ: 再生は重ねずキューで順に鳴らす', ttsPlayResult.maxConcurrent === 1],
            ['読み上げ: 停止はキューを破棄する',
                ttsPlayResult.queuedAgain === 2 && ttsPlayResult.stoppedClean === true],
            ['読み上げ: 地の文を読まないをオンにすると地の文は送らない',
                JSON.stringify(ttsPlayResult.dialogueOnlyInputs) === JSON.stringify(['いち'])],
            ['読み上げ: CORS 失敗は挿絵生成と同じように対処法を案内する',
                ttsPlayResult.corsAlerts.length === 1
                && /CORS/.test(ttsPlayResult.corsAlerts[0])
                && /TTS サーバーに届きませんでした/.test(ttsPlayResult.corsAlerts[0])],

            ['TTS 接続確認ボタンの名称が「接続確認＆ボイス一覧取得」',
                ttsVoicesResult.label === '接続確認＆ボイス一覧取得'],
            ['TTS テスト再生ボタンの名称が「テスト再生」',
                ttsVoicesResult.testLabel === 'テスト再生'],
            ['参照ボイス: 未取得時は一覧が空で、手入力を案内する',
                ttsVoicesResult.beforeFetch.length === 1 && /一覧は未取得/.test(ttsVoicesResult.emptyListText)],
            ['参照ボイス: 一覧取得でサーバーの全 voice がチェックボックスに並ぶ',
                JSON.stringify(ttsVoicesResult.checksFirstFetch) === JSON.stringify(['momo', 'rima'])],
            // no_ref 専用（Voice Design 用）は話者選択へ流入させない
            ['参照ボイス: no_ref 専用は既定で有効にしない',
                ttsVoicesResult.labelsFirstFetch.some(l => /none（no_ref）/.test(l))],
            ['参照ボイス: 一覧に種別ラベルを添える',
                ttsVoicesResult.labelsFirstFetch.some(l => /momo（音声）/.test(l))
                && ttsVoicesResult.labelsFirstFetch.some(l => /rima（latent）/.test(l))],
            // 話者選択の候補は「有効」にした voice だけ（no_ref は既定で有効にしないので出ない）
            ['参照ボイス: 有効にした voice が話者選択の候補になる',
                JSON.stringify(ttsVoicesResult.afterFirstFetch) === JSON.stringify(['', 'momo', 'rima'])],
            ['参照ボイス: 取得した選択は末尾カンマ付きで ttsVoices へ入る',
                ttsVoicesResult.inputFirstFetch === 'momo, rima,'],
            ['参照ボイス: 一覧の件数と種別内訳を出す',
                /取得 3 件（音声 1 \/ latent 1 \/ SI 0 \/ no_ref 1 \/ 種別不明 0）/.test(ttsVoicesResult.listStatusFirstFetch)],
            ['参照ボイス: 既存の選択は再取得でも ON のまま、カタログの新規は OFF',
                JSON.stringify(ttsVoicesResult.checksSecondFetch) === JSON.stringify(['alloy', 'echo'])],
            ['参照ボイス: 一覧に無い保存値はラベルを付けて残る',
                ttsVoicesResult.labelsSecondFetch.some(l => /alloy（一覧に無い保存値）/.test(l))],
            ['参照ボイス: 一覧に無い保存値も話者選択と話者割当の候補に残る',
                JSON.stringify(ttsVoicesResult.afterSecondFetch) === JSON.stringify(['', 'alloy', 'echo'])
                && JSON.stringify(ttsVoicesResult.afterSecondFetchSpeaker) === JSON.stringify(['', 'alloy', 'echo'])],
            ['参照ボイス: チェックの変更が ttsVoices と入力欄の両方へ同期する',
                ttsVoicesResult.afterCheckMomo === 'momo, alloy, echo,'
                && ttsVoicesResult.afterUncheck === 'alloy, echo,'],
            ['参照ボイス: チェックを外すと話者選択の候補からも消える',
                !ttsVoicesResult.optionsAfterUncheck.includes('momo')
                && ttsVoicesResult.inputAfterUncheck === 'alloy, echo,'],
            ['参照ボイス: /audio/voices 非対応でも /voices へフォールバックする',
                ttsVoicesResult.labelsFallback.some(l => /af_heart（種別不明）/.test(l))
                && JSON.stringify(ttsVoicesResult.checksFallback) === JSON.stringify(['alloy', 'echo'])],
            ['参照ボイス: APIキーを求められたら全候補を回さない',
                /APIキー/.test(ttsVoicesResult.statusAuth) && ttsVoicesResult.authRequests.length === 1],
            ['参照ボイス: 一覧取得の GET に Content-Type を付けない',
                !ttsVoicesResult.firstVoiceRequest.contentType],
            ['参照ボイス: APIキーが空なら Authorization も送らない',
                !ttsVoicesResult.firstVoiceRequest.auth],
            // 選択中の alloy は一覧から消えても「一覧に無い保存値」で残り続ける（既存仕様）
            ['参照ボイス: 一覧非対応でも接続OKとし、詳細欄の入力は話者選択へ反映される',
                /非対応/.test(ttsVoicesResult.statusMissing)
                && JSON.stringify(ttsVoicesResult.afterMissing) === JSON.stringify(['', 'nope1', 'nope2', 'alloy'])
                && ttsVoicesResult.inputAfterMissing === 'nope1, nope2,'],
            ['参照ボイス: 疎通の失敗ではチェック一覧も話者選択も変えない',
                JSON.stringify(ttsVoicesResult.checksAfterDown) === JSON.stringify(ttsVoicesResult.checksBeforeDown)
                && ttsVoicesResult.optionsAfterDown.includes('nope1')],
            ['参照ボイス: 到達しない先ではエラー表示を残す',
                /TTS サーバーに届きませんでした/.test(ttsVoicesResult.statusDown)],
            ['参照ボイス: 5 分以内の再取得はキャッシュを使い、ボタンは取り直す',
                ttsVoicesResult.secondCallCached === true && ttsVoicesResult.cacheRequests.length === 1],
            ['参照ボイス: 設定の再描画で一覧を再取得しない',
                ttsVoicesResult.requestsAfterApply === ttsVoicesResult.cacheRequests.length],
            ['テスト再生: チェック済み最初のボイスで audio/speech へ送る',
                ttsVoicesResult.speechRequests.length === 1
                && ttsVoicesResult.speechRequests[0].body.voice === 'rima'
                && ttsVoicesResult.speechRequests[0].body.model === 'mock-tts-model'],
            ['参照ボイス: 保存時に末尾カンマを付ける',
                ttsVoicesResult.savedVoices === 'alloy, echo,'],
            ['参照ボイス: 末尾カンマで空の選択肢は増えない',
                JSON.stringify(ttsVoicesResult.savedChoices) === JSON.stringify(['alloy', 'echo'])],

            ['送信前編集オフなら編集ダイアログを開かない',
                editResult.editOff.dialogOpened === false && !/使われない文章/.test(editResult.editOff.sent || '')],
            ['送信前編集でキャンセルすると ComfyUI へ送らない',
                editResult.editCancel.dialogOpened === true && editResult.editCancel.sent === null],
            ['送信前編集の文章を ComfyUI へ送る', /編集後の送信文章/.test(editResult.editOk.sent || '')],
            ['再生成は編集ダイアログを通らず保存済みの文章を送る',
                editResult.regenDialogOpened === false && /編集後の送信文章/.test(editResult.regenSent || '')],

            ['再生成は quiet プロンプトを作り直さない', regenerateResult.quietCalls === 0],
            ['再生成は古い画像を残して 1 枚足す',
                regenerateResult.imageCount === 2 && regenerateResult.keptOldImage === 'data:image/png;base64,AAAA'
                && regenerateResult.viewIndex === 1],
            ['再生成は保存済みプロンプトをそのまま送る', /使い回すプロンプト/.test(regenerateResult.sentPrompt || '')],

            ['LoRA を使うスロットは選んだファイルと強度で送る',
                !!loraResult.usedNode
                && loraResult.usedNode.lora_name === 'inkSketch.safetensors'
                && loraResult.usedNode.strength_model === 0.7 && loraResult.usedNode.strength_clip === 0.7],
            ['使わない LoRA は先頭の実在ファイルと強度 0 で送る',
                !!loraResult.unusedNode
                && loraResult.unusedNode.lora_name === 'animeDetail.safetensors'
                && loraResult.unusedNode.strength_model === 0 && loraResult.unusedNode.strength_clip === 0],
            ['loras フォルダが空ならその LoRA ノードだけ外れて直結する',
                !loraResult.emptyFolderHasLoraNode
                && JSON.stringify(loraResult.emptyFolderKSamplerModel) === JSON.stringify(['1', 0])
                && JSON.stringify(loraResult.emptyFolderClip) === JSON.stringify(['1', 1])],
            ['LoRA を使う設定でフォルダが空なら送らない',
                loraResult.blockedPromptSent === false && /loras フォルダ/.test(loraResult.blockedError || '')],
            ['同梱の規定①は固定の Turbo LoRA を触らず生成できる',
                loraResult.defaultWorkflowSent === true
                && loraResult.defaultWorkflowLoraName === 'anima-turbo-lora-v0.2.safetensors'
                && loraResult.defaultWorkflowLoraStrength === 1],
            ['同梱の規定①はサンプラが解決している', loraResult.defaultWorkflowSampler === 'euler_a'],
            ['同梱の規定②は選んだスロットだけ on: true',
                loraResult.rgthreeSent === true
                && loraResult.rgthreeChosenOn === true
                && loraResult.rgthreeChosenName === 'two.safetensors'
                && loraResult.rgthreeChosenStrength === 0.5
                && loraResult.rgthreeUnusedOn === false],
            ['%lora1% だけのワークフローは受け取れる LoRA が1個', loraResult.oneTokenCapacity === 1],
            ['%lora1% だけのワークフローでは LoRA2〜4 の選択欄が無効',
                JSON.stringify(loraResult.oneTokenDisabled) === JSON.stringify([false, true, true, true])],
            ['無効なスロットは setLoraSlot でも選ばれない', loraResult.blockedSlotName === ''],
            ['有効なスロットはそのまま選べる', loraResult.allowedSlotName === 'inkSketch.safetensors'],
            ['同梱の規定①は LoRA スロット0個で4つとも無効',
                loraResult.turboCapacity === 0
                && JSON.stringify(loraResult.turboDisabled) === JSON.stringify([true, true, true, true])],

            ['開き直後に設定が復元される', reloadResult.settingsRestored && reloadResult.templateRestored],
            ['開き直後に保存済み挿絵が履歴へ表示される',
                savedChat.status === 'done' && reloadResult.illustrationStatus === 'done'
                && reloadResult.imageRendered && reloadResult.imageSrcIsDataUrl],
        ];
        console.log('\n── 複数枚・再生成・LoRA の内訳 ──');
        console.log(JSON.stringify({
            gallery: galleryResult, regenerate: regenerateResult, lora: {
                usedNode: loraResult.usedNode,
                unusedNode: loraResult.unusedNode,
                emptyFolderHasLoraNode: loraResult.emptyFolderHasLoraNode,
                emptyFolderKSamplerModel: loraResult.emptyFolderKSamplerModel,
                emptyFolderClip: loraResult.emptyFolderClip,
                blockedPromptSent: loraResult.blockedPromptSent,
                blockedError: loraResult.blockedError,
                defaultWorkflowSent: loraResult.defaultWorkflowSent,
                defaultWorkflowLoraName: loraResult.defaultWorkflowLoraName,
                defaultWorkflowLoraStrength: loraResult.defaultWorkflowLoraStrength,
                defaultWorkflowSampler: loraResult.defaultWorkflowSampler,
                rgthreeSent: loraResult.rgthreeSent,
                rgthreeChosenOn: loraResult.rgthreeChosenOn,
                rgthreeChosenName: loraResult.rgthreeChosenName,
                rgthreeUnusedOn: loraResult.rgthreeUnusedOn,
                oneTokenCapacity: loraResult.oneTokenCapacity,
                oneTokenDisabled: loraResult.oneTokenDisabled,
                blockedSlotName: loraResult.blockedSlotName,
                allowedSlotName: loraResult.allowedSlotName,
                turboCapacity: loraResult.turboCapacity,
                turboDisabled: loraResult.turboDisabled,
                defaultWorkflowError: loraResult.defaultWorkflowError,
            },
            regenerateError: regenerateResult.error,
            regenerateWorkflow: regenerateResult.activeWorkflowName,
            footer: footerResult,
            edit: editResult,
        }, null, 2));
        console.log('\n── 確認 ──');
        let failed = 0;
        for (const [name, ok] of checks) {
            console.log((ok ? 'OK   ' : 'NG   ') + name);
            if (!ok) failed++;
        }
        console.log('\n' + (checks.length - failed) + '/' + checks.length + ' 確認');
        if (failed) process.exitCode = 1;
    } finally {
        if (ws) ws.close();
        chrome.kill();
        server.close();
    }
}

main().catch(error => {
    console.error('実行エラー:', error.message);
    process.exitCode = 1;
});
