// 挿絵生成のコアロジックをブラウザなしで検証する実験用スクリプト。
// index.html から illustrationUtils を抜き出して実行するだけで、アプリ本体は読み込まない。
// 実行: node tools/selftest.js
'use strict';

const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function extractObject(source, marker) {
    const start = source.indexOf(marker);
    if (start === -1) throw new Error('見つかりません: ' + marker);
    const open = source.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < source.length; i++) {
        if (source[i] === '{') depth++;
        else if (source[i] === '}') {
            depth--;
            if (depth === 0) return source.slice(start, i + 1);
        }
    }
    throw new Error('閉じ括弧が見つかりません');
}

// 最小限のスタブ
const state = { settings: {} };
const elements = {};

const utilsSource = extractObject(html, 'const illustrationUtils = {');
// eslint-disable-next-line no-eval
const illustrationUtils = eval(utilsSource + '; illustrationUtils');

const tplMarker = 'const DEFAULT_ILLUSTRATION_PROMPT_TEMPLATE = ';
const tplStart = html.indexOf(tplMarker);
const tplEnd = html.indexOf('`;', tplStart);
const DEFAULT_ILLUSTRATION_PROMPT_TEMPLATE = eval(
    html.slice(tplStart + tplMarker.length, tplEnd + 1)
);

let passed = 0;
const failures = [];
function check(name, actual, expected) {
    if (JSON.stringify(actual) === JSON.stringify(expected)) passed++;
    else failures.push(name + '\n  期待: ' + JSON.stringify(expected) + '\n  実際: ' + JSON.stringify(actual));
}
function checkTrue(name, condition, detail) {
    if (condition) passed++;
    else failures.push(name + (detail ? '\n  ' + detail : ''));
}

// ── base URL 正規化 ──────────────────────────────────────────
check('末尾スラッシュ除去', illustrationUtils.normalizeBaseUrl('http://127.0.0.1:8188/'), 'http://127.0.0.1:8188');
check('末尾スラッシュ複数除去', illustrationUtils.normalizeBaseUrl(' http://100.1.2.3:8188// '), 'http://100.1.2.3:8188');
check('空', illustrationUtils.normalizeBaseUrl(''), '');

// ── ワークフロー検証 ─────────────────────────────────────────
const apiWorkflow = JSON.stringify({
    '3': { class_type: 'CLIPTextEncode', inputs: { text: '%prompt%' }, _meta: {} },
    '4': { class_type: 'CLIPTextEncode', inputs: { text: '%negative_prompt%' }, _meta: {} },
    '5': { class_type: 'KSampler', inputs: { seed: '%seed%', width: '%width%', height: '%height%', steps: '%steps%', cfg: '%cfg%' }, _meta: {} },
    '9': { class_type: 'SaveImage', inputs: { images: null }, _meta: {} },
});
const uiWorkflow = JSON.stringify({ nodes: [{ id: 1 }], links: [], groups: [] });

checkTrue('API形式は通る', illustrationUtils.parseWorkflow(apiWorkflow).ok);
const uiResult = illustrationUtils.parseWorkflow(uiWorkflow);
checkTrue('UI形式は拒否', !uiResult.ok && /UI形式/.test(uiResult.error), uiResult.error);
checkTrue('空は拒否', !illustrationUtils.parseWorkflow('').ok);
checkTrue('不正JSONは拒否', !illustrationUtils.parseWorkflow('{not json').ok);
checkTrue('配列は拒否', !illustrationUtils.parseWorkflow('[]').ok);
checkTrue('SaveImage無しは拒否', !illustrationUtils.parseWorkflow(JSON.stringify({ '1': { class_type: 'KSampler', inputs: {} } })).ok);

// ── トークン検出 ─────────────────────────────────────────────
check('トークン検出', illustrationUtils.findPlaceholders(apiWorkflow).sort(),
    ['cfg', 'height', 'negative_prompt', 'prompt', 'seed', 'steps', 'width']);
check('文中へ埋め込まれたトークンも検出',
    illustrationUtils.findPlaceholders(JSON.stringify({ a: { inputs: { text: 'x %prompt% y %foo%' } } })).sort(),
    ['foo', 'prompt']);

