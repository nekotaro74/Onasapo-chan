# 挿絵生成（SillyTavern "Last message" 模倣）実装メモ

調査時点: 2026-10-03。上流 geminipwa commit `85413a9` を基点。

## 1. 本リポジトリ（geminipwa 系 PWA）の構造

クライアント完結の単一ファイル PWA。`index.html` 内に HTML と JS が全部入っている。

| 項目 | 場所（index.html） |
| --- | --- |
| DB 定数 | `DB_NAME='GeminiPWA_DB'`, `DB_VERSION=8`, `SETTINGS_STORE='settings'`, `CHATS_STORE='chats'` |
| 設定の既定値 | `state.settings = { ... }`（`const state` の中） |
| 設定の読み込み | `dbUtils.loadSettings()` — `for (const key in loadedSettings)` かつ `if (key in defaultSettings)` のキーのみ採用。既定値にキーを追加すれば自動的に保存・復元対象になる |
| 設定の保存 | `appLogic.saveSettings()` が input から `newSettings` を組み立て、`dbUtils.saveSetting(key, value)` をキー単位で put |
| 設定の UI 反映 | `uiUtils.applySettingsToUI()` |
| 要素参照 | `const elements = { ... }`（`document.getElementById` のマップ） |
| 履歴保存 | `dbUtils.saveChat()` — `state.currentMessages` を **ホワイトリスト方式**で map している。メッセージに新フィールドを増やすならここへの追加が必須 |
| メッセージ描画 | `uiUtils.renderChatMessages()` → 1件ずつ `uiUtils.appendMessage(role, content, index, isStreamingPlaceholder, cascadeInfo, attachments)`。`messageDiv` は `elements.messageContainer` 直下。モデルメッセージの actions 生成部（`.js-retry-btn` あたり）が挿絵ブロックを足す位置 |
| 入力欄 | `<footer class="chat-input-area">` 内の `<textarea id="user-input">`。付近の `.footer-action-button` がボタン用の既存クラス |
| 設定画面 | `<details class="settings-group"><summary>…</summary>` の入れ子。新規セクションはこの形に合わせる |

### LLM 呼び出し経路（quiet 生成に使うもの）

`appLogic.handleSend(isRetry, retryUserMessageIndex, sourceSessionContext, isTopLevelCall)`。
`sourceSessionContext` を渡すと `isBackgroundProcess = true` になり、**チャット履歴にも画面にも残さず**
`{ content, metadata }` を return する。校正 `appLogic.proofreadText()` がこの使い方の実例。

```js
const ctx = {
  sessionId: null, messages: [], systemPrompt, inputText, attachments: [],
  apiProvider, _apiKeyOverride, _modelNameOverride, temperature, maxTokens, ...
};
const res = await this.handleSend(false, -1, ctx, false);
```

`messages` に配列を渡すとそれをそのまま文脈として使い、`inputText` を最後のユーザー発話として送る。
API キー・モデル名は呼び出し側で渡す（`state.settings.apiProvider` 等の通常解決も fallback される）。

### 応答完了のタイミング

`handleSend` の `try` 末尾、`if (!isBackgroundProcess) { … twin engine … }` の直後が
ストリーミング・非ストリーミング両経路の共通終点。`catch` に入れば本編が失敗・中断なので、
自動トリガーはここに置く（中断・エラーでは走らない）。

## 2. SillyTavern の Last message の実処理（自分の言葉）

対象は `generationMode.NOW = 4`。UI 上のトリガー語は `last`（`RAW_LAST = 3` は別物）。

1. `getQuietPrompt(NOW, trigger)` は `stringFormat(promptTemplates[NOW], trigger)`。
   NOW のテンプレートには `{0}` が無いので、**トリガー語は本文に挿入されず、テンプレートだけが送られる**。
2. `generatePrompt(quietPrompt)` → `generateQuietPrompt({ quietPrompt })` → `Generate('quiet', …)`。
   つまり **これまでのチャット全文を文脈にしたうえで、最後の発話としてこの指示文を送る**。
   返答はチャットに追加しない（quiet）。`force_name2: true` で応答のみ取り出す。
