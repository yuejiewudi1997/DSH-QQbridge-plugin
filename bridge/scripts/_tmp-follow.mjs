import { randomUUID } from 'node:crypto';
import { probeCookie, probeMuxSocket } from './probe-auth.mjs';
const cookie = probeCookie();
const sid = process.argv[2];
const socket = probeMuxSocket(cookie);
const streamId = randomUUID();
const texts = [];
function walk(node, out) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const n of node) walk(n, out); return; }
  if (node.type === 'assistant/message' && node.data?.message?.content) {
    for (const b of node.data.message.content) if (b?.type === 'text' && typeof b.text === 'string') out.push(b.text);
  }
  for (const v of Object.values(node)) walk(v, out);
}
socket.addEventListener('open', () => {
  socket.send(JSON.stringify({ type: 'open', streamId, endpoint: 'session/follow', payload: { args: { request: { address: { kind: 'session', sessionId: sid }, maxMessages: 60 } } } }));
  setTimeout(() => socket.close(), 7000);
});
socket.addEventListener('message', (ev) => { let m; try { m = JSON.parse(ev.data); } catch { return; } walk(m, texts); });
const dump = () => { const u = [...new Set(texts)]; console.log(JSON.stringify({ count: u.length, texts: u })); process.exit(0); };
socket.addEventListener('close', dump);
setTimeout(dump, 10000);