// ── プレースホルダ差し込み（JSON 解析方式）───────────────────
state.settings = {
    comfyNegativePrompt: 'bad anatomy', comfyWidth: 512, comfyHeight: 768,
    comfySteps: 20, comfyCfg: 7, comfySeed: 42, comfyClipSkip: 2, comfyDenoise: 0.85,
    comfyModel: 'illust.safetensors', comfyVae: 'ae.safetensors',
    comfySampler: 'euler_a', comfyScheduler: 'karras', comfyTextEncoder: 'clip.safetensors',
};
const built = illustrationUtils.buildTokenValues();
check('寸法・steps・cfg が渡る', [built.values.width, built.values.height, built.values.steps, built.values.cfg], [512, 768, 20, 7]);
check('seed 固定', built.values.seed, 42);
check('CLIP Skip は負の値で差し込む', built.values.clip_skip, -2);
check('Denoise が渡る', built.values.denoise, 0.85);
check('モデル・VAE・サンプラ・スケジューラ・エンコーダが渡る',
    [built.values.model, built.values.vae, built.values.sampler, built.values.scheduler, built.values.text_encoder],
    ['illust.safetensors', 'ae.safetensors', 'euler_a', 'karras', 'clip.safetensors']);

const tricky = '1girl, "quoted", a, b';
const substituted = illustrationUtils.substituteTokens(
    JSON.parse(apiWorkflow), Object.assign({}, built.values, { prompt: tricky, negative_prompt: 'bad anatomy' }));
checkTrue('差し込み後も JSON が壊れない', substituted.object !== null && substituted.unresolved.length === 0,
    JSON.stringify(substituted.unresolved));
check('引用符を含む本文がそのまま残る', substituted.object['3'].inputs.text, tricky);
check('数値は quotes なしで入る', substituted.object['5'].inputs.width, 512);

// 文中へ埋め込まれたトークンも置換される（旧実装は未置換で残していた）
const partial = { '1': { class_type: 'X', inputs: { note: 'prefix %prompt% suffix' } } };
const partialResult = illustrationUtils.substituteTokens(partial, { prompt: 'NOPE' });
check('文字列内の部分一致も置換する', partialResult.object['1'].inputs.note, 'prefix NOPE suffix');
check('部分一致で unresolved は空', partialResult.unresolved, []);
check('文中の seed は文字列として補間される',
    illustrationUtils.substituteTokens({ '1': { inputs: { note: 'seed-%seed%' } } }, built.values).object['1'].inputs.note,
    'seed-42');

// %scale% 互換
state.settings.comfyCfg = 9;
const scaleWf = { '1': { class_type: 'X', inputs: { scale: '%scale%' } } };
check('%scale% には cfg の値が入る',
    illustrationUtils.substituteTokens(scaleWf, illustrationUtils.buildTokenValues().values).object['1'].inputs.scale, 9);

// 未対応トークンは unresolved に集まる
const unknown = illustrationUtils.substituteTokens({ '1': { inputs: { x: '%foo%' } } }, illustrationUtils.buildTokenValues().values);
check('未知のトークンは unresolved', unknown.unresolved, ['foo']);
check('未差し込みの値は原文のまま残る', unknown.object['1'].inputs.x, '%foo%');

// prepareWorkflow は prompt / negative_prompt 以外を先に差し込み、未対応を名指しで止める
const stStyle = {
    '7': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: '%model%' } },
    '8': { class_type: 'VAELoader', inputs: { vae_name: '%vae%' } },
    '5': { class_type: 'KSampler', inputs: { sampler_name: '%sampler%', scheduler: '%scheduler%', denoise: '%denoise%' } },
    '6': { class_type: 'CLIPSetLastLayer', inputs: { clip_skip: '%clip_skip%' } },
    '3': { class_type: 'CLIPTextEncode', inputs: { text: 'masterpiece, %prompt%' } },
};
const prepared = illustrationUtils.prepareWorkflow(stStyle);
checkTrue('SillyTavern 形式のトークンは全て解決', prepared.ok, prepared.error);
check('CLIPSetLastLayer へ負の CLIP Skip が入る', prepared.object && prepared.object['6'].inputs.clip_skip, -2);
check('文中の %prompt% は後段に残る', prepared.unresolved, ['prompt']);
const preparedPrompt = illustrationUtils.applyPromptTokens(prepared.object, { prompt: 'a park' });
check('本文が文中差し込みされる', preparedPrompt.object['3'].inputs.text, 'masterpiece, a park');
check('文中差し込みで unresolved は空', preparedPrompt.unresolved, []);

state.settings.comfyModel = '';
const blocked = illustrationUtils.prepareWorkflow(stStyle);
checkTrue('未設定の列挙値は生成を止める', !blocked.ok, 'ok が true のまま');
checkTrue('止めた理由にトークン名が出る', /%model%/.test(blocked.error || ''), blocked.error);
state.settings.comfyModel = 'illust.safetensors';

// 空の negative_prompt は正当なので差し込む
check('空の negative_prompt は空文字で差し込む',
    illustrationUtils.applyPromptTokens({ '1': { inputs: { t: '%negative_prompt%' } } }, { negative_prompt: '' }).object['1'].inputs.t,
    '');