3. 返文は `processReply()` で整形する: 引用符除去、改行→`, `、NFD 正規化、
   英数と `, . : _ ( ) { } < > [ ] / - ' | #` 以外を空白化、空白圧縮、カンマで分割して trim・再結合。
   reasoning は `removeReasoningFromString` で落とす。
4. 合成は `combinePrefixes(a, b)`（trim → 前後カンマ除去 → `a, b,`）。
   - prefix = `combinePrefixes(sd.prompt_prefix, characterPrefix)`
   - `prefixedPrompt = combinePrefixes(prefix, prompt, '{prompt}')` — prefix 側に `{prompt}` マクロがあればそこへ差し込み、無ければ末尾に `, prompt,` として連結
   - negative = `combinePrefixes(additionalNegative, combinePrefixes(sd.negative_prompt, characterNegativePrefix))`
5. ComfyUI への差し込み（`generateComfyImageCommon`）:
   ```js
   workflow.replaceAll('"%prompt%"', JSON.stringify(prompt));
   workflow.replaceAll('"%negative_prompt%"', JSON.stringify(negativePrompt));
   workflow.replaceAll('"%seed%"', JSON.stringify(seed));
   placeholders.forEach(ph => workflow.replaceAll(`"%${ph}%"`, JSON.stringify(extension_settings.sd[ph])));
   ```
   **`"%xxx%"` のように「JSON 文字列リテラル全体」として一致した場合だけ** `JSON.stringify` で置換する。
   部分一致で本文を壊さないためのこの形を ST は採っている。
   seed は `seed >= 0 ? seed : Math.round(Math.random() * Number.MAX_SAFE_INTEGER)`。
   実際の ST が持つトークンは `prompt / negative_prompt / seed / denoise / clip_skip / model / vae /
   sampler / scheduler / steps / scale / width / height` に加えて `user_avatar / char_avatar`。
   **CFG は `%scale%` という名前**で、`%cfg%` ではない。
   仕様側は `%cfg%` を指定しているので、`%cfg%` を正としつつ既存 ST ワークフローとの互換のため `%scale%` も同じ値で差し込む。
   **clip_skip は ST では負値で送られる**（`-extension_settings.sd.clip_skip`、NaN なら `-1`）。
   ST にテキストエンコーダのトークンは無い（本アプリが `%text_encoder%` を追加している）。
   ST のカスタム プレースホルダは `{find, replace}` の任意文字列 `replaceAll` で、replace 値は `substituteParams` を通る。
6. SillyTavern は ComfyUI を自前サーバー経由（`/api/sd/comfy/generate`）で叩く。
   **本 PWA はサーバーを持たないので、ブラウザから直接 `POST /prompt` → `GET /history/{id}` → `GET /view` を行う**
   （ここが唯一 SillyTavern と形が変わる箇所。仕様通り）。

## 3. 実装で踏む制約

- 別オリジンなので ComfyUI 側は `--enable-cors-header` が必須。接続確認と失敗メッセージに出す。
- `/view` の URL は ComfyUI の一時参照。取得したバイトを data URL で履歴に保存し、保存前に縮小・上限をかける。
- 挿絵の失敗は本編テキストと分離して、そのメッセージ直下にだけ表示する。
- 同時実行は 1 件。`state.illustrationJob` でロックする。
- 設定・ワークフロー・個人 URL をソースにハードコードしない（既定は空、説明文のみ）。

## 4. 実装中に分かった、仕様書に無い挙動

- **Service Worker が接続失敗を 503 に化かせる**。上流 sw.js はキャッシュミス後の fetch が
  失敗すると `Network error occurred.` の 503 を合成して返す。そのため ComfyUI が落ちていても
  ページ側は `TypeError: Failed to fetch` ではなく HTTP 503 を受け、CORS の案内が出せなかった
  （実測で確認）。sw.js でプライベートアドレス（127./10./192.168./172.16-31./100./localhost/.local）
  への要求をキャッシュ戦略から外して常にネットワークへ通し、客户端でも合成応答を検知する。
- **SillyTavern の CFG トークンは `%scale%`**。`%cfg%` は存在しない。指定通り `%cfg%` を正とし、
  既存ワークフローとの互換で `%scale%` にも同じ値を入れる。
