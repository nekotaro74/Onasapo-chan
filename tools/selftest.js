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
checkTrue('%scale% は未対応トークンとして止まる', /%scale%/.test((illustrationUtils.prepareWorkflow({ '1': { class_type: 'X', inputs: { c: '%scale%' } } }) || {}).error || ''));
checkTrue('%cfg% は差し込まれる', (illustrationUtils.prepareWorkflow({ '1': { class_type: 'X', inputs: { c: '%cfg%' } } }) || {}).ok === true);
checkTrue('%scale% は組み込みトークン一覧に無い', !illustrationUtils.builtinTokens().includes('scale'));
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

// %cfg%（%scale% は廃止した）
state.settings.comfyCfg = 9;
const cfgWf = { '1': { class_type: 'X', inputs: { cfg: '%cfg%' } } };
check('%cfg% には cfg の値が入る',
    illustrationUtils.substituteTokens(cfgWf, illustrationUtils.buildTokenValues().values).object['1'].inputs.cfg, 9);
checkTrue('%scale% は未対応として残る',
    illustrationUtils.substituteTokens({ '1': { inputs: { scale: '%scale%' } } }, illustrationUtils.buildTokenValues().values).unresolved.indexOf('scale') !== -1);

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

// ── LoRA（最大4個）─────────────────────────────────────────
const loraWorkflow = () => ({
    '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'm.safetensors' } },
    '2': { class_type: 'LoraLoader', inputs: { model: ['1', 0], clip: ['1', 1], lora_name: '%lora1%', strength_model: '%lora_str1%', strength_clip: '%lora_str1%' } },
    '3': { class_type: 'CLIPTextEncode', inputs: { clip: ['2', 1], text: 'x' } },
    '4': { class_type: 'KSampler', inputs: { model: ['2', 0], clip: ['3', 0] } },
    '9': { class_type: 'SaveImage', inputs: { images: null } },
});
const emptySlots = () => [{ name: '', strength: 1 }, { name: '', strength: 1 }, { name: '', strength: 1 }, { name: '', strength: 1 }];
state.settings.comfyLoras = emptySlots();

// 使わないスロット + ファイルあり: ノードの形は変えず、先頭の実在ファイルと強度0
const loraUnused = illustrationUtils.applyLoraNodes(loraWorkflow(), ['a.safetensors', 'b.safetensors']);
checkTrue('LoRA 不使用でもノードは残す', loraUnused.ok && !!loraUnused.object['2']);
check('LoRA 不使用は先頭ファイルと強度0',
    [loraUnused.object['2'].inputs.lora_name, loraUnused.object['2'].inputs.strength_model, loraUnused.object['2'].inputs.strength_clip],
    ['a.safetensors', 0, 0]);
check('LoRA 不使用でも接続はそのまま', [loraUnused.object['3'].inputs.clip, loraUnused.object['4'].inputs.model], [['2', 1], ['2', 0]]);

// 使うスロット: 選んだファイル名と入力強度
state.settings.comfyLoras[0] = { name: 'c.safetensors', strength: 0.6 };
const loraUsed = illustrationUtils.applyLoraNodes(loraWorkflow(), ['a.safetensors']);
check('LoRA を使う場合は選んだ値を入れる',
    [loraUsed.object['2'].inputs.lora_name, loraUsed.object['2'].inputs.strength_model, loraUsed.object['2'].inputs.strength_clip],
    ['c.safetensors', 0.6, 0.6]);

// 使うスロットでフォルダが空: 送らずに理由を出す
const loraEmptyFolder = illustrationUtils.applyLoraNodes(loraWorkflow(), []);
checkTrue('LoRA使用でフォルダ空は生成を止める', !loraEmptyFolder.ok, JSON.stringify(loraEmptyFolder));
checkTrue('その理由に loras フォルダを書く', /loras フォルダ/.test(loraEmptyFolder.error || ''), loraEmptyFolder.error);
state.settings.comfyLoras = emptySlots();

// 使わないスロット + フォルダ空: そのノードだけ外して直結（ワークフロー全体は書き換えない）
const loraBypass = illustrationUtils.applyLoraNodes(loraWorkflow(), []);
checkTrue('フォルダ空はその LoraLoader だけ外す', loraBypass.ok && !loraBypass.object['2'], JSON.stringify(Object.keys(loraBypass.object)));
check('model を直結する', loraBypass.object['4'].inputs.model, ['1', 0]);
check('clip を直結する', loraBypass.object['3'].inputs.clip, ['1', 1]);
check('他のノードはそのまま', Object.keys(loraBypass.object).sort(), ['1', '3', '4', '9']);