// POST 直前の最終関門
check('findUnresolvedTokens は未差し込みだけ拾う',
    illustrationUtils.findUnresolvedTokens({ '1': { inputs: { a: '%model%', b: 'masterpiece, a park' } } }), ['model']);

// カスタム プレースホルダ
state.settings.comfyCustomPlaceholders = [{ find: 'outfit', replace: '1girl, {{char}} in uniform' }];
state.settings.aiName = '詩織';
state.settings.userName = 'あなた';
const customValues = illustrationUtils.buildTokenValues().values;
check('カスタム プレースホルダが展開される', customValues.outfit, '1girl, 詩織 in uniform');
check('カスタム名は % を除いて正規化する', illustrationUtils.normalizeCustomToken('%outfit%'), 'outfit');
check('組み込みトークン名はカスタムに使えない', illustrationUtils.normalizeCustomToken('seed'), '');
check('不正なカスタム名は空文字', illustrationUtils.normalizeCustomToken('bad name!'), '');
state.settings.comfyCustomPlaceholders = [];

// seed = -1 で毎回ランダム
state.settings.comfySeed = -1;
const randomSeed = illustrationUtils.buildTokenValues().seed;
checkTrue('seed=-1 でランダム', typeof randomSeed === 'number' && randomSeed >= 0, String(randomSeed));

// ── ワークフロー一覧 ─────────────────────────────────────────
const normalized = illustrationUtils.normalizeWorkflowList([
    { id: 'a', name: 'A', json: '{}' },
    { id: 'a', name: 'A', json: '{}' },
    { id: '', name: '', json: '{}' },
    { id: 'x', name: 'Y' },
], 'missing-id');
check('一覧の自己修復（重複 id・空 id・json 無し）', normalized.list.map(w => [w.id, w.name]),
    [['a', 'A'], ['a-2', 'A (2)'], ['wf-3', 'ワークフロー 3']]);
check('存在しない activeId は先頭へ', normalized.activeId, 'a');
state.settings.comfyWorkflows = [{ id: 'a', name: 'A', json: '{"1":{"class_type":"SaveImage","inputs":{}}}' }];
state.settings.comfyActiveWorkflowId = 'a';
check('activeWorkflow が 1 件返す', illustrationUtils.activeWorkflow().name, 'A');
state.settings.comfyActiveWorkflowId = 'nope';
check('active が無ければ null', illustrationUtils.activeWorkflow(), null);

// ── プレフィックス合成 ───────────────────────────────────────
check('共通→キャラ→本文の連結',
    illustrationUtils.combinePrefixes(
        illustrationUtils.combinePrefixes('best quality, absurdres', '1girl, silver hair'),
        'a park, 2 people'),
    'best quality, absurdres, 1girl, silver hair, a park, 2 people');
check('空プレフィックスは無視', illustrationUtils.combinePrefixes('', 'a cat'), 'a cat');
check('前後カンマは除去', illustrationUtils.combinePrefixes('a,', ',b,'), 'a, b');

// ── 返文の整形 ───────────────────────────────────────────────
check('引用符除去・改行→カンマ・カンマ正規化',
    illustrationUtils.processReply('"a cat"\nsitting\n\non a bench"'), 'a cat, sitting, on a bench');
check('reasoning を落とす', illustrationUtils.processReply('xx</think>\na cat'), 'a cat');
check('日本語は厳格整形では消える', illustrationUtils.processReply('公園, 少女'), '');
state.settings.comfyMinimalPromptProcessing = false;
check('厳格整形で空なら自動で緩い整形へ', illustrationUtils.processReplyAuto('公園, 少女'), { text: '公園, 少女', fellBack: true });
state.settings.comfyMinimalPromptProcessing = true;
check('最小限整形を明示できる', illustrationUtils.processReplyAuto('公園, 少女'), { text: '公園, 少女', fellBack: false });
state.settings.comfyMinimalPromptProcessing = false;

// ── {{char}} / {{user}} 置換 ─────────────────────────────────
state.settings.aiName = '詩織';
state.settings.userName = 'あなた';
const substitutedTemplate = illustrationUtils.substituteSessionNames(DEFAULT_ILLUSTRATION_PROMPT_TEMPLATE);
checkTrue('テンプレートのマクロが置換される', !/\{\{(char|user)\}\}/.test(substitutedTemplate));
checkTrue('表示名が挿入される', substitutedTemplate.includes('詩織') && substitutedTemplate.includes('あなた'));
state.settings.aiName = '';
state.settings.userName = '';
const fallbackNames = illustrationUtils.substituteSessionNames(DEFAULT_ILLUSTRATION_PROMPT_TEMPLATE);
checkTrue('未設定なら assistant / user', /assistant/.test(fallbackNames) && /\buser\b/.test(fallbackNames));

