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

// ── プレースホルダ差し込み（JSON を壊さない）─────────────────
state.settings = {
    comfyNegativePrompt: 'bad anatomy', comfyWidth: 512, comfyHeight: 768,
    comfySteps: 20, comfyCfg: 7, comfySeed: 42,
};
const built = illustrationUtils.buildPlaceholderValues(apiWorkflow);
check('寸法・steps・cfg が渡る', [built.values.width, built.values.height, built.values.steps, built.values.cfg], [512, 768, 20, 7]);
check('seed 固定', built.values.seed, 42);

const tricky = '1girl, "quoted", a, b';
const substituted = illustrationUtils.substitutePlaceholders(apiWorkflow, Object.assign({}, built.values, { prompt: tricky }));
let reparsed = null;
let parseError = '';
try { reparsed = JSON.parse(substituted); } catch (e) { parseError = e.message; }
checkTrue('差し込み後も JSON が壊れない', reparsed !== null, parseError);
check('引用符は JSON としてエスケープされる', reparsed && reparsed['3'].inputs.text, tricky);
check('数値は quotes なしで入る', reparsed && reparsed['5'].inputs.width, 512);

// 本文に %prompt% が部分一致しても壊さない
const partial = JSON.stringify({ '1': { class_type: 'X', inputs: { note: 'prefix %prompt% suffix' } } });
check('文字列内の部分一致は置換しない', illustrationUtils.substitutePlaceholders(partial, { prompt: 'NOPE' }), partial);

// %scale% 互換
state.settings.comfyCfg = 9;
const scaleWf = JSON.stringify({ '1': { class_type: 'X', inputs: { scale: '%scale%' } } });
check('%scale% には cfg の値が入る',
    illustrationUtils.substitutePlaceholders(scaleWf, illustrationUtils.buildPlaceholderValues(scaleWf).values),
    JSON.stringify({ '1': { class_type: 'X', inputs: { scale: 9 } } }));

// seed = -1 で毎回ランダム
state.settings.comfySeed = -1;
const randomSeed = illustrationUtils.buildPlaceholderValues(apiWorkflow).seed;
checkTrue('seed=-1 でランダム', typeof randomSeed === 'number' && randomSeed >= 0, String(randomSeed));

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