// LoraLoaderModelOnly も同じ扱い（%lora1% を参照するノードが対象）
const modelOnlyWf = () => ({
    '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'm.safetensors' } },
    '2': { class_type: 'LoraLoaderModelOnly', inputs: { model: ['1', 0], lora_name: '%lora1%', strength_model: '%lora_str1%' } },
    '4': { class_type: 'KSampler', inputs: { model: ['2', 0] } },
    '9': { class_type: 'SaveImage', inputs: { images: null } },
});
const modelOnlyUnused = illustrationUtils.applyLoraNodes(modelOnlyWf(), ['z.safetensors'], modelOnlyWf());
check('LoraLoaderModelOnly は strength_model だけ 0',
    [modelOnlyUnused.object['2'].inputs.lora_name, modelOnlyUnused.object['2'].inputs.strength_model], ['z.safetensors', 0]);
checkTrue('LoraLoaderModelOnly に strength_clip は入れない',
    modelOnlyUnused.object['2'].inputs.strength_clip === undefined);
const modelOnlyBypass = illustrationUtils.applyLoraNodes(modelOnlyWf(), [], modelOnlyWf());
checkTrue('ModelOnly もフォルダ空なら外して直結',
    modelOnlyBypass.ok && !modelOnlyBypass.object['2'] && modelOnlyBypass.object['4'].inputs.model[0] === '1',
    JSON.stringify(modelOnlyBypass.object['4'].inputs));

// LoRA ノードの無い同梱規定ワークフローは、一覧が空でもそのまま通る
const noLoraWf = {
    '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: '%model%' } },
    '6': { class_type: 'KSampler', inputs: { model: ['1', 0] } },
    '8': { class_type: 'SaveImage', inputs: { images: ['6', 0] } },
};
const noLora = illustrationUtils.applyLoraNodes(noLoraWf, []);
checkTrue('LoRA ノード無しは空フォルダでも無傷', noLora.ok && Object.keys(noLora.object).length === 3, JSON.stringify(noLora));

// %lora1% / %lora_str1% はワークフローに含まれるときだけ効く
const loraTokens = illustrationUtils.buildTokenValues().values;
checkTrue('lora トークンも差し込み値として揃う',
    ['lora1', 'lora2', 'lora3', 'lora4', 'lora_str1', 'lora_str4'].every(t => Object.prototype.hasOwnProperty.call(loraTokens, t)));
checkTrue('lora トークンは組み込み一覧に入っている', illustrationUtils.builtinTokens().includes('lora1'));
state.settings.comfyLoras[1] = { name: 'two.safetensors', strength: 0.3 };
check('2個目のスロットが効く', illustrationUtils.buildTokenValues().values.lora_str2, 0.3);
state.settings.comfyLoras = emptySlots();

