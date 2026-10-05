// index.html を直接開いたとき（file://）の起動案内を、実際のブラウザで確認するスクリプト。
// 実行: node tools/local-launch.js   （Chrome が必要。file:// 側で約15秒かかります）
//
// 確認していること:
//   file:// … 案内モーダルが開き、旧実装の alert 3回 → リロード無限ループに落ちていない
//   http:// … 案内は出ず、marked.js が読めてアプリが通常どおり初期化される
'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const os = require('os');
const { pathToFileURL } = require('url');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

const CHROME_CANDIDATES = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
].filter(Boolean);
const chromePath = CHROME_CANDIDATES.find(p => fs.existsSync(p));

const MIME = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
};

// index.html 以下を素直に返すだけのサーバー（http:// 側の確認用）
function createServer(port) {
    return http.createServer((req, res) => {
        const relative = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\//, '') || 'index.html';
        const fullPath = path.resolve(ROOT, relative);
        if (!fullPath.startsWith(ROOT) || !fs.existsSync(fullPath)) {
            res.statusCode = 404;
            res.end('not found');
            return;
        }
        res.setHeader('Content-Type', MIME[path.extname(fullPath)] || 'application/octet-stream');
        fs.createReadStream(fullPath).pipe(res);
    });
}

async function connectDebugger(debugPort) {
    for (let attempt = 0; attempt < 40; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 250));
        try {
            const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json();
            const page = targets.find(t => t.type === 'page');
            if (!page) continue;
            const ws = new WebSocket(page.webSocketDebuggerUrl);
            await new Promise((resolve, reject) => {
                ws.onopen = resolve;
                ws.onerror = () => reject(new Error('WebSocket 接続失敗'));
            });
            return ws;
        } catch (e) { /* まだ起動前 */ }
    }
    throw new Error('Chrome のデバッガーに接続できませんでした');
}

// 一つのモード（file / http）について、新しいブラウザで確認する
async function checkMode(mode, results) {
    const port = mode === 'file' ? 8125 : 8124;
    const debugPort = mode === 'file' ? 9345 : 9344;
    const server = mode === 'http' ? createServer(port) : null;
    if (server) await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));

    const profileDir = path.join(os.tmpdir(), 'onasapo-local-launch-' + mode);
    fs.rmSync(profileDir, { recursive: true, force: true });

    const chrome = spawn(chromePath, [
        '--headless=new',
        `--remote-debugging-port=${debugPort}`,
        '--disable-gpu',
        '--no-sandbox',
        '--user-data-dir=' + profileDir,
        'about:blank',
    ], { stdio: 'ignore' });

    const check = (name, ok, detail) => {
        results.push({ mode, name, ok });
        console.log(`${ok ? 'OK  ' : 'NG  '} [${mode}] ${name}${detail ? '  — ' + detail : ''}`);
    };

    try {
        const ws = await connectDebugger(debugPort);
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
        const evaluate = async (expression) => {
            const response = await send('Runtime.evaluate', {
                expression, awaitPromise: true, returnByValue: true,
            });
            const evaluation = response.result || {};
            if (evaluation.exceptionDetails) {
                throw new Error('ページ内で例外: ' + JSON.stringify(
                    (evaluation.exceptionDetails.exception && evaluation.exceptionDetails.exception.description)
                    || evaluation.exceptionDetails.text));
            }
            return evaluation.result && evaluation.result.value;
        };

        await send('Runtime.enable');
        await send('Page.enable');

        // Page.navigate の完了を待たずに evaluate すると about:blank を見てしまうため、
        // 目的のオリジンに付くまで待つ
        const url = mode === 'file'
            ? pathToFileURL(path.join(ROOT, 'index.html')).href
            : `http://127.0.0.1:${port}/index.html`;
        await send('Page.navigate', { url });

        let loaded = false;
        for (let attempt = 0; attempt < 60 && !loaded; attempt++) {
            try {
                const href = await evaluate('location.href');
                loaded = typeof href === 'string' && href.startsWith(mode + '://');
            } catch (e) { /* コンテキスト切替中は失敗することがある */ }
            if (!loaded) await new Promise(resolve => setTimeout(resolve, 300));
        }
        if (!loaded) throw new Error(`${url} へ遷移できませんでした`);
        await new Promise(resolve => setTimeout(resolve, 2500));

        const state = await evaluate(`(() => {
            const dialog = document.getElementById('localLaunchDialog');
            return {
                exists: !!dialog,
                open: !!(dialog && dialog.open),
                text: dialog ? dialog.textContent.replace(/\\s+/g, ' ').trim() : '',
                markedLoaded: typeof marked !== 'undefined',
                title: document.title,
            };
        })()`);

        if (mode === 'file') {
            check('案内モーダルが表示される', state.exists && state.open);
            check('案内に __winlocal.bat の手順がある', /__winlocal\.bat/.test(state.text));
            // 旧実装なら 10 秒後にウォッチドッグが発火し、alert → リロードでこのマーカーは消える
            await evaluate('window.__stillSamePage = 1; 1');
            await new Promise(resolve => setTimeout(resolve, 13000));
            check('リロードループに入っていない', await evaluate('window.__stillSamePage === 1') === true);
            check('案内が消えたまま放置されていない', await evaluate('!!(document.getElementById("localLaunchDialog") || {}).open') === true);
        } else {
            check('案内モーダルは表示されない', state.exists && state.open === false, 'open=' + state.open);
            check('marked.js が読めている', state.markedLoaded === true);
            check('アプリが初期化されている', /Onasapo-chan/.test(state.title), 'title=' + state.title);
        }
    } finally {
        chrome.kill();
        if (server) server.close();
    }
}

async function main() {
    if (!chromePath) throw new Error('Chrome が見つかりません。CHROME_PATH を設定してください。');
    const results = [];
    await checkMode('file', results);
    await checkMode('http', results);
    const failed = results.filter(r => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} 確認`);
    process.exit(failed.length ? 1 : 0);
}

main().catch(error => { console.error(error); process.exit(2); });
