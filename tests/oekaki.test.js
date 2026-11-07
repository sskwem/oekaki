'use strict';
/*
 * oekaki (index.html) 自動検証スクリプト
 *
 * 実行方法:  node tests/oekaki.test.js   （事前に npm install が必要）
 *
 * - iPad Pro 11" 相当 (1194x834, dpr=2, hasTouch) の Chromium で index.html を開く
 * - マルチタッチは CDP の Input.dispatchTouchEvent で再現
 * - 描画結果は page.evaluate 内の ctx.getImageData で特定座標のピクセル色を読んで検証
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const ART = path.join(__dirname, 'artifacts');

const PAPER = [255, 249, 240]; // #FFF9F0
const RED = [232, 65, 58];     // #E8413A (初期色)
const BLUE = [46, 147, 217];   // #2E93D9
const GREEN = [76, 175, 80];   // #4CAF50

const results = [];
function report(no, name, pass, detail) {
  results.push({ no, name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  [${no}] ${name}${detail ? '\n      ' + detail : ''}`);
}
const near = (a, b, tol = 8) => !!a && !!b && [0, 1, 2].every(i => Math.abs(a[i] - b[i]) <= tol);
const fmt = c => (c ? `rgb(${c.join(',')})` : 'null');

function serve() {
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      // HTMLにfavicon定義がないためブラウザが自動要求する /favicon.ico には204を返す
      // （404だとコンソールエラーになり検証ノイズになる。アプリ自体のバグではない）
      if (req.url === '/favicon.ico') { res.writeHead(204); res.end(); return; }
      const file = path.join(ROOT, req.url === '/' ? 'index.html' : req.url);
      fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(data);
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

/*
 * CDP の touchEnd が「残っている点を渡す(diff)」方式か「離した点を渡す」方式かは
 * Chromium のバージョンで解釈が紛らわしいため、実際に挙動を測定して合わせる。
 */
async function detectEndSemantics(context) {
  const p = await context.newPage();
  await p.setContent('<div style="width:100vw;height:100vh"></div>');
  await p.evaluate(() => {
    window.__ends = [];
    window.addEventListener('touchend', e => {
      for (const t of e.changedTouches) window.__ends.push(Math.round(t.clientX));
    }, { passive: false });
  });
  const cdp = await context.newCDPSession(p);
  const pt = (id, x) => ({ x, y: 100, id, force: 0.5, radiusX: 5, radiusY: 5 });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [pt(1, 100)] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [pt(1, 100), pt(2, 200)] });
  // 「残す点(id=1)」だけを渡して touchEnd → どちらが離れたかで方式を判定
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [pt(1, 100)] });
  const ends = await p.evaluate(() => window.__ends.slice());
  let mode = 'unknown';
  if (ends.includes(200) && !ends.includes(100)) mode = 'remaining'; // diff方式
  else if (ends.includes(100) && !ends.includes(200)) mode = 'released';
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await p.close();
  return mode;
}

function makeTouch(cdp, endMode) {
  const pts = new Map();
  const toPoint = (id, p) => ({ x: p.x, y: p.y, id, force: 0.5, radiusX: 5, radiusY: 5 });
  const all = () => [...pts.entries()].map(([id, p]) => toPoint(id, p));
  const send = (type, touchPoints) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints });
  return {
    async start(id, x, y) { pts.set(id, { x, y }); await send('touchStart', all()); },
    async startMany(list) { for (const [id, x, y] of list) pts.set(id, { x, y }); await send('touchStart', all()); },
    async move(id, x, y) { pts.set(id, { x, y }); await send('touchMove', all()); },
    async moveMany(list) { for (const [id, x, y] of list) pts.set(id, { x, y }); await send('touchMove', all()); },
    async end(id) {
      const p = pts.get(id);
      pts.delete(id);
      if (endMode === 'released') await send('touchEnd', [toPoint(id, p)]);
      else await send('touchEnd', all()); // remaining(diff)方式
    },
    async endAll() { const ids = [...pts.keys()]; for (const id of ids) await this.end(id); },
    // CDP の touchCancel は touchPoints を空にしないとエラーになる
    async cancel() { pts.clear(); await send('touchCancel', []); },
  };
}

