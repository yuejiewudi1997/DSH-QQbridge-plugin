import { NodeApiClient } from '../src/dsh-client.js';
const client = new NodeApiClient('http://127.0.0.1:50514', 15000, {});
const res = await client.callUnary('session.modelCatalog', {});
const value = res?.result?.value ?? res?.result ?? {};
const group = (value.groups ?? []).find((g) => g.id === 'our-free-model');
console.log('our-free-model 模型:', (group?.models ?? []).length);
for (const m of group?.models ?? []) console.log('  ', m.id, '|', m.name, '|', m.description ? String(m.description).slice(0, 60) : '');
