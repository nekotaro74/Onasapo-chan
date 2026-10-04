# 読み上げ（SillyTavern TTS 拡張 模倣）実装メモ

調査時点: 2026-10-05。調べた範囲は SillyTavern 公式 TTS 拡張の仕様と、OpenAI Compatible な `audio/speech` の呼び出し方のみ。

## 1. 呼び出し仕様

OpenAI の `Create speech` に合わせた 1 発 POST。音声バイトがそのまま返る。

```
POST {endpoint}/audio/speech
Authorization: Bearer {api key}      ※ キーを設定した場合だけ
Content-Type: application/json

{ "model": "...", "voice": "...", "input": "..." }
→ 200 + 音声バイト（Content-Type: audio/*）
```

- body は `model` / `voice` / `input` の 3 つだけ送る。`speed` や `response_format` は送らない。
- 速度は再生側の `Audio.playbackRate`（`preservesPitch = true`）で掛ける。これでサーバーの対応状況に依存しない。
- `input` の上限（OpenAI は 4096 字）を意識し、`TTS_INPUT_CHUNK_CHARS = 1200` で文の切れ目から切る。
- エンドポイントは末尾スラッシュを落としてから、`/audio/speech` で終わらなければ `/audio/speech` を足す。

SillyTavern 側で参考にした点: `skip_codeblocks`（``` と ~~~ を除く）、`apply_regex` + `regex_pattern`（送信前の正規表現フィルタ 1 本）、`narrate_dialogues_only`、voice map による話者割当、`ttsJobQueue` + `currentTtsJob` による直列再生。

## 2. 本リポジトリでの場所

| 項目 | 場所（index.html） |
| --- | --- |
| 定数 | `TTS_SPEAKER_SLOTS = 5`, `TTS_INPUT_CHUNK_CHARS = 1200` |
| ユーティリティ | `const ttsUtils = { ... }`（`comfyWorkflowUtils` の直後） |
| 設定の既定値 | `state.settings` の `tts*`。既定値にキーを足せば `loadSettings` / `saveSettings` が自動的に保存・復元する |
| 設定画面 | `<details class="settings-group" id="settings-group-tts">`（挿絵生成の直後） |
| 設定の UI 反映 | `uiUtils.applyTtsSettingsToUI()`（`applySettingsToUI()` から呼ぶ） |
| 設定の保存 | `saveSettings()` 内の `newSettings.tts*` |
| 要素参照 | `const elements` の `tts*` |
| 入力欄付近のボタン | `<button id="tts-mode-toggle-btn">`。`mode-auto` = 赤地、`mode-manual` = グレー地（挿絵生成と同じ CSS クラスを再利用） |
| 応答ごとのボタン | `appendMessage` の actions 生成部。`.js-tts-btn` |
| クリック処理 | `messageContainer` の委譲内、`js-tts-btn` → `appLogic.speakMessage(index)` |
| 自動読み上げ | `handleSend` 成功後、挿絵の自動生成の直後 |

APIキーは `ttsApiKey` として IndexedDB の `settings` にだけ保存する。既定は空文字で、リポジトリにもファイル書き出しにも出さない。

## 3. 本文から読み上げ断片を作る順

`message.content` を使う。挿絵プロンプトは `message.illustration.prompt` にあり、そもそも本文に含まれない。

`cleanForSpeech()`:

1. 全角・半角の吸収（`（）`→`()`、`：`→`:`、`“”`→`"`、全角スペース→半角）。**以降は常に半角形**なので、ユーザの正規表現も半角形で書く
2. 正規表現フィルタ（1 本）。不正なパターンは警告して無視し、読み上げ自体は落とさない
3. コードブロック（``` / ~~~）とインラインコード
4. URL（`http(s)://` と `www.`）
5. Markdown の装飾（画像、リンクはラベルだけ残す、HTMLタグ、見出し、引用、区切り線、箇条書き、`***`/`**`/`__`/`_`/`~~`/`*`、表の `|`）
6. 空白を詰める（行構造は話者検出に使うので残す）

## 4. 話者検出

正規化した行を左から走査し、`isSpeakerBoundary()` が真の位置で名前を**最長順**に完全一致で試す。

- 境界 = 行頭、改行後、`。！？!?…〜` や開き括弧・引用符の直後
- 名前の直後に CJK / 英数字が続く場合は部分一致とみなして使わない（`まゆみみ` で `まゆみ` を拾わない）

名前の直後を `matchSpeakerTail()` で消費する。心理描写 `(...)` と セリフ `「」『』""` を**続く限り**まとめて話者本人のボイスにする。これで 1〜3 番の形と、`まゆみ（笑）「あ」（泣）「い」` のような連続を同時に扱える。何も消費できなければ `:` / `：` + 行の残りを 4 番として扱う。それも無ければ名前は地の文の一部。

残った区間は `splitGeneric()` で、引用・括弧は汎用ボイス、その他は地の文に分ける。

「地の文を読まずセリフだけ読み上げる」は `narration` の断片だけをキューから落とす。心理描写は残す。

ボイスが未設定の断片は読まない（デフォルトボイス未設定なら地の文だけ落ちる）。

## 5. 再生キュー

`ttsUtils.queue` と `playing` フラグで直列化する。`pump()` は `playing` の間に再入しない。合成 → 再生 → `ended`/`error` → 次、の順で進むので再生が重ならない。

`stopAll()` は `generation` を増やして実行中の合成結果を捨て、キューを空にし、現在の音声を stop して objectURL を revoke する。`generation` を見ていないと、停止後に届いた音が後から鳴ってしまう。

## 6. テスト

```
node tools/tts-selftest.js   # 話者検出・整形・chunk をブラウザなしで（41 件）
node tools/selftest.js       # 挿絵生成（96 件）
node tools/e2e.js            # 実ブラウザ + モックサーバー（98 件）
```

`tools/e2e.js` には OpenAI Compatible な `audio/speech` もどきを `/mock-tts/v1/audio/speech` に立ててある。送られた body のキー集合、`Authorization`、話者ごとの `voice`、`input` の中身をサーバー側で記録して検証する。再生の重複は `window.Audio` を包んで同時再生数を数え、最大 1 であることを確認している。Chrome には `--autoplay-policy=no-user-gesture-required --mute-audio` を渡す。