(async () => {
  fs.mkdirSync(ART, { recursive: true });
  const server = await serve();
  const url = `http://127.0.0.1:${server.address().port}/`;

  // このリモート環境にはChromiumが /opt/pw-browsers にプリインストールされている。
  // Playwright同梱バージョンと違ってもそのまま使えるよう executablePath で指定する。
  const preinstalled = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch(
    fs.existsSync(preinstalled) ? { executablePath: preinstalled } : {}
  );
  const context = await browser.newContext({
    viewport: { width: 1194, height: 834 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    userAgent:
      'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  });
  console.log(`# Chromium ${browser.version()}`);

  const endMode = await detectEndSemantics(context);
  console.log(`# CDP touchEnd semantics: ${endMode}`);

  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', e => consoleErrors.push(String(e)));

  await page.goto(url, { waitUntil: 'load' });
  await page.waitForTimeout(150);
  const dpr = await page.evaluate(() => window.devicePixelRatio);
  console.log(`# devicePixelRatio = ${dpr}`);

  const cdp = await context.newCDPSession(page);
  const touch = makeTouch(cdp, endMode);
  const wait = ms => page.waitForTimeout(ms);

  const px = (x, y) => page.evaluate(([x, y]) => {
    const ctx = document.getElementById('canvas').getContext('2d');
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const d = ctx.getImageData(Math.round(x * dpr), Math.round(y * dpr), 1, 1).data;
    return [d[0], d[1], d[2]];
  }, [x, y]);

  async function drawLine(id, x1, y1, x2, y2, steps = 8) {
    await touch.start(id, x1, y1);
    for (let i = 1; i <= steps; i++) {
      await touch.move(id, x1 + ((x2 - x1) * i) / steps, y1 + ((y2 - y1) * i) / steps);
    }
    await touch.end(id);
  }

  const swatchIndexByColor = rgb => page.$$eval(
    '.swatch',
    (els, rgb) => els.findIndex(e => e.style.background.replace(/\s/g, '') === rgb),
    rgb
  );
  async function swatchCenter(index) {
    return page.evaluate(i => {
      const r = document.querySelectorAll('.swatch')[i].getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }, index);
  }
  async function tapSwatch(index) {
    const c = await swatchCenter(index);
    await touch.start(90, c.x, c.y);
    await wait(30);
    await touch.end(90);
  }
  const selectedFlags = () => page.$$eval('.swatch', els => els.map(e => e.classList.contains('selected')));

  /* ---------- [1] 初期化 ---------- */
  try {
    const spots = [[10, 10], [1184, 10], [10, 824], [597, 417], [1100, 700]];
    const cols = [];
    for (const [x, y] of spots) cols.push(await px(x, y));
    const allPaper = cols.every(c => near(c, PAPER, 3));
    report(1, '初期化: コンソールエラー0・全面が紙色 #FFF9F0', consoleErrors.length === 0 && allPaper,
      `errors=${consoleErrors.length}${consoleErrors.length ? ' ' + JSON.stringify(consoleErrors) : ''} pixels=${cols.map(fmt).join(' ')}`);
  } catch (e) { report(1, '初期化', false, String(e)); }

  /* ---------- [2] 単一タッチ描画 ---------- */
  try {
    await touch.start(1, 300, 300);
    await wait(30);
    await touch.end(1);
    const c = await px(300, 300);
    report(2, '単一タッチ: タップで初期色 #E8413A の点が残る', near(c, RED), `pixel(300,300)=${fmt(c)}`);
  } catch (e) { report(2, '単一タッチ描画', false, String(e)); }

  /* ---------- [3] マルチタッチ同時描画 + ピンチ抑止 ---------- */
  try {
    const fingers = [
      { id: 1, x: 150, y: 150, dx: 18, dy: 18 },
      { id: 2, x: 700, y: 200, dx: -20, dy: 15 },
      { id: 3, x: 950, y: 550, dx: -15, dy: -15 },
    ];
    await touch.startMany(fingers.map(f => [f.id, f.x, f.y]));
    const samples = { 1: [], 2: [], 3: [] };
    for (let i = 1; i <= 10; i++) {
      await touch.moveMany(fingers.map(f => [f.id, f.x + f.dx * i, f.y + f.dy * i]));
      if (i === 3 || i === 6 || i === 9) fingers.forEach(f => samples[f.id].push([f.x + f.dx * i, f.y + f.dy * i]));
    }
    await touch.endAll();
    let linesOk = true;
    const bad = [];
    for (const id of [1, 2, 3]) {
      for (const [x, y] of samples[id]) {
        const c = await px(x, y);
        if (!near(c, RED)) { linesOk = false; bad.push(`指${id}@(${x},${y})=${fmt(c)}`); }
      }
    }
    // ピンチ相当（2点が近づく）でもズーム・スクロールせず線が描けること
    await touch.startMany([[4, 500, 400], [5, 700, 400]]);
    for (let i = 1; i <= 10; i++) await touch.moveMany([[4, 500 + 9 * i, 400], [5, 700 - 9 * i, 400]]);
    await touch.endAll();
    const vp = await page.evaluate(() => ({
      scale: window.visualViewport ? window.visualViewport.scale : 1,
      w: window.innerWidth, sx: window.scrollX, sy: window.scrollY,
    }));
    const cA = await px(545, 400);
    const cB = await px(655, 400);
    const pinchOk = near(cA, RED) && near(cB, RED) && vp.scale === 1 && vp.w === 1194 && vp.sx === 0 && vp.sy === 0;
    await page.screenshot({ path: path.join(ART, '03-multitouch.png') });
    report(3, 'マルチタッチ: 3本指の独立した線 + ピンチでもズームせず描画', linesOk && pinchOk,
      `3本線=${linesOk ? 'OK' : bad.join(' ')} pinch線=${fmt(cA)},${fmt(cB)} scale=${vp.scale} innerWidth=${vp.w} scroll=(${vp.sx},${vp.sy})`);
  } catch (e) { report(3, 'マルチタッチ同時描画', false, String(e)); }

  /* ---------- [4] 色の切り替え ---------- */
  try {
    const blueIdx = await swatchIndexByColor('rgb(46,147,217)');
    await tapSwatch(blueIdx);
    const sel = await selectedFlags();
    const selOk = sel[blueIdx] === true && sel.filter(Boolean).length === 1;
    await drawLine(1, 400, 600, 520, 600);
    const c = await px(460, 600);
    report(4, '色切り替え: 青スワッチ選択(selectedが1つだけ付く)→青線', selOk && near(c, BLUE),
      `blueIdx=${blueIdx} selected=${JSON.stringify(sel)} pixel(460,600)=${fmt(c)}`);
  } catch (e) { report(4, '色の切り替え', false, String(e)); }

  /* ---------- [5] ストローク中の色固定 ---------- */
  try {
    // 指A: 青で描き始める
    await touch.start(1, 300, 500);
    for (let x = 310; x <= 350; x += 10) await touch.move(1, x, 500);
    // 指B: 描画途中に赤スワッチをタッチ
    const redIdx = await swatchIndexByColor('rgb(232,65,58)');
    const c0 = await swatchCenter(redIdx);
    await touch.start(2, c0.x, c0.y);
    await wait(30);
    if (endMode !== 'unknown') await touch.end(2); // 指Bを途中で離す（部分リリース）
    // 指Aは続けて描く
    for (let x = 360; x <= 450; x += 10) await touch.move(1, x, 500);
    await touch.endAll();
    const pre = await px(320, 500);
    const post = await px(430, 500);
    // 新しいストロークは赤になるはず
    await touch.start(3, 600, 700);
    await wait(30);
    await touch.end(3);
    const fresh = await px(600, 700);
    report(5, 'ストローク中の色固定: 指Aの線は青のまま・新規タップは赤',
      near(pre, BLUE) && near(post, BLUE) && near(fresh, RED),
      `切替前セグメント=${fmt(pre)} 切替後セグメント=${fmt(post)} 新規タップ=${fmt(fresh)}`);
  } catch (e) { report(5, 'ストローク中の色固定', false, String(e)); }

  /* ---------- [6] 消しゴム ---------- */
  try {
    // 赤いベタ塗りブロック (x300-500, y約601-694) を描く
    for (const y of [610, 625, 640, 655, 670, 685]) await drawLine(1, 300, y, 500, y);
    const before = await px(400, 650);
    const eraserIdx = await page.$$eval('.swatch', els => els.findIndex(e => e.classList.contains('eraser')));
    await tapSwatch(eraserIdx);
    await drawLine(1, 300, 650, 500, 650); // y=650 に沿って消す（太さ46 → 半径23 → 627-673が消える）
    const cCenter = await px(400, 650);
    const cIn1 = await px(400, 632);  // 中心から18px: 46px幅なら消えている
    const cIn2 = await px(400, 668);
    const cOut1 = await px(400, 620); // 中心から30px: 46px幅なら残っている
    const cOut2 = await px(400, 680);
    const pass = near(before, RED) && near(cCenter, PAPER, 3) && near(cIn1, PAPER, 3) && near(cIn2, PAPER, 3)
      && near(cOut1, RED) && near(cOut2, RED);
    await page.screenshot({ path: path.join(ART, '06-eraser.png') });
    report(6, '消しゴム: なぞった帯(±18px)は紙色に戻り、±30pxは残る(太さ46px)', pass,
      `消去前=${fmt(before)} 中心=${fmt(cCenter)} ±18px=${fmt(cIn1)},${fmt(cIn2)} ±30px=${fmt(cOut1)},${fmt(cOut2)}`);
  } catch (e) { report(6, '消しゴム', false, String(e)); }

  /* ---------- [7] 全消し（長押し） ---------- */
  try {
    const cb = await page.evaluate(() => {
      const r = document.getElementById('clearBtn').getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    // 550msで離す → 消えないこと
    await touch.start(9, cb.x, cb.y);
    await wait(550);
    await touch.end(9);
    await wait(100);
    const after550 = await px(430, 500); // [5]で描いた青い線
    const notCleared = near(after550, BLUE);
    // 1250ms押し続ける → 全面が紙色に戻ること
    await touch.start(9, cb.x, cb.y);
    await wait(1250);
    await touch.end(9);
    await wait(250);
    let allPaper = true;
    const bad = [];
    for (const x of [100, 400, 700, 1000]) {
      for (const y of [100, 300, 500, 700]) {
        const c = await px(x, y);
        if (!near(c, PAPER, 3)) { allPaper = false; bad.push(`(${x},${y})=${fmt(c)}`); }
      }
    }
    report(7, '全消し: 550msでは消えず、1250ms長押しで全面クリア', notCleared && allPaper,
      `550ms後(430,500)=${fmt(after550)}(青のまま) 長押し後=${allPaper ? '全点が紙色' : bad.join(' ')}`);
  } catch (e) { report(7, '全消し（長押し）', false, String(e)); }

  /* ---------- [8] リサイズ耐性 ---------- */
  try {
    const greenIdx = await swatchIndexByColor('rgb(76,175,80)');
    await tapSwatch(greenIdx);
    await drawLine(1, 200, 200, 400, 400, 10);
    const mid = await px(300, 300);
    await page.setViewportSize({ width: 834, height: 1194 }); // 縦横回転相当
    await wait(450); // resize + orientationchange(300ms遅延)の両方を待つ
    // resize()は旧内容を新サイズに拡縮コピーするので、座標もスケールされる
    const sx = (300 * 834) / 1194;
    const sy = (300 * 1194) / 834;
    const c = await px(sx, sy);
    await page.screenshot({ path: path.join(ART, '08-after-resize.png') });
    report(8, 'リサイズ耐性: 834x1194へ変更後も描画内容が保持される', near(mid, GREEN) && near(c, GREEN, 20),
      `回転前(300,300)=${fmt(mid)} 回転後スケール座標(${sx.toFixed(1)},${sy.toFixed(1)})=${fmt(c)} ※内容は新サイズに拡縮されて保持`);
  } catch (e) { report(8, 'リサイズ耐性', false, String(e)); }

  /* ---------- [9] ジェスチャ抑止の静的確認 ---------- */
  try {
    const s = await page.evaluate(() => {
      const meta = document.querySelector('meta[name="viewport"]');
      const apple = document.querySelector('meta[name="apple-mobile-web-app-capable"]');
      return {
        canvasTouchAction: getComputedStyle(document.getElementById('canvas')).touchAction,
        trayTouchAction: getComputedStyle(document.getElementById('tray')).touchAction,
        htmlOverscroll: getComputedStyle(document.documentElement).overscrollBehavior,
        bodyOverscroll: getComputedStyle(document.body).overscrollBehavior,
        viewportMeta: meta ? meta.content : null,
        appleCapable: apple ? apple.content : null,
      };
    });
    const pass = s.canvasTouchAction === 'none' && s.trayTouchAction === 'none'
      && s.htmlOverscroll.includes('none') && s.bodyOverscroll.includes('none')
      && /user-scalable\s*=\s*no/.test(s.viewportMeta || '') && /maximum-scale\s*=\s*1/.test(s.viewportMeta || '')
      && s.appleCapable === 'yes';
    report(9, '静的確認: touch-action/overscroll-behavior/viewport meta/apple meta', pass, JSON.stringify(s));
  } catch (e) { report(9, 'ジェスチャ抑止の静的確認', false, String(e)); }

  /* ---------- [10] パレットの操作性 ---------- */
  try {
    const yellowIdx = await swatchIndexByColor('rgb(247,207,60)');
    const c = await swatchCenter(yellowIdx);
    const before = await px(c.x, c.y);
    await tapSwatch(yellowIdx);
    await wait(50);
    const after = await px(c.x, c.y);
    const sel = await selectedFlags();
    const pass = near(before, PAPER, 3) && near(after, PAPER, 3) && sel[yellowIdx] === true;
    report(10, 'パレット操作: スワッチのタッチで下のキャンバスに描画されない', pass,
      `タップ前=${fmt(before)} タップ後=${fmt(after)}(紙色のまま) 選択反映=${sel[yellowIdx]}`);
  } catch (e) { report(10, 'パレットの操作性', false, String(e)); }

  /* ---------- 全消しテスト共通: 赤いマーカー線を引き、消えたかどうかで判定 ---------- */
  const clearCenter = () => page.evaluate(() => {
    const r = document.getElementById('clearBtn').getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  const ringOffset = () => page.evaluate(() =>
    parseFloat(document.querySelector('#clearBtn .ring circle').style.strokeDashoffset));
  async function drawMarker() {
    await tapSwatch(await swatchIndexByColor('rgb(232,65,58)'));
    await drawLine(1, 200, 300, 500, 300);
    const c = await px(350, 300);
    if (!near(c, RED)) throw new Error(`マーカーが描けていない: ${fmt(c)}`);
  }
  const markerCleared = async () => near(await px(350, 300), PAPER, 3);
  // 失敗したテストで指やマウスボタンが押されたまま残り、後続のテストに影響しないようにする
  async function releaseAll() {
    await touch.endAll().catch(() => {});
    for (const button of ['left', 'right']) await page.mouse.up({ button }).catch(() => {});
    await wait(50);
  }

  /* ---------- [11] 全消し: 「1本の指が1秒押し続けたときだけ」消える（多指で安全装置を迂回できない） ---------- */
  try {
    const cb = await clearCenter();
    const A = [21, cb.x - 6, cb.y];
    const B = [22, cb.x + 6, cb.y];
    // 消えてはいけないシナリオ
    const scenarios = {
      // A を押したまま B が触れて離れる → 即消去されない。A を離した後も残ったループで消えない
      '片方だけ離す': async () => {
        await touch.start(...A); await wait(100);
        await touch.start(...B); await wait(100);
        await touch.end(22); await wait(100);
        if (await markerCleared()) return 'B を離した直後に消去';
        await touch.end(21);
      },
      // 長押し中に触れた B は引き継がない: A が離れたら B が押し続けても消えない
      '後から触れた指だけが残る': async () => {
        await touch.start(...A); await wait(100);
        await touch.start(...B); await wait(100);
        await touch.end(21);
        await wait(1150);
        if (await markerCleared()) return 'B だけで消去';
        await touch.end(22);
      },
      '両方離す': async () => {
        await touch.start(...A); await wait(100);
        await touch.start(...B); await wait(100);
        await touch.end(21); await touch.end(22);
      },
      // 常にどちらかの指が触れているが、どの指も1秒は押していない
      '交互タップ': async () => {
        await touch.start(...A); await wait(60);
        for (let i = 0; i < 4; i++) {
          await touch.start(...B); await wait(60);
          await touch.end(21); await wait(60);
          await touch.start(...A); await wait(60);
          await touch.end(22); await wait(60);
        }
        await touch.end(21);
      },
      'touchcancel': async () => {
        await touch.start(...A); await wait(100);
        await touch.start(...B); await wait(100);
        await touch.cancel();
      },
      // 別要素（キャンバス）の指が同じ touchstart の changedTouches に入るブラウザへの備え。
      // Chromium の実入力では touchstart が1点ずつ配られて再現しないため、合成イベントで送る
      '別要素の指が混ざった touchstart(合成)': async () => {
        await page.evaluate(([x, y]) => {
          const btn = document.getElementById('clearBtn');
          const cv = document.getElementById('canvas');
          const tc = new Touch({ identifier: 500, target: cv, clientX: 300, clientY: 300 });
          const tb = new Touch({ identifier: 501, target: btn, clientX: x, clientY: y });
          btn.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, cancelable: true,
            touches: [tc, tb], targetTouches: [tb], changedTouches: [tc, tb] }));
          setTimeout(() => btn.dispatchEvent(new TouchEvent('touchend', { bubbles: true, cancelable: true,
            touches: [tc], targetTouches: [], changedTouches: [tb] })), 80);
        }, [cb.x, cb.y]);
        await wait(100);
      },
    };
    // 消えるべきシナリオ: 最初の指は、他の指に邪魔されず押し始めから約1秒で消去に到達する
    const positives = {
      // B を離しても A の長押しは取り消されない（他の指の touchend を無視する）
      'B を離しても A で消える': async () => {
        await touch.start(...A); await wait(100);
        await touch.start(...B); await wait(100);
        await touch.end(22); await wait(1050);
      },
      // B が後から触れても A の長押しをやり直さない（やり直すと A の押し始めから1.6秒まで消えない）
      'B が後から触れてもやり直さない': async () => {
        await touch.start(...A); await wait(600);
        await touch.start(...B); await wait(550);
      },
      // B がボタンの外へ滑っても A の長押しは続く
      'B が外へ滑っても A で消える': async () => {
        await touch.start(...A); await wait(100);
        await touch.start(...B);
        for (let i = 1; i <= 5; i++) { await touch.move(22, cb.x + 6, cb.y - 80 * i); }
        await wait(1050);
      },
      '2本指で押し続ける': async () => {
        await touch.start(...A); await wait(100);
        await touch.start(...B); await wait(1150);
      },
    };
    await drawMarker();
    const bad = [];
    for (const [name, run] of Object.entries(scenarios)) {
      await releaseAll();
      const early = await run();
      await wait(1150); // 孤立した長押しループがあればこの間に消える
      const ring = await ringOffset();
      if (early || await markerCleared() || ring !== 207) {
        bad.push(`${name}: ${early || '消去された'} ring=${ring}`);
        await releaseAll();
        await drawMarker();
      }
    }
    for (const [name, run] of Object.entries(positives)) {
      await releaseAll();
      await run();
      if (!await markerCleared()) bad.push(`${name}: 消えない`);
      await releaseAll();
      await drawMarker();
    }
    report(11, '全消し(2本指): 片方の解放・後から触れた指・交互タップ・touchcancel・別要素の指で消えず、最初の指が押し続ければ消える',
      bad.length === 0,
      bad.length ? '失敗シナリオ=' + bad.join(' / ')
        : `消えない${Object.keys(scenarios).length}シナリオ(ring=207) / 消える${Object.keys(positives).length}シナリオ すべて期待どおり`);
  } catch (e) { report(11, '全消し(2本指)', false, String(e)); } finally { await releaseAll(); }

  /* ---------- [12] 全消し: 指がボタンから外れたら取り消す（取り消し判定の余白は16px） ---------- */
  try {
    const cb = await clearCenter();
    const rect = await page.evaluate(() => document.getElementById('clearBtn').getBoundingClientRect().toJSON());
    // 押し始めてから (x, y) まで5ステップで動かし、押し始めから1.25秒後に消えたかを返す
    async function holdAndSlide(id, x, y) {
      await touch.start(id, cb.x, cb.y);
      for (let i = 1; i <= 5; i++) await touch.move(id, cb.x + ((x - cb.x) * i) / 5, cb.y + ((y - cb.y) * i) / 5);
      await wait(1250);
      const cleared = await markerCleared();
      const ring = await ringOffset();
      await touch.end(id);
      return { cleared, ring };
    }
    const cases = [
      // [名前, 移動先x, 移動先y, 消えるべきか]
      ['上へ大きく', cb.x, cb.y - 400, false],
      ['横へ大きく', cb.x - 300, cb.y, false],
      ['左端から24px外(余白の外)', rect.left - 24, cb.y, false],
      ['左端から10px外(余白の内)', rect.left - 10, cb.y, true],
    ];
    const bad = [];
    const got = [];
    for (const [name, x, y, shouldClear] of cases) {
      await drawMarker();
      const r = await holdAndSlide(31, x, y);
      got.push(`${name}=${r.cleared ? '消去' : '消えない'}`);
      if (r.cleared !== shouldClear || (!shouldClear && r.ring !== 207)) bad.push(`${name}: ${r.cleared ? '消去された' : '消えない'} ring=${r.ring}`);
    }
    // 対照: ボタン内の小さな揺れ（±10px）では取り消されない
    await drawMarker();
    await touch.start(32, cb.x, cb.y);
    for (const dx of [8, -10, 6, -4]) { await touch.move(32, cb.x + dx, cb.y + dx / 2); await wait(100); }
    await wait(850);
    const jitter = await markerCleared();
    await touch.end(32);
    if (!jitter) bad.push('±10px揺れ: 消えない');
    got.push(`±10px揺れ=${jitter ? '消去' : '消えない'}`);
    report(12, '全消し(スライドアウト): 上・横へ外れる/余白16pxの外で取り消し、余白内や小さな揺れでは継続',
      bad.length === 0, bad.length ? bad.join(' / ') : got.join(' '));
  } catch (e) { report(12, '全消し(スライドアウト)', false, String(e)); } finally { await releaseAll(); }

  /* ---------- [13] 全消し: マウス操作 ---------- */
  try {
    await drawMarker();
    const cb = await clearCenter();
    // 左を押したまま外へ移動 → 消えない
    await page.mouse.move(cb.x, cb.y);
    await page.mouse.down();
    await page.mouse.move(cb.x, cb.y - 400, { steps: 5 });
    await wait(1250);
    const slidOut = await markerCleared();
    await page.mouse.up();
    // 左を押したまま右クリック → 即消去されない（旧実装は二重ループで即消去）
    await page.mouse.move(cb.x, cb.y);
    await page.mouse.down();
    await wait(100);
    await page.mouse.down({ button: 'right' });
    await wait(100);
    await page.mouse.up({ button: 'right' });
    await wait(100);
    const rightEarly = await markerCleared();
    await page.mouse.up();
    await wait(1100);
    const rightLate = await markerCleared();
    // 右ボタンだけの長押し → 消えない（左ボタンのみが対象）
    await page.mouse.down({ button: 'right' });
    await wait(1250);
    const rightOnly = await markerCleared();
    await page.mouse.up({ button: 'right' });
    // 対照: 左ボタンで1.25秒長押し → 消える
    await page.mouse.move(cb.x, cb.y);
    await page.mouse.down();
    await wait(1250);
    const positive = await markerCleared();
    await page.mouse.up();
    report(13, '全消し(マウス): 外へ移動・右ボタン併用・右ボタンだけでは消えず、左長押しで消える',
      !slidOut && !rightEarly && !rightLate && !rightOnly && positive,
      `外へ移動=${slidOut ? '消去' : '消えない'} 右ボタン併用=${rightEarly || rightLate ? '消去' : '消えない'} 右だけ1.25秒=${rightOnly ? '消去' : '消えない'} 左1.25秒=${positive ? '消去' : '消えない'}`);
  } catch (e) { report(13, '全消し(マウス)', false, String(e)); } finally { await releaseAll(); }

  /* ---------- [14] レイアウト: どの画面サイズ・どの色を選んだ状態でも全ボタンが画面内にあり押せる ---------- */
  try {
    const viewports = [
      [320, 568, 2], [375, 667, 2], [393, 852, 3], [430, 932, 3], [440, 956, 3], // iPhone 縦 / Slide Over
      [568, 320, 2], [667, 375, 2], [852, 393, 3],                                // iPhone 横
      [744, 1133, 2], [820, 1180, 2], [1194, 834, 2], [1024, 1366, 2], [1366, 1024, 2], // iPad
      // ブレークポイント境界（1列が入らなくなる幅 ≈540px、560/740px、高さ500px）
      [500, 800, 2], [535, 800, 2], [560, 900, 2], [561, 744, 2], [741, 900, 2], [1194, 500, 2], [1194, 501, 2],
    ];
    const bad = [];
    const notes = [];
    for (const [w, h, dpr] of viewports) {
      // reducedMotion: 選択時の拡大アニメーションを止め、拡大後の最終状態で測る
      const ctx2 = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dpr, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
      const p2 = await ctx2.newPage();
      await p2.goto(url, { waitUntil: 'load' });
      const r = await p2.evaluate(() => {
        const W = innerWidth, H = innerHeight, issues = new Set();
        const btns = [...document.querySelectorAll('#tray .swatch, #clearBtn')];
        const check = selName => {
          for (const b of btns) {
            const rc = b.getBoundingClientRect(); // transform（選択中の拡大）込み
            const name = b.getAttribute('aria-label');
            if (rc.left < 0 || rc.top < 0 || rc.right > W || rc.bottom > H) issues.add(`${name}が画面外(${Math.round(rc.left)},${Math.round(rc.right)}) 選択=${selName}`);
            const hit = document.elementFromPoint(rc.left + rc.width / 2, rc.top + rc.height / 2);
            if (!hit || !b.contains(hit)) issues.add(`${name}の中心に当たらない 選択=${selName}`);
            if (b.offsetWidth < 44) issues.add(`${name}が${b.offsetWidth}px(<44)`);
          }
        };
        // 各スワッチを順に選んで（拡大状態を変えて）確認
        for (const s of document.querySelectorAll('#tray .swatch')) {
          s.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
          check(s.getAttribute('aria-label'));
        }
        const t = document.getElementById('tray').getBoundingClientRect();
        if (t.height > H * 0.25) issues.add(`トレイ高さ${Math.round(t.height)}px>25%`);
        return { issues: [...issues], btn: btns[0].offsetWidth, trayH: Math.round(t.height) };
      });
      if (r.issues.length) bad.push(`${w}x${h}: ${r.issues.join(', ')}`);
      notes.push(`${w}x${h}=${r.btn}px/h${r.trayH}`);
      await ctx2.close();
    }
    report(14, `レイアウト: ${viewports.length}サイズ×全スワッチ選択状態で全ボタンが画面内・押せる・44px以上・トレイ高さ25%以下`,
      bad.length === 0, bad.length ? bad.join(' / ') : notes.join(' '));
  } catch (e) { report(14, 'レイアウト', false, String(e)); }

  /* ---------- まとめ ---------- */
  const lateErrors = consoleErrors.length;
  console.log(`\n# テスト中の累計コンソールエラー/ページエラー: ${lateErrors}`);
  if (lateErrors) console.log(consoleErrors.map(e => '  - ' + e).join('\n'));
  const fails = results.filter(r => !r.pass);
  console.log(`\n==== 結果: ${results.length - fails.length}/${results.length} Pass ====`);
  process.exitCode = fails.length || lateErrors ? 1 : 0;

  await browser.close();
  server.close();
})().catch(e => { console.error(e); process.exit(1); });
