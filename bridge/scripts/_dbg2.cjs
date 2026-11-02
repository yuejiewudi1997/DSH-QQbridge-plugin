const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find((p) => fs.existsSync(p));
const PORT = 9336;
const PROFILE = path.join(os.tmpdir(), 'dsh-dbg2-' + Date.now());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn(CHROME, ['--headless=new','--disable-gpu','--disable-extensions','--no-first-run','--remote-debugging-port=' + PORT,'--user-data-dir=' + PROFILE,'about:blank'], { stdio: 'ignore' });
(async () => {
  let target = null;
  for (let i = 0; i < 40 && !target; i++) { await sleep(500); try { const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json(); target = (list||[]).find((t) => t.type === 'page' && t.webSocketDebuggerUrl) || null; } catch {} }
  const ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false });
  let id = 0; const pending = new Map();
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.method === 'Runtime.exceptionThrown') console.log('EXCEPTION', JSON.stringify(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text).slice(0, 300));
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') console.log('CONSOLE-ERR', JSON.stringify(m.params.args.map(a => a.description || a.value)).slice(0, 300));
    if (m.id && pending.has(m.id)) { const { resolve, reject } = pending.get(m.id); pending.delete(m.id); m.error ? reject(new Error(m.error.message)) : resolve(m.result); }
  });
  await new Promise((r) => ws.on('open', r));
  const send = (method, params = {}) => new Promise((resolve, reject) => { const mid = ++id; pending.set(mid, { resolve, reject }); ws.send(JSON.stringify({ id: mid, method, params })); });
  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.navigate', { url: 'http://127.0.0.1:3100/?cb=' + Date.now() });
  await sleep(5000);
  const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true }); return r?.exceptionDetails ? 'EXC:' + r.exceptionDetails.text : JSON.stringify(r?.result?.value); };
  for (const e of [
    "location.hash", "currentConsolePage", "typeof setOpsTab", "typeof applyOpsTabPanels", "typeof initOpsPanel",
    "document.querySelectorAll('section[data-page=\"operations\"][data-ops-panel]').length",
    "JSON.stringify([...document.querySelectorAll('section[data-ops-panel]')].map(s=>[s.id,s.hidden]))",
    "document.getElementById('opsTabRow').children.length",
    "(setOpsTab('monitor'), 'called')",
    "JSON.stringify([...document.querySelectorAll('section[data-ops-panel]')].map(s=>[s.id,s.hidden]))",
    "currentOpsTab"
  ]) console.log('>>', e, '=>', await ev(e));
  ws.close(); try { chrome.kill(); } catch {} process.exit(0);
})().catch((e) => { console.error('ERR', e.message); try { chrome.kill(); } catch {} process.exit(1); });
