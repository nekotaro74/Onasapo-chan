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

let lastPromptBody = null;
let historyPolls = 0;

function createServer() {
    return http.createServer((req, res) => {
        const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

        if (url.pathname.startsWith('/mock-comfy/')) {
            const endpoint = url.pathname.replace('/mock-comfy/', '');
            res.setHeader('Content-Type', 'application/json');
            if (endpoint === 'system_stats') {
                res.end(JSON.stringify({ system: { comfy_version: 'mock' } }));
                return;
            }
            if (endpoint === 'prompt' && req.method === 'POST') {
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
    state.settings.comfyWorkflow = JSON.stringify({
        '3': { class_type: 'CLIPTextEncode', inputs: { text: '%prompt%' } },
        '4': { class_type: 'CLIPTextEncode', inputs: { text: '%negative_prompt%' } },
        '5': { class_type: 'KSampler', inputs: { seed: '%seed%', width: '%width%', height: '%height%', steps: '%steps%', cfg: '%cfg%' } },
        '9': { class_type: 'SaveImage', inputs: { images: null } },
    });
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
            && raw.messages[1].illustration.imageDataUrl);
    }

    return {
        pageErrors: pageErrors,
        quietRequest: quietRequest,
        illustrationStatus: target.illustration ? target.illustration.status : null,
        illustrationError: target.illustration ? (target.illustration.error || null) : null,
        hasDataUrl: !!(target.illustration && typeof target.illustration.imageDataUrl === 'string' && target.illustration.imageDataUrl.startsWith('data:image/')),
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
        quietUsedTemplate: apiCalls.length > 1 && /comma-delimited/.test(apiCalls[1].content),
        mainText: modelMessage ? modelMessage.content : null,
        illustrationStatus: modelMessage && modelMessage.illustration ? modelMessage.illustration.status : null,
        hasImage: !!(modelMessage && modelMessage.illustration && modelMessage.illustration.imageDataUrl),
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

    const chrome = spawn(chromePath, [
        '--headless=new',
        `--remote-debugging-port=${DEBUG_PORT}`,
        '--disable-gpu',
        '--no-sandbox',
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
        }, null, 2));

        const checks = [
            ['ページエラーが無い', pageResult.pageErrors.length === 0],
            ['quiet 生成は背景実行で、履歴を文脈にしている', pageResult.quietRequest && pageResult.quietRequest.isBackground && pageResult.quietRequest.historyLength === 2],
            ['quiet 指示はシステムプロンプトではなく発話として送る', pageResult.quietRequest && pageResult.quietRequest.systemPrompt === '' && /comma-delimited/.test(pageResult.quietRequest.inputText || '')],
            ['表示名がテンプレートに置換されている', pageResult.quietRequest && /詩織/.test(pageResult.quietRequest.inputText || '')],
            ['挿絵が完了状態になる', pageResult.illustrationStatus === 'done'],
            ['画像が data URL として残る', pageResult.hasDataUrl],
            ['メッセージ直下に画像が表示される', pageResult.renderedImage],
            ['history をポーリングしている', comfyPollsForFirst >= 2],
            ['保存済み挿絵が履歴から復元できる', pageResult.restoredFromDb],
            ['本編テキストはそのまま', pageResult.mainTextIntact],
            ['client_id を送っている', !!(sent && sent.client_id)],
            ['合成後の prompt が ComfyUI に届く', !!sent && /best quality/.test(sent.prompt['3'].inputs.text) && /a park at dusk/.test(sent.prompt['3'].inputs.text)],
            ['ネガティブプロンプトが届く', !!sent && sent.prompt['4'].inputs.text === 'lowres'],
            ['寸法・steps・cfg・seed が数値で届く', !!sent && sent.prompt['5'].inputs.width === 640 && sent.prompt['5'].inputs.height === 480 && typeof sent.prompt['5'].inputs.steps === 'number' && sent.prompt['5'].inputs.seed === 12345],

            ['自動: 応答完了直後に本編+quietの2回だけLLMを呼ぶ', autoResult.apiCallCount === 2],
            ['自動: quiet生成はテンプレートを発話として送る', autoResult.quietUsedTemplate],
            ['自動: 挿絵が生成される', autoResult.illustrationStatus === 'done' && autoResult.hasImage],
            ['自動: 本編テキストはそのまま', autoResult.mainText === '本編の応答です。'],
            ['自動: ComfyUI へ届いている', !!sentForAuto && /a park at dusk/.test(JSON.parse(sentForAuto).prompt['3'].inputs.text)],
            ['手動: 応答完了後も勝手に走らない', manualResult.apiCallCount === 1 && manualResult.illustrationStatus === null && comfyPollsForManual === 0],
        ];
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
