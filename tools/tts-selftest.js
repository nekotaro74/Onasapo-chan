// 読み上げ（TTS）のコアロジックをブラウザなしで検証する実験用スクリプト。
// index.html から ttsUtils を抜き出して実行するだけで、アプリ本体は読み込まない。
// 実行: node tools/tts-selftest.js
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
const state = { settings: {}, currentMessages: [] };
const elements = {};

// ttsUtils が参照する const を先に eval しておく
const constStart = html.indexOf('const TTS_SPEAKER_SLOTS');
if (constStart === -1) throw new Error('TTS_SPEAKER_SLOTS が見つかりません');
const constLines = html.slice(constStart, html.indexOf('const ttsUtils = {', constStart));

const utilsSource = extractObject(html, 'const ttsUtils = {');
eval(`${constLines}\n${utilsSource}\n; globalThis.ttsUtils = ttsUtils;`);

let passed = 0;
let failed = 0;

function check(label, actual, expected) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a === e) { passed++; return; }
    failed++;
    console.log(`FAIL ${label}\n  expected: ${e}\n  actual:   ${a}`);
}

// 話者名 -> ボイス。kind/voice だけ見れば話者割当まで同時に検証できる
function speak(text) {
    return ttsUtils.buildSegments(text).map(seg => `${seg.kind}:${seg.voice}:${seg.text}`);
}

function resetSettings() {
    state.settings = {
        ttsDefaultVoice: 'narrator',
        ttsGenericVoice: 'generic',
        ttsNarrateDialogueOnly: false,
        ttsRegexEnabled: false,
        ttsRegexPattern: '',
        ttsSpeakers: [
            { name: 'まゆみ', voice: 'mayumi' },
            { name: 'まゆみ子', voice: 'mayumiko' },
            { name: 'れな', voice: 'rena' },
        ],
    };
}

// ── 同じ行の優先順（仕様どおりの 6 段階）──────────────────
resetSettings();
check('1 名前+心理描写+セリフ',
    speak('まゆみ（微笑む）「こんにちは」'),
    ['action:mayumi:微笑む', 'dialogue:mayumi:こんにちは']);
check('2 名前+セリフ（「」）',
    speak('まゆみ「こんにちは」'),
    ['dialogue:mayumi:こんにちは']);
check('2 名前+セリフ（『』）',
    speak('まゆみ『こんにちは』'),
    ['dialogue:mayumi:こんにちは']);
check('2 名前+セリフ（引用符）',
    speak('まゆみ"hello"'),
    ['dialogue:mayumi:hello']);
check('3 名前+心理描写だけ',
    speak('まゆみ（微笑む）'),
    ['action:mayumi:微笑む']);
check('4 名前+: +その行の残り',
    speak('まゆみ: こんにちは、元気？'),
    ['dialogue:mayumi:こんにちは、元気？']);
check('5 話者名なしの引用と括弧は汎用ボイス',
    speak('「さみしい」（本当に）'),
    ['dialogue:generic:さみしい', 'action:generic:本当に']);
check('6 残りは地の文',
    speak('夜風が吹いていた。'),
    ['narration:narrator:夜風が吹いていた。']);

// ── 検出は完全一致・最長名優先・見るのは行頭/改行後/文境界だけ ──
check('最長名を優先する',
    speak('まゆみ子「やあ」'),
    ['dialogue:mayumiko:やあ']);
check('名前の後に引用・括弧・コロンが無ければ地の文の一部',
    speak('まゆみは笑った。'),
    ['narration:narrator:まゆみは笑った。']);
check('文境界後の名前も拾う',
    speak('扉が開いた。れな「ただいま」'),
    ['narration:narrator:扉が開いた。', 'dialogue:rena:ただいま']);
check('改行後の名前も拾う',
    speak('夜だった。\nれな「ただいま」'),
    ['narration:narrator:夜だった。', 'dialogue:rena:ただいま']);
check('名前の途中一致は話者として扱わない（引用は汎用）',
    speak('まゆみみ「やあ」'),
    ['narration:narrator:まゆみみ', 'dialogue:generic:やあ']);
check('1 行に複数話者',
    speak('まゆみ「あ」れな「い」'),
    ['dialogue:mayumi:あ', 'dialogue:rena:い']);

// ── 半角と全角を同じとして扱う ──
check('全角スペース・全角括弧・全角コロン・”',
    speak('まゆみ　（微笑む）“やあ”'),
    ['action:mayumi:微笑む', 'dialogue:mayumi:やあ']);
check('全角コロンでも 4 番の形',
    speak('まゆみ：こんにちは'),
    ['dialogue:mayumi:こんにちは']);
check('話者名自体の全角・半角も同じ',
    speak('まゆみ「やあ」'),
    ['dialogue:mayumi:やあ']);

