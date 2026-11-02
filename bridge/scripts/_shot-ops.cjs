const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find((p) => fs.existsSync(p));
const PORT = 9335;
const PROFILE = path.join(os.tmpdir(), 'dsh-console-shot-' + Date.now());
const OUT = path.join(os.tmpdir(), 'console-shots');
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn(CHROME, ['--headless=new','--disable-gpu','--disable-extensions','--no-first-run','--remote-debugging-port=' + PORT,'--user-data-dir=' + PROFILE,'about:blank'], { stdio: 'ignore' });

(async () => {
  let target = null;
  for (let i = 0; i < 40 && !target; i++) {
    await sleep(500);
    try {
      const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
      target = (list || []).find((t) => t.type === 'page' && t.webSocketDebuggerUrl) || null;
    } catch {}
  }
  if (!target) throw new Error('no page target');
  console.log('target', target.url);
  const ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false });
  let id = 0; const pending = new Map();
  ws.on('message', (raw) => { const m = JSON.parse(raw.toString()); if (m.id && pending.has(m.id)) { const { resolve, reject } = pending.get(m.id); pending.delete(m.id); m.error ? reject(new Error(m.error.message)) : resolve(m.result); } });
  await new Promise((r) => ws.on('open', r));
  const send = (method, params = {}) => new Promise((resolve, reject) => { const mid = ++id; pending.set(mid, { resolve, reject }); ws.send(JSON.stringify({ id: mid, method, params })); });
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });

  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r?.exceptionDetails) throw new Error(r.exceptionDetails.text + ' :: ' + expr);
    return r?.result?.value;
  };
  async function shot(name) {
    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(data, 'base64'));
    console.log('shot', name);
  }
  async function waitFor(expr) {
    for (let i = 0; i < 80; i++) { if (await evaluate(expr)) return; await sleep(300); }
    throw new Error('timeout: ' + expr);
  }

  await send('Page.navigate', { url: 'http://127.0.0.1:3100/?cb=' + Date.now() + '#operations' });
  await waitFor("document.readyState === 'complete' && !!document.getElementById('opsTabRow')");
  await sleep(1500);
  await evaluate("document.querySelector('#opsTabRow [data-ops-tab=\"ops\"]').click()");
  await sleep(700);
  await shot('ops-tab');
  await evaluate("document.querySelector('#opsTabRow [data-ops-tab=\"monitor\"]').click()");
  await sleep(1000);
  await shot('monitor-tab');
  await evaluate("document.querySelector('#opsTabRow [data-ops-tab=\"log\"]').click()");
  await sleep(1300);
  await shot('log-tab');
  console.log('log state', await evaluate("JSON.stringify({ops:document.querySelector('#section-dev').hidden, mon:document.querySelector('#section-monitor').hidden, log:document.querySelector('#section-logs').hidden, preview:document.getElementById('toolLog').textContent.slice(0,20)})"));

  await evaluate("document.querySelector('[data-view=\"tools\"]').click()");
  await waitFor("document.getElementById('section-tools').hidden === false");
  await sleep(1200);
  await shot('tools-page');
  console.log('tools state', await evaluate("JSON.stringify({memeDir:document.getElementById('toolMemeDir').textContent, logsOnPage:!!document.getElementById('section-logs').closest('[data-page=\"tools\"]'), removed:!!document.getElementById('section-test-send')})"));

  ws.close(); try { chrome.kill(); } catch {} process.exit(0);
})().catch((e) => { console.error('ERR', e.message); try { chrome.kill(); } catch {} process.exit(1); });
