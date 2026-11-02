import { probeCookie, probeRpc } from './probe-auth.mjs';
const cookie = probeCookie();
const rpc = probeRpc(cookie);
const ids = process.argv.slice(2);
for (const workspaceId of ids) {
  const r = await rpc('workspace/delete', { request: { workspaceId } });
  console.log(workspaceId, '->', r.ok ? 'ok' : ('ERR ' + r.error.code + ':' + r.error.message));
}
