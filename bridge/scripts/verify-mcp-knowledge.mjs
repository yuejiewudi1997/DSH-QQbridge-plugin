// 用真实 stdio 握手确认 MCP server 注册了知识库两个工具（不需要重启 DSH）。
import { spawn } from 'node:child_process';

const node = process.execPath;
const child = spawn(node, ['src/mcp-snowluma-safe.js'], {
  cwd: process.env.BRIDGE_DIR,
  stdio: ['pipe', 'pipe', 'pipe'],
});

let buffer = '';
const pending = new Map();
const send = (msg) => child.stdin.write(JSON.stringify(msg) + '\n');
const wait = (id, ms = 20000) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`timeout waiting for id=${id}`)), ms);
  pending.set(id, (value) => { clearTimeout(timer); resolve(value); });
});

child.stdout.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    const resolver = pending.get(msg.id);
    if (resolver) { pending.delete(msg.id); resolver(msg); }
  }
});

let stderr = '';
child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });

try {
  const init = wait(1);
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'verify', version: '1' } } });
  const initRes = await init;
  console.log('initialize:', initRes.result?.serverInfo?.name ?? JSON.stringify(initRes).slice(0, 120));
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });

  const listed = wait(2);
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const tools = (await listed).result?.tools ?? [];
  const names = tools.map((tool) => tool.name);
  console.log('工具总数:', names.length);
  for (const name of names.filter((n) => n.includes('knowledge') || n.includes('slang'))) {
    const tool = tools.find((t) => t.name === name);
    const schema = tool.inputSchema?.properties ?? {};
    console.log(` - ${name}: ${tool.description?.slice(0, 46)}… 参数=${Object.keys(schema).join(',')}`);
  }
  const need = ['qq_knowledge_search', 'qq_knowledge_propose'];
  console.log('知识库工具齐备:', need.every((n) => names.includes(n)) ? '是' : `否（缺 ${need.filter((n) => !names.includes(n)).join(', ')}）`);
} catch (error) {
  console.error('失败:', error.message, stderr.slice(-400));
} finally {
  child.kill();
}