// 旧形式の挿絵（imageDataUrl 直）は images へ寄り込む
const legacyIll = { status: 'done', imageDataUrl: 'data:image/png;base64,AAA', seed: 7, sourceFilename: 'a.png' };
const migrated = illustrationUtils.normalizeIllustration(legacyIll);
check('旧形式を images へ移す', migrated.images.length, 1);
check('旧形式の seed とファイル名を移す', [migrated.images[0].seed, migrated.images[0].filename], [7, 'a.png']);
checkTrue('直の imageDataUrl は消える', migrated.imageDataUrl === undefined);
check('表示は最後の1枚', migrated.viewIndex, 0);
illustrationUtils.pushImage(migrated, { dataUrl: 'data:image/png;base64,BBB', seed: 8 });
check('再生成は古いものを残して足す', migrated.images.length, 2);
check('新しい方を見る', migrated.viewIndex, 1);
check('1枚だけ消すと0番を見る', illustrationUtils.removeCurrentImage(migrated).viewIndex, 0);
check('全部消すと null', illustrationUtils.removeCurrentImage(migrated), null);
checkTrue('hasImages', illustrationUtils.hasImages({ images: [{}] }) && !illustrationUtils.hasImages({ images: [] }));

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

    // /models/loras から LoRA 一覧を取る（object_info ではなくこの endpoint）
    const loraCalls = stubFetch((url) => (url.indexOf('/models/loras') !== -1
        ? jsonResponse([{ name: 'one.safetensors' }, { name: 'two.safetensors' }], 200)
        : jsonResponse({ error: 'no' }, 404)));
    illustrationUtils.loraCache = null;
    check('models/loras から一覧を取る', await illustrationUtils.fetchLoraNames('http://h:8188', null), ['one.safetensors', 'two.safetensors']);
    checkTrue('/models/loras を叩く', loraCalls.some(c => /\/models\/loras$/.test(c.url)));
    illustrationUtils.loraCache = null;
    globalThis.fetch = () => Promise.reject(new TypeError('Failed to fetch'));
    check('LoRA 一覧が取れないときは null（ノードの値をそのまま送る）', await illustrationUtils.fetchLoraNames('http://h:8188', null), null);
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

    // ── 同梱の規定ワークフロー（Anima 用 2 件）────────────────────
    const animaTurbo = eval(extractObject(html, 'const ANIMA_WORKFLOW_TURBO_OBJECT = ') + '; ANIMA_WORKFLOW_TURBO_OBJECT');
    const animaLora4 = eval(extractObject(html, 'const ANIMA_WORKFLOW_LORA4_OBJECT = ') + '; ANIMA_WORKFLOW_LORA4_OBJECT');
    checkTrue('規定ワークフロー名①が同梱されている',
        html.includes('Anima用デフォルト① +Turbo LoRA組込済'));
    checkTrue('規定ワークフロー名②が同梱されている',
        html.includes('Anima用デフォルト② LoRA x 4'));

    state.settings.comfyModel = 'anima.safetensors';
    state.settings.comfyVae = 'anima_vae.safetensors';
    state.settings.comfyTextEncoder = 'gemma_2b.safetensors';
    state.settings.comfySampler = 'euler_a';
    state.settings.comfyScheduler = 'normal';
    state.settings.comfyWidth = 512;
    state.settings.comfyHeight = 512;
    state.settings.comfySteps = 20;
    state.settings.comfyCfg = 7;
    state.settings.comfyDenoise = 1;
    state.settings.comfyClipSkip = 1;
    state.settings.comfySeed = -1;
    state.settings.comfyCustomPlaceholders = [];
    state.settings.comfyLoras = [
        { name: '', strength: 1 }, { name: '', strength: 1 },
        { name: '', strength: 1 }, { name: '', strength: 1 },
    ];

    const turboParse = illustrationUtils.parseWorkflow(JSON.stringify(animaTurbo));
    checkTrue('規定①が API 形式として通る', turboParse.ok, turboParse.error);
    const lora4Parse = illustrationUtils.parseWorkflow(JSON.stringify(animaLora4));
    checkTrue('規定②が API 形式として通る', lora4Parse.ok, lora4Parse.error);

    const turboPrepared = illustrationUtils.prepareWorkflow(turboParse.object);
    checkTrue('規定①のトークンが全て埋まる', turboPrepared.ok, turboPrepared.error);
    const lora4Prepared = illustrationUtils.prepareWorkflow(lora4Parse.object);
    checkTrue('規定②のトークンが全て埋まる', lora4Prepared.ok, lora4Prepared.error);

    const turboTokens = illustrationUtils.findPlaceholders(JSON.stringify(animaTurbo));
    checkTrue('規定①は %loraN% を持たない',
        !turboTokens.some(token => /^lora(_str)?[1-4]$/.test(token)), turboTokens.join(','));
    const lora4Tokens = illustrationUtils.findPlaceholders(JSON.stringify(animaLora4));
    checkTrue('規定②は %lora1%〜%lora4% と %lora_str1%〜%lora_str4% を持つ',
        ['lora1', 'lora2', 'lora3', 'lora4', 'lora_str1', 'lora_str2', 'lora_str3', 'lora_str4']
            .every(token => lora4Tokens.includes(token)), lora4Tokens.join(','));

    // UNETLoader / CLIPLoader / VAELoader 形式なので、VAE と CLIP の選択が必須になる
    const savedVae = state.settings.comfyVae;
    state.settings.comfyVae = '';
    const noVae = illustrationUtils.prepareWorkflow(JSON.parse(JSON.stringify(animaTurbo)));
    checkTrue('規定①は VAE 未選択だと未対応プレースホルダで止まる',
        !noVae.ok && /%vae%/.test(noVae.error || ''), noVae.error);
    state.settings.comfyVae = savedVae;

    // 固定名の LoRA ノード（同梱①の Turbo LoRA）は、%loraN% を参照しないので管理対象にしない
    const fixedLoraWf = () => ({
        '44': { class_type: 'UNETLoader', inputs: { unet_name: 'anima.safetensors' } },
        '50': {
            class_type: 'LoraLoader',
            inputs: {
                model: ['44', 0], clip: ['44', 1],
                lora_name: 'anima-turbo-lora-v0.2.safetensors', strength_model: 1, strength_clip: 1,
            },
        },
        '19': { class_type: 'KSampler', inputs: { model: ['50', 0] } },
        '9': { class_type: 'SaveImage', inputs: { images: null } },
    });
    const fixedLora = illustrationUtils.applyLoraNodes(fixedLoraWf(), ['z.safetensors'], fixedLoraWf());
    checkTrue('固定名の LoRA ノードは触らない',
        fixedLora.ok
        && fixedLora.object['50'].inputs.lora_name === 'anima-turbo-lora-v0.2.safetensors'
        && fixedLora.object['50'].inputs.strength_model === 1,
        JSON.stringify(fixedLora.object['50']));
    const fixedLoraEmpty = illustrationUtils.applyLoraNodes(fixedLoraWf(), [], fixedLoraWf());
    checkTrue('固定名の LoRA ノードは loras フォルダが空でも外さない',
        fixedLoraEmpty.ok && !!fixedLoraEmpty.object['50'], JSON.stringify(fixedLoraEmpty));
    checkTrue('固定名の LoRA ノードだけなら一覧を取りに行かない',
        illustrationUtils.hasLoraNodes(fixedLoraWf()) === false);

    // rgthree の Power Lora Loader は、選んだスロットだけ on: true にする。
    // 制御するのは %loraN% / %lora_strN% のあるスロットだけ（固定名を書いたスロットは触らない）
    const rgthreeWf = () => ({
        '44': { class_type: 'UNETLoader', inputs: { unet_name: 'anima.safetensors' } },
        '45': { class_type: 'CLIPLoader', inputs: { clip_name: 'gemma_2b.safetensors' } },
        '50': {
            class_type: 'Power Lora Loader (rgthree)',
            inputs: {
                model: ['44', 0], clip: ['45', 0],
                lora_1: { on: false, lora: '%lora1%', strength: '%lora_str1%' },
                lora_2: { on: false, lora: '%lora2%', strength: '%lora_str2%' },
            },
        },
        '19': { class_type: 'KSampler', inputs: { model: ['50', 0] } },
        '9': { class_type: 'SaveImage', inputs: { images: null } },
    });
    checkTrue('rgthree ノードは一覧取得の対象にする',
        illustrationUtils.hasLoraNodes(rgthreeWf()) === true);
    state.settings.comfyLoras[0] = { name: 'one.safetensors', strength: 0.8 };
    const rgthreeObject = rgthreeWf();
    const rgthreeApplied = illustrationUtils.applyLoraNodes(rgthreeObject, ['one.safetensors', 'two.safetensors'], rgthreeWf());
    checkTrue('rgthree は選んだスロットだけ on: true',
        rgthreeApplied.ok
        && rgthreeObject['50'].inputs.lora_1.on === true
        && rgthreeObject['50'].inputs.lora_2.on === false,
        JSON.stringify(rgthreeObject['50'].inputs));
    const rgthreeEmpty = illustrationUtils.applyLoraNodes(rgthreeWf(), [], rgthreeWf());
    checkTrue('rgthree で使うスロットがあると空フォルダは止まる',
        !rgthreeEmpty.ok && /loras フォルダ/.test(rgthreeEmpty.error || ''), rgthreeEmpty.error);
    state.settings.comfyLoras[0] = { name: '', strength: 1 };
    const rgthreeAllOff = illustrationUtils.applyLoraNodes(rgthreeWf(), ['one.safetensors'], rgthreeWf());
    checkTrue('rgthree は使わないスロットを on: false のまま送る',
        rgthreeAllOff.ok
        && rgthreeAllOff.object['50'].inputs.lora_1.on === false
        && rgthreeAllOff.object['50'].inputs.lora_2.on === false,
        JSON.stringify(rgthreeAllOff.object['50'].inputs));

    // ── 受け取れる LoRA スロット数（対応は 4 個まで）───────────────
    // 標準 LoraLoader は %loraN% を参照するノードの数、rgthree は lora_1〜lora_4 の存在数で決める
    const tokenLoraWf = (numbers) => {
        const wf = {
            '44': { class_type: 'UNETLoader', inputs: { unet_name: 'anima.safetensors' } },
            '45': { class_type: 'CLIPLoader', inputs: { clip_name: 'gemma_2b.safetensors' } },
            '9': { class_type: 'SaveImage', inputs: { images: null } },
        };
        numbers.forEach((n, i) => {
            wf[String(50 + i)] = {
                class_type: 'LoraLoader',
                inputs: {
                    model: ['44', 0], clip: ['45', 0],
                    lora_name: `%lora${n}%`,
                    strength_model: `%lora_str${n}%`,
                    strength_clip: `%lora_str${n}%`,
                },
            };
        });
        return wf;
    };
    check('%lora1% と %lora_str1% だけなら受け取れるのは1スロット',
        illustrationUtils.loraSlotCapacity(tokenLoraWf([1])), 1);
    check('%lora1% と %lora2% を別ノードに書いてあれば2スロット',
        illustrationUtils.loraSlotCapacity(tokenLoraWf([1, 2])), 2);
    check('%lora1%〜%lora4% を1ノードに書いても差し込むのは1スロットぶん',
        illustrationUtils.loraSlotCapacity({
            '50': {
                class_type: 'LoraLoader',
                inputs: {
                    model: ['44', 0], clip: ['45', 0],
                    lora_name: '%lora1%', strength_model: '%lora_str1%', strength_clip: '%lora_str1%',
                    note: '%lora2% %lora3% %lora4%',
                },
            },
        }), 1);
    check('rgthree のスロットが2個なら2スロット受け取れる',
        illustrationUtils.loraSlotCapacity(rgthreeWf()), 2);
    const rgthreeFour = rgthreeWf();
    rgthreeFour['50'].inputs.lora_3 = { on: false, lora: '%lora3%', strength: '%lora_str3%' };
    rgthreeFour['50'].inputs.lora_4 = { on: false, lora: '%lora4%', strength: '%lora_str4%' };
    check('rgthree のスロットが4個なら4スロット受け取れる',
        illustrationUtils.loraSlotCapacity(rgthreeFour), 4);
    const rgthreeFive = rgthreeFour;
    rgthreeFive['50'].inputs.lora_5 = { on: true, lora: 'fixed_always.safetensors', strength: 0.9 };
    check('rgthree のスロットが5個あっても対応は4個まで',
        illustrationUtils.loraSlotCapacity(rgthreeFive), 4);
    check('固定名の LoraLoader だけなら0スロット',
        illustrationUtils.loraSlotCapacity(fixedLoraWf()), 0);
    check('LoRA ノードの無いワークフローは0スロット',
        illustrationUtils.loraSlotCapacity({ '44': { class_type: 'UNETLoader', inputs: {} } }), 0);

    // 生成パラメータの既定値（Anima / SDXL 系でそのまま使える値）
    const constValues = {};
    ['DEFAULT_COMFY_SAMPLER', 'DEFAULT_COMFY_SCHEDULER', 'DEFAULT_COMFY_WIDTH', 'DEFAULT_COMFY_HEIGHT',
        'DEFAULT_COMFY_STEPS', 'DEFAULT_COMFY_CFG', 'DEFAULT_COMFY_DENOISE', 'DEFAULT_COMFY_CLIP_SKIP',
        'DEFAULT_COMFY_RESOLUTION_PRESET'].forEach(name => {
        const marker = `const ${name} = `;
        const at = html.indexOf(marker);
        if (at === -1) throw new Error('見つかりません: ' + marker);
        const lineEnd = html.indexOf(';', at);
        constValues[name] = eval(html.slice(at + marker.length, lineEnd));
    });
    check('既定の Sampling method', constValues.DEFAULT_COMFY_SAMPLER, 'euler');
    check('既定の Scheduler', constValues.DEFAULT_COMFY_SCHEDULER, 'simple');
    check('既定の幅', constValues.DEFAULT_COMFY_WIDTH, 1024);
    check('既定の高さ', constValues.DEFAULT_COMFY_HEIGHT, 1024);
    check('既定の Steps', constValues.DEFAULT_COMFY_STEPS, 8);
    check('既定の CFG scale', constValues.DEFAULT_COMFY_CFG, 1);
    check('既定の Denoise', constValues.DEFAULT_COMFY_DENOISE, 1);
    check('既定の CLIP Skip', constValues.DEFAULT_COMFY_CLIP_SKIP, 1);
    check('既定の解像度プリセット', constValues.DEFAULT_COMFY_RESOLUTION_PRESET, '1024x1024');
    // プリセット既定が実在し、幅・高さの既定値と食い違わない
    const presetsMarker = 'const COMFY_RESOLUTION_PRESETS = [';
    const presetsStart = html.indexOf(presetsMarker);
    const presetsEnd = html.indexOf('];', presetsStart);
    const presets = eval(html.slice(presetsStart, presetsEnd + 2) + '; COMFY_RESOLUTION_PRESETS');
    checkTrue('既定の解像度プリセットは一覧に有る',
        presets.some(p => p.value === constValues.DEFAULT_COMFY_RESOLUTION_PRESET),
        constValues.DEFAULT_COMFY_RESOLUTION_PRESET);
    const presetPair = String(constValues.DEFAULT_COMFY_RESOLUTION_PRESET).split('x').map(Number);
    check('既定のプリセットと幅・高さが一致',
        JSON.stringify(presetPair), JSON.stringify([constValues.DEFAULT_COMFY_WIDTH, constValues.DEFAULT_COMFY_HEIGHT]));

    // ── 挿絵生成に送る履歴の切り捨て（上限の文字数）─────────────
    // 1往復 = ユーザー入力1件 + その後の応答
    const rounds = (n) => {
        const list = [];
        for (let i = 1; i <= n; i++) {
            list.push({ role: 'user', content: 'u' + i });
            list.push({ role: 'model', content: 'm' + i });
        }
        return list;
    };
    const fiveRounds = rounds(5);

    const historyDefault = (name) => {
        const marker = 'const ' + name + ' = ';
        const at = html.indexOf(marker);
        if (at === -1) throw new Error('見つかりません: ' + marker);
        return eval(html.slice(at + marker.length, html.indexOf(';', at)));
    };
    check('既定の上限文字数（0 で全件）', historyDefault('DEFAULT_ILLUSTRATION_HISTORY_CHAR_CAP'), 0);
    check('往復数の設定項目は無い', html.indexOf('comfy-history-rounds'), -1);

    let trimmed = illustrationUtils.trimHistoryForIllustration(fiveRounds, 0);
    check('上限 0 は全件', [trimmed.messages.length, trimmed.keptRounds], [10, 5]);
    check('切ったフラグが立たない', trimmed.cutByChars, false);
    check('残った往復数と全体の往復数', [trimmed.keptRounds, trimmed.totalRounds], [5, 5]);

    // 上限の文字数は新しい方を残し、古い方を捨てる
    const longHistory = [
        { role: 'user', content: 'a'.repeat(100) }, { role: 'model', content: 'b'.repeat(100) },
        { role: 'user', content: 'c'.repeat(100) }, { role: 'model', content: 'd'.repeat(100) },
    ];
    trimmed = illustrationUtils.trimHistoryForIllustration(longHistory, 250);
    check('上限文字数で古い方を捨てる', trimmed.messages.map(m => m.content[0]), ['c', 'd']);
    check('文字数で切ったフラグ', trimmed.cutByChars, true);
    check('切った後の往復数', trimmed.keptRounds, 1);

    // 最後の1件（挿絵の対象応答）は上限を超えても残す
    trimmed = illustrationUtils.trimHistoryForIllustration(longHistory, 50);
    check('最後の1件は上限超過でも残す', trimmed.messages.map(m => m.content[0]), ['d']);

    trimmed = illustrationUtils.trimHistoryForIllustration([], 24000);
    check('空の履歴', [trimmed.messages.length, trimmed.totalRounds, trimmed.keptRounds], [0, 0, 0]);

    trimmed = illustrationUtils.trimHistoryForIllustration(fiveRounds, -5);
    check('負数は無制限扱い', trimmed.messages.length, 10);

    console.log('passed: ' + passed + ', failed: ' + failures.length);
    if (failures.length) {
        console.log('\n' + failures.join('\n\n'));
        process.exit(1);
    }
})();
