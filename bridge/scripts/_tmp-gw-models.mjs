import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const settings = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.dsh/our-free-model/settings.json'), 'utf8'));
const tr = settings.aggregate.providers.tokenrouter;
const res = await fetch(tr.baseUrl + '/models', { headers: { authorization: 'Bearer ' + tr.apiKey } });
const list = (await res.json()).data ?? [];
console.log('模型总数:', list.length);
const combos = list.filter((m) => String(m.id).startsWith('combo:'));
console.log('combo 数:', combos.length);
for (const m of combos) console.log('  ', m.id, '|', m.name, '| input=', JSON.stringify(m.input));
const vision = list.filter((m) => Array.isArray(m.input) && m.input.includes('image'));
console.log('支持图片的模型数:', vision.length);
console.log('前 12 个:', vision.slice(0, 12).map((m) => m.id).join(', '));