// ── コードブロック・URL・Markdown の装飾は読まない ──
check('コードブロックを除く',
    speak('本文\n```js\nconst x = 1;\n```\n続き'),
    ['narration:narrator:本文', 'narration:narrator:続き']);
check('~~~ コードも除く',
    speak('前\n~~~\ny = 2\n~~~\n後'),
    ['narration:narrator:前', 'narration:narrator:後']);
check('インラインコードを除く',
    speak('値は `42` です'),
    ['narration:narrator:値は です']);
check('URL を除く',
    speak('詳細は https://example.com/a/b を参照。'),
    ['narration:narrator:詳細は を参照。']);
check('Markdown の強調・リンク・見出し・箇条書き',
    speak('**太字** *斜体* [リンク](http://x.y)'),
    ['narration:narrator:太字 斜体 リンク']);
check('見出しと箇条書きの記号',
    speak('# 見出し\n- 項目一\n- 項目二'),
    ['narration:narrator:見出し', 'narration:narrator:項目一', 'narration:narrator:項目二']);

// ── 送信前の正規表現フィルタ（1つ）──────────────────────
resetSettings();
state.settings.ttsRegexEnabled = true;
state.settings.ttsRegexPattern = '\\([^)]*\\)';
check('フィルタで心理描写を除く',
    speak('まゆみ（微笑む）「こんにちは」'),
    ['dialogue:mayumi:こんにちは']);
state.settings.ttsRegexPattern = '';
check('パターンが空なら何もしない',
    speak('まゆみ（微笑む）「こんにちは」'),
    ['action:mayumi:微笑む', 'dialogue:mayumi:こんにちは']);
state.settings.ttsRegexPattern = '[invalid(';
check('不正な正規表現でも落とさない',
    speak('まゆみ「こんにちは」'),
    ['dialogue:mayumi:こんにちは']);

// ── 地の文を読まずセリフだけ読み上げる ──────────────────
resetSettings();
state.settings.ttsNarrateDialogueOnly = true;
check('オンなら地の文をキューに入れない',
    speak('まゆみ（笑）「こんにちは」\n夜風が吹いていた。\n「話者なしの引用」'),
    ['action:mayumi:笑', 'dialogue:mayumi:こんにちは', 'dialogue:generic:話者なしの引用']);
state.settings.ttsNarrateDialogueOnly = false;

// ── ボイス未設定の断片は読まない ────────────────────────
resetSettings();
state.settings.ttsDefaultVoice = '';
check('地の文のボイス未設定なら地の文だけ落ちる',
    speak('夜風が吹いていた。まゆみ「こんにちは」'),
    ['dialogue:mayumi:こんにちは']);
resetSettings();
state.settings.ttsSpeakers = [];
check('話者割当が無ければ全部 地の文/汎用',
    speak('まゆみ「こんにちは」'),
    ['narration:narrator:まゆみ', 'dialogue:generic:こんにちは']);

// ── エンドポイント正規化 ────────────────────────────────
check('base に /audio/speech を足す',
    ttsUtils.normalizeEndpoint('https://api.example.com/v1'),
    'https://api.example.com/v1/audio/speech');
check('末尾スラッシュを落とす',
    ttsUtils.normalizeEndpoint('https://api.example.com/v1/'),
    'https://api.example.com/v1/audio/speech');
check('既に /audio/speech なら足さない',
    ttsUtils.normalizeEndpoint('https://api.example.com/v1/audio/speech'),
    'https://api.example.com/v1/audio/speech');
check('空は空のまま', ttsUtils.normalizeEndpoint(''), '');

// ── audio/speech の input 上限で切る ────────────────────
const long = 'あ。'.repeat(1500);          // 3000 字
const chunks = ttsUtils.chunkText(long);
check('長い本文は複数 chunk', chunks.length > 1, true);
check('chunk は 1200 字以内', chunks.every(c => c.length <= 1200), true);
check('chunk を繋ぐと原文と同じ', chunks.join(''), long);
check('短い本文は 1 chunk', ttsUtils.chunkText('短い文'), ['短い文']);

// ── ボイス一覧（カンマ区切り）───────────────────────────
state.settings.ttsVoices = 'alloy, echo ,,';
check('カンマ区切り一覧を整形', ttsUtils.voiceChoices(), ['alloy', 'echo']);
// 保存時と接続確認の成功時に末尾カンマを自動で付ける。空の項目は選択肢へ入れない
check('末尾カンマの無い入力へカンマを付ける', ttsUtils.normalizeVoicesInput('alloy, echo'), 'alloy, echo,');
check('末尾カンマ付きはそのまま', ttsUtils.normalizeVoicesInput('alloy, echo,'), 'alloy, echo,');
check('末尾の空白を詰めてカンマ', ttsUtils.normalizeVoicesInput('alloy, echo  '), 'alloy, echo,');
check('空欄にはカンマを付けない', ttsUtils.normalizeVoicesInput('   '), '');
check('末尾カンマで空の選択肢は増えない',
    ttsUtils.voiceChoicesFrom(ttsUtils.normalizeVoicesInput('alloy, echo')), ['alloy', 'echo']);

