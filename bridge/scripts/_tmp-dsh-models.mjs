import crypto from 'node:crypto';
import { discoverDshSessionCookie } from '../src/dsh-client.js';

const base = 'http://127.0.0.1:50514';
const cookie = discoverDshSessionCookie(base);

async function rpc(method, payload = {}) {
  const res = await fetch(base + '/api/' + method, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload })
  });
  return JSON.parse(await res.text());
}

const r = await rpc('settings/describe');
const value = r?.result?.value ?? r?.result ?? {};
console.log('ok:', r?.result?.ok);
const keys = Object.keys(value);
console.log('字段:', keys.join(', '));
const providers = value.providers ?? value.models ?? [];
console.log('provider 数:', Array.isArray(providers) ? providers.length : typeof providers);
const text = JSON.stringify(value);
const idx = text.indexOf('combo:');
console.log('含 combo:', idx >= 0);
console.log(text.slice(0, 1200));