// ── ComfyUI プロトコル（fetch をスタブに差し替えて検証）────
async function expectThrow(name, fn, pattern) {
    try {
        await fn();
        failures.push(name + '\n  例外が出るはずが出ていません');
    } catch (e) {
        if (pattern.test(e.message)) passed++;
        else failures.push(name + '\n  メッセージが期待と違います: ' + e.message);
    }
}

function stubFetch(handler) {
    const calls = [];
    globalThis.fetch = (url, init) => {
        calls.push({ url: url, init: init || {} });
        return Promise.resolve(handler(url, init || {}));
    };
    return calls;
}
const jsonResponse = (body, status) => ({
    ok: status >= 200 && status < 300, status: status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
});

(async () => {
    // 投入成功
    stubFetch(() => jsonResponse({ prompt_id: 'pid-1' }, 200));
    check('prompt_id を受け取る', await illustrationUtils.submitWorkflow('http://h:8188', apiWorkflow, 'cid'), 'pid-1');

    // 投入時に node_errors を伴って拒否された場合、ノード情報を出す
    stubFetch(() => jsonResponse({
        error: { type: 'invalid_input', message: 'bad workflow' },
        node_errors: { '5': [{ node_id: '5', node_type: 'KSampler', type: 'bad_value', message: 'steps out of range' }] },
    }, 400));
    await expectThrow('投入拒否でノード情報を出す',
        () => illustrationUtils.submitWorkflow('http://h:8188', apiWorkflow, 'cid'),
        /KSampler.*steps out of range/s);

    // 到達できない場合は CORS の対処法を出す
    globalThis.fetch = () => Promise.reject(new TypeError('Failed to fetch'));
    await expectThrow('到達不可は CORS の説明を出す',
        () => illustrationUtils.submitWorkflow('http://h:8188', apiWorkflow, 'cid'),
        /--enable-cors-header/);

    // history: 最初は空、次に完了
    let historyCalls = 0;
    stubFetch(() => {
        historyCalls++;
        if (historyCalls === 1) return jsonResponse({}, 200);
        return jsonResponse({ 'pid-1': { outputs: { '9': { images: [{ filename: '00001-.png', subfolder: '', type: 'output' }] } }, status: { status_str: 'success' } } }, 200);
    });
    const completed = await illustrationUtils.waitForHistory('http://h:8188', 'pid-1', 5000, 10, null);
    checkTrue('ポーリングで完了を待つ', historyCalls >= 2 && !!completed.outputs, 'calls=' + historyCalls);

    // history: ノード実行エラー
    stubFetch(() => jsonResponse({
        'pid-1': { outputs: {}, status: { status_str: 'error', status_details: { exception_messages: ['KSampler: value not in range'] } } },
    }, 200));
    await expectThrow('ノード実行エラーを区別する',
        () => illustrationUtils.waitForHistory('http://h:8188', 'pid-1', 5000, 10, null),
        /ノード実行でエラー.*KSampler/s);

    // history: タイムアウト
    stubFetch(() => jsonResponse({}, 200));
    await expectThrow('タイムアウトを区別する',
        () => illustrationUtils.waitForHistory('http://h:8188', 'pid-1', 120, 50, null),
        /タイムアウト/);

    // /view: 画像を取り出す
    const viewCalls = stubFetch(() => ({ ok: true, status: 200, blob: () => Promise.resolve({ size: 10 }) }));
    const fetched = await illustrationUtils.fetchOutputImage('http://h:8188',
        { outputs: { '9': { images: [{ filename: 'a.png', subfolder: 'sub', type: 'output' }] } } }, null);
    check('画像ファイル名を返す', fetched.filename, 'a.png');
    const viewUrl = viewCalls.length ? viewCalls[0].url : '';
    checkTrue('/view のクエリが正しい',
        /\/view\?/.test(viewUrl) && /filename=a\.png/.test(viewUrl) && /subfolder=sub/.test(viewUrl) && /type=output/.test(viewUrl), viewUrl);

    // /view: 出力が空
    globalThis.fetch = () => Promise.resolve(jsonResponse({}, 200));
    await expectThrow('空出力は SaveImage を案内する',
        () => illustrationUtils.fetchOutputImage('http://h:8188', { outputs: {} }, null),
        /SaveImage/);

    // 中断
    const aborted = { aborted: true };
    await expectThrow('中断を伝える',
        () => illustrationUtils.waitForHistory('http://h:8188', 'pid-1', 5000, 10, aborted),
        /中断/);

    console.log('passed: ' + passed + ', failed: ' + failures.length);
    if (failures.length) {
        console.log('\n' + failures.join('\n\n'));
        process.exit(1);
    }
})();