// ── 一覧取得の base 導出（保存済み ttsEndpoint は /audio/speech を含む）──
check('base から /audio/speech を落として一覧へ使う',
    ttsUtils.normalizeApiBase('https://api.example.com/v1/audio/speech'), 'https://api.example.com/v1');
check('/audio/speech 無しはそのまま',
    ttsUtils.normalizeApiBase('https://api.example.com/v1'), 'https://api.example.com/v1');
check('末尾スラッシュを落とす',
    ttsUtils.normalizeApiBase('https://api.example.com/v1//'), 'https://api.example.com/v1');
check('大文字小文字の違いでも /audio/speech を落とす',
    ttsUtils.normalizeApiBase('https://api.example.com/v1/AUDIO/SPEECH'), 'https://api.example.com/v1');
check('空は空のまま（base 導出）', ttsUtils.normalizeApiBase(''), '');

// ── 一覧エンドポイントの候補順 ──────────────────────────
check('/audio/voices を先に、/voices を後に試す',
    ttsUtils.voicesUrlCandidates('https://api.example.com/v1'),
    ['https://api.example.com/v1/audio/voices', 'https://api.example.com/v1/voices']);

// ── 一覧のレスポンス形（サーバーごとに違う）──────────────
const irodoriShape = {
    object: 'list',
    data: [
        { id: 'momo', object: 'voice', ref_wav: 'momo.wav', ref_wavs: [], ref_latent: null, ref_latents: [], ref_embed: null, no_ref: false },
        { id: 'rima', object: 'voice', ref_wav: null, ref_latent: null, ref_latents: ['r.pt'], ref_embed: null, no_ref: false },
        { id: 'si', object: 'voice', ref_wav: null, ref_embed: 'si.speaker.safetensors', no_ref: false },
        { id: 'none', object: 'voice', ref_wav: null, no_ref: true },
        { id: 'both', ref_wav: 'b.wav', ref_latents: ['b.pt'] },
    ],
};
check('Irodori 形は id と種別を両方取る', ttsUtils.parseVoicesPayload(irodoriShape), [
    { id: 'momo', kinds: ['ref_wav'] },
    { id: 'rima', kinds: ['ref_latent'] },
    { id: 'si', kinds: ['ref_embed'] },
    { id: 'none', kinds: ['no_ref'] },
    { id: 'both', kinds: ['ref_wav', 'ref_latent'] },
]);
check('Kokoro 形の文字列一覧は種別不明',
    ttsUtils.parseVoicesPayload({ voices: ['af_heart', 'af_bella'] }),
    [{ id: 'af_heart', kinds: [] }, { id: 'af_bella', kinds: [] }]);
check('素の配列も読める', ttsUtils.parseVoicesPayload(['a', 'b']), [{ id: 'a', kinds: [] }, { id: 'b', kinds: [] }]);
check('name のみの object も拾う',
    ttsUtils.parseVoicesPayload({ voices: [{ name: 'kanna' }] }), [{ id: 'kanna', kinds: [] }]);
check('ref_latents の空配列を latent と誤らない',
    ttsUtils.parseVoicesPayload({ data: [{ id: 'x', ref_latents: [] }] }), [{ id: 'x', kinds: [] }]);
check('同一 id のエイリアスは種別を寄せる',
    ttsUtils.parseVoicesPayload({ data: [{ id: 'y', ref_wav: 'y.wav' }, { id: 'y', ref_latent: 'y.pt' }] }),
    [{ id: 'y', kinds: ['ref_wav', 'ref_latent'] }]);
check('id の無い要素は除外', ttsUtils.parseVoicesPayload({ data: [{ ref_wav: 'a.wav' }, { id: 'ok' }] }), [{ id: 'ok', kinds: [] }]);
check('一覧の形が無ければ空配列', ttsUtils.parseVoicesPayload('<html>SPA</html>'), []);
check('null も空配列', ttsUtils.parseVoicesPayload(null), []);

// ── 取得一覧を ttsVoices（カンマ区切り）へ往復 ────────────
const fetchedIds = ttsUtils.voiceIdsFromEntries(ttsUtils.parseVoicesPayload(irodoriShape));
check('取得 id をカンマ区切りへ（末尾カンマ付き）',
    ttsUtils.voicesToInput(fetchedIds), 'momo, rima, si, none, both,');
check('カンマ区切りにすると元の id 列に戻る',
    ttsUtils.voiceChoicesFrom(ttsUtils.voicesToInput(fetchedIds)), fetchedIds);