- **`processReply` の厳格な整形は日本語を全消しにする**（許容文字が英数字と記号のみ）。
  日本語の応答では必ず空になるため、空になった場合だけ最小限の整形へフォールバックする。
  設定で明示選択もできるようにした。
- **ワークフロー検証は LLM より前**に置く。不正なワークフローでトークンを消費しない。
- 本 PWA はサーバーを持たないので、SillyTavern がサーバー側でやっていた
  `/history` ポーリングと `/view` 取得をブラウザで行う。ここが唯一の構造的な違い。

## 4b. 初版の実不具合と、その再発防止（差し込み方式の改訂）

初版は ST と同じ「生テキストへの `replaceAll('"%token%"', …)`」を踏襲していたが、次の理由で失敗した。
**プレースホルダが未差し込みのまま ComfyUI へ送られ、ComfyUI がエラーを返した。**

- 差し込み対象が `prompt / negative_prompt / seed / width / height / steps / cfg / scale` の 8 個だけで、
  ST が実際に持つ `%model% %vae% %sampler% %scheduler% %denoise% %clip_skip%` とカスタム トークンを一度も置換しなかった。
  検証 UI 自体が「未対応のためそのまま」と表示していた。
- 生テキスト置換なので、`"text": "masterpiece, %prompt%"` のような文中のトークンも残った。

改訂後の方式:

- ワークフローを **パースしてから再帰走査**し、文字列値の中身だけを `substituteInString` で処理する。
  値そのものが `%token%` なら値をそのまま（数値は quotes なしで）返し、文中なら `String(value)` を補間する。
  テキストを継ぎ接ぎして再パースしないため、「差し込み後に JSON が壊れる」というエラー級が構造的に消えた。
- 未対応トークンは `unresolved` に集約し、**2 相で止める**。
  第 1 相 `prepareWorkflow` は LLM を呼ぶ前に走り（トークンを消費しない）、
  `prompt / negative_prompt / user_avatar / char_avatar` 以外で差し込み、残ったものを名指しで中断する。
  第 2 相 `applyPromptTokens` の後、POST 直前に `findUnresolvedTokens` で値そのものが `%token%` のまま残っていないか確認する。
- 検証ボタンと編集画面のトークン検出は、生成経路と同じ `prepareWorkflow` を使う。
  検証と実生成が食い違わない。
- ST との意図的な差異: カスタム プレースホルダは JSON Aware で、ST のような「任意文字列の `replaceAll`」は表現できない
  （find は `%[a-zA-Z_][a-zA-Z0-9_]*%` の形に限る）。文中埋め込みが効く分、ST より寛容になっている。
- 補足: `illustrationUtils` は `tools/selftest.js` が**波括弧を数えて**抜き出す。
  このオブジェクト内に不均衡な波括弧（文字列・正規表現・コメント・テンプレートリテラル内を含む）や
  数量指定 `{1,40}`、`dbUtils` / `uiUtils` / モジュール定数への参照を入れると抜き出し・eval に失敗する。
  副作用のある処理（fetch・DOM・IndexedDB）は `comfyWorkflowUtils` 側へ置いた。

## 5. 検証

- `node tools/selftest.js` — 抜き出した純ロジック（64件）。
  文中埋め込みの置換、`%model%` 等の解決、CLIP Skip の負値、未対応トークンの中断、
  カスタム プレースホルダ、ワークフロー一覧の自己修復まで。
- `node tools/e2e.js` — モック ComfyUI に対して headless Chrome で実際に走らせる（53件）。
  手動生成・自動生成・手動で勝手に走らない・履歴復元・本編保持・CORS 判別・
  不正ワークフロー・連打・SW 登録に加えて、
  **SillyTavern 系トークンが全て差し替わること**、`!/%[a-z_]+%/` で**未差し込みを送っていないこと**、
  未知トークンでは **POST も LLM も走らないこと**、`object_info` からのプルダウン反映と
  ノード types 欠損時の劣化、ワークフロー CRUD、挿絵削除ボタンまで確認する。