check('空一覧は空欄（カンマを付けない）', ttsUtils.voicesToInput([]), '');

// ── チェックボックス一覧の表示列表 ────────────────────────
const catalog = ttsUtils.parseVoicesPayload(irodoriShape);
const merged = ttsUtils.mergeVoiceSelection(catalog, ['rima', 'gone']);
check('カタログ順が先で、一覧に無い保存値は末尾',
    merged.display.map(item => `${item.voice}${item.inCatalog ? '' : '*'}`),
    ['momo', 'rima', 'si', 'none', 'both', 'gone*']);
// 一覧から消えた保存値もチェック済みのまま残す（選択を失わない）
check('保存値はカタログの有無に関わらずチェック済み', merged.checked, ['rima', 'gone']);
check('種別は表示列表へ引き継ぐ', merged.display[1].kinds, ['ref_latent']);
check('カタログが無くても保存値だけ並ぶ',
    ttsUtils.mergeVoiceSelection([], ['a']).display.map(item => item.voice), ['a']);

// ── 読み上げ本文は message.content から作る（挿絵プロンプト欄は読まない）──
resetSettings();
state.currentMessages = [{
    role: 'model',
    content: 'まゆみ「こんにちは」',
    illustration: { prompt: '1girl, smiling, best quality', images: [] },
}];
// ブラウザの Audio / fetch がないので、再生開始だけ止めてキューの中身を見る
ttsUtils.pump = () => { };
check('挿絵プロンプトは読み上げ本文に含まれない',
    ttsUtils.enqueueMessage(0) > 0 && !ttsUtils.queue.some(job => /best quality/.test(job.text)),
    true);
check('content だけをキューに入れる',
    ttsUtils.queue.map(job => `${job.voice}:${job.text}`),
    ['mayumi:こんにちは']);
ttsUtils.queue.length = 0;
check('model 以外読み上げない', ttsUtils.enqueueMessage(999), 0);


// ── 段落（空行区切り。空行が無い応答では改行区切り）──────
function paragraphs(text) {
    return ttsUtils.paragraphRanges(text).ranges.map(r => text.slice(r.start, r.end));
}
resetSettings();
check('空行で段落を区切る', paragraphs('一\n二\n\n三'), ['一\n二', '三']);
check('空行が無ければ改行で区切る', paragraphs('一\n二\n三'), ['一', '二', '三']);
check('コードブロックは 1 段落として扱う',
    paragraphs('本文\n```\nconst x = 1;\n```\n続き'),
    ['本文', '```\nconst x = 1;\n```', '続き']);
check('閉じていないコードブロックの開始位置を返す',
    ttsUtils.paragraphRanges('本文\n```\nconst x = 1;').openFenceStart, 3);

// ── 受信しながらの段落送り ──────────────────────────────
ttsUtils.pump = () => { };
const feedReset = () => { ttsUtils.queue.length = 0; ttsUtils.beginStream(); };

feedReset();
check('確定した段落だけを送る', ttsUtils.feedStream('まゆみ「あ」\n\nまゆみ「い」'), 1);
check('送ったのは先頭の段落だけ', ttsUtils.queue.map(j => j.text), ['あ']);
ttsUtils.queue.length = 0;
check('同じ本文を再送しない', ttsUtils.feedStream('まゆみ「あ」\n\nまゆみ「い」'), 0);
check('受信完了で末尾の段落を送る', ttsUtils.finishStream('まゆみ「あ」\n\nまゆみ「い」'), 1);
check('段落順にキューへ積まる', ttsUtils.queue.map(j => j.text), ['い']);

feedReset();
check('閉じていないコードブロックの中は送らない', ttsUtils.feedStream('本文\n```\nconst x = 1;'), 1);
check('コードブロックの手前までしか送らない', ttsUtils.queue.map(j => j.text), ['本文']);
ttsUtils.queue.length = 0;
check('コードブロックが閉じると中身は読み上げない',
    ttsUtils.finishStream('本文\n```\nconst x = 1;\n```'), 0);

feedReset();
ttsUtils.feedStream('まゆみ「あ」\n\n');
ttsUtils.stopAll();
check('停止すると未送信分も破棄する', ttsUtils.finishStream('まゆみ「あ」\n\nまゆみ「い」'), 0);

// ── メガホン（手動）も同じ段落順で送る ──────────────────
feedReset();
state.currentMessages = [{ role: 'model', content: 'まゆみ「あ」\n\nまゆみ「い」\n\nまゆみ「う」' }];
check('手動読み上げは先頭の段落から同じ順', ttsUtils.enqueueMessage(0, true), 3);
check('キューの中身は段落順', ttsUtils.queue.map(j => j.text), ['あ', 'い', 'う']);
ttsUtils.queue.length = 0;

console.log(`passed: ${passed}, failed: ${failed}`);
process.exit(failed ? 1 : 0);
