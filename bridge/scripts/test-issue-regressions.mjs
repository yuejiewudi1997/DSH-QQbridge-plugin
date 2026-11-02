// GitHub issue 回归：把上游 issue 里**已确认可复现**的缺陷钉死，防止回退。
//
// 覆盖：
//   #22 控制台切模式被 5 秒轮询改回去 —— DSH 0.2.0-rc.2 的 settings/update 只写 user 层，
//       同进程内 describe().value 不更新；读取必须 user 优先、value 回退。
//   #11/#19/#23/#26 回合结束信号丢了 → 会话永久 busy —— 回合判忙改为「起始时间 + 15 分钟租约」，
//       无起始时间的残留 collector 不再判忙；collector 保留，迟到回复照常 flush。
//   #29 被 @ 了不理人 —— 机器人昵称/QQ 号必须写进唤醒 prompt（否则 agent 把 @自己 当 @别人）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { bridgeHarness } from './audit-bridge-harness.mjs';

let failures = 0;
async function test(name, run) {
  try { await run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, '—', error?.stack ?? error); }
}

const KEY = 'group:1001';
const SID = 'session-1';

await test('#22 settingFromDshNamespace：user 层优先、value 回退', async () => {
  const h = await bridgeHarness();
  try {
    const f = h.settingFromDshNamespace;
    assert.equal(f({ value: { mode: 'reserved2' }, user: { mode: 'closed-agent' } }, 'mode'), 'closed-agent', 'user 层必须优先');
    assert.equal(f({ value: { mode: 'reserved2' }, user: {} }, 'mode'), 'reserved2', 'user 为空时回退 value');
    assert.equal(f({ value: { mode: 'reserved2' } }, 'mode'), 'reserved2', '没有 user 键时回退 value');
    assert.equal(f({ user: { ownerQQ: '' }, value: { ownerQQ: '123' } }, 'ownerQQ'), '', '空串也是显式值');
    assert.equal(f(undefined, 'mode'), undefined);
    assert.equal(f({ value: null }, 'mode'), undefined);
  } finally { await h.close(); }
});

await test('#22 refreshMode 采纳控制台刚写入的 user 层（否则 5 秒后被改回去）', async () => {
  const h = await bridgeHarness();
  try {
    h.api.settings.describe = async () => ({
      result: { ok: true, value: {
        namespaces: [
          { ns: 'qq-mode', value: { mode: 'reserved2', ownerQQ: '10001' }, user: { mode: 'closed-agent' } }
        ]
      } }
    });
    await h.refreshMode();
    assert.equal(h.getMode(), 'closed-agent', '必须读 user 层，而不是未热更新的 value');

    // 老行为兜底：从没在控制台写过（user 为空）时仍读 value。
    h.api.settings.describe = async () => ({
      result: { ok: true, value: { namespaces: [{ ns: 'qq-mode', value: { mode: 'simulation' }, user: {} }] } }
    });
    await h.refreshMode();
    assert.equal(h.getMode(), 'reserved2', 'simulation 是 reserved2 的规范名，读侧也要归一');

    // ownerQQ：user 层空串表示「不覆盖 config.json」。
    h.cfg.ownerQQ = 20002;
    h.api.settings.describe = async () => ({
      result: { ok: true, value: { namespaces: [{ ns: 'qq-mode', value: { mode: 'closed-agent', ownerQQ: 30003 }, user: { ownerQQ: '' } }] } }
    });
    await h.refreshMode();
    assert.equal(h.cfg.ownerQQ, 20002, 'user 层空串不得把 config.json 的 ownerQQ 抹掉');

    h.api.settings.describe = async () => ({
      result: { ok: true, value: { namespaces: [{ ns: 'qq-mode', value: { mode: 'closed-agent' }, user: { ownerQQ: '40004' } }] } }
    });
    await h.refreshMode();
    assert.equal(h.cfg.ownerQQ, 40004, 'user 层显式 ownerQQ 必须生效');
  } finally { await h.close(); }
});

await test('#11/#19 回合判忙：无起始时间的残留 collector 不再永久 busy', async () => {
  const h = await bridgeHarness();
  try {
    h.state.sessions[KEY] = SID;
    const st = h.getSocialV2State(KEY);
    const collector = { push() { return true; }, size() { return 1; } };

    assert.equal(h.isConversationBusyV2(KEY, st), false, '空状态不忙');

    h.collectors.set(SID, collector);
    assert.equal(h.isConversationBusyV2(KEY, st), false, '只有 collector、没有起始时间 → 不判忙（旧版这里永久忙）');

    h.v2TurnStartAt.set(SID, Date.now());
    assert.equal(h.isConversationBusyV2(KEY, st), true, '回合刚开始必须判忙');

    h.v2TurnStartAt.set(SID, Date.now() - (h.TURN_BUSY_LEASE_MS + 60_000));
    assert.equal(h.isConversationBusyV2(KEY, st), false, '超过租约必须解除忙碌');
    assert.equal(h.collectors.has(SID), true, '租约过期不能丢掉 collector（迟到回复仍要 flush）');

    h.v2TurnStartAt.delete(SID);
    h.collectors.delete(SID);
    h.v2TurnStartAt.set(SID, Date.now());
    assert.equal(h.isConversationBusyV2(KEY, st), true, '只有起始时间（collector 还没建）也算回合在进行');

    h.promptQueues.set(KEY, { running: true, queue: [] });
    assert.equal(h.isConversationBusyV2(KEY, st), true, 'prompt 在途仍算忙');
  } finally { await h.close(); }
});

await test('#29 唤醒 prompt 必须写明机器人自己的昵称与 QQ 号', async () => {
  const h = await bridgeHarness();
  try {
    h.setSelfIdentity('樰', '10001');
    const line = h.selfIdentityTextV2();
    assert.match(line, /【你的身份】/);
    assert.match(line, /樰/);
    assert.match(line, /10001/);
    assert.match(line, /@樰/, '必须明确「@昵称」指的是自己');

    const prompt = h.buildWakePromptV2(KEY, 'atMention');
    assert.match(prompt, /【你的身份】/, '每次唤醒都要带身份（它是 agent 唯一能对上号的地方）');
    assert.match(prompt, /@樰/);
    assert.match(prompt, /10001/);
    assert.doesNotMatch(prompt, /【会话令牌】|会话令牌/, '唤醒提示词不得再下发明文令牌');

    const reminder = h.buildWakeReminderPromptV2(KEY);
    assert.match(reminder, /【你的身份】/, '收尾提醒也要带身份');
    assert.doesNotMatch(reminder, /【会话令牌】|会话令牌/, '收尾提醒不得下发明文令牌');

    h.setSelfIdentity('', '');
    assert.equal(h.selfIdentityTextV2(), '', '身份未知时不注入空行（不能写「你的昵称是（）」）');
    assert.doesNotMatch(h.buildWakePromptV2(KEY, 'timeout'), /【你的身份】/);
  } finally { await h.close(); }
});

await test('#30 回合控制标记（done / TOPIC_*）不得当成聊天内容发到 QQ', async () => {
  const h = await bridgeHarness();
  try {
    // 整段只有标记 → 整条不发（模型偶尔把收尾信号当回复输出）
    assert.equal(h.stripControlMarkers('done'), '');
    assert.equal(h.stripControlMarkers('DONE.'), '');
    assert.equal(h.stripControlMarkers('TOPIC_IRRELEVANT'), '');
    assert.equal(h.stripControlMarkers('TOPIC_END。'), '');
    assert.equal(h.controlMarkerOnly('done'), true);
    assert.equal(h.controlMarkerOnly('TOPIC_END'), true);
    // 标记夹在正常内容里 → 只剃掉标记行，正常内容照发
    assert.equal(h.stripControlMarkers('好的，我看看\nDONE'), '好的，我看看');
    assert.equal(h.stripControlMarkers('DONE\n说完了'), '说完了');
    // 行尾跟在真内容后面的标记也要剃掉（模型常写「…，DONE」）
    assert.equal(h.stripControlMarkers('今天天气不错，DONE'), '今天天气不错');
    assert.equal(h.stripControlMarkers('说完了 DONE'), '说完了');
    assert.equal(h.stripControlMarkers('好的DONE'), '好的');
    // 英文里的正常 done 不能被误删（只认全大写标记）
    assert.equal(h.stripControlMarkers('well done'), 'well done');
    assert.equal(h.controlMarkerOnly('好的'), false);
    assert.equal(h.controlMarkerOnly(''), false, '空串交给别处的空回复逻辑处理');
    // 发送工具入参清洗：只留真内容，纯标记消息整条丢掉
    assert.equal(JSON.stringify(h.dropControlMarkerMessages(['done', '好的'])), JSON.stringify(['好的']));
    assert.equal(JSON.stringify(h.dropControlMarkerMessages(['DONE', 'TOPIC_END'])), '[]', '全是标记 → 调用方报错而不是静默发送');
  } finally { await h.close(); }
});

await test('#31 待处理任务超过 1 小时直接抛弃，不再投给模型', async () => {
  const h = await bridgeHarness();
  try {
    const key = 'group:1002';
    const st = h.getSocialV2State(key);
    h.appendSocialV2Message(key, '张三', '两小时前的消息', '两小时前的消息', false, false, 9001);
    h.appendSocialV2Message(key, '张三', '刚刚的消息', '刚刚的消息', false, false, 9002);
    const now = Date.now();
    const oldSeq = st.unread[0].seq;
    const freshSeq = st.unread[1].seq;
    st.unread[0].time = now - 2 * 60 * 60 * 1000;

    // 注意：bridge 侧返回的数组来自 VM realm，deepEqual 会因 Array 原型不同而误判，统一按 JSON 比。
    const dropped = JSON.stringify(h.discardExpiredPersonaTasks(key, st, now));
    assert.equal(dropped, JSON.stringify([oldSeq]), '只丢弃超过 1 小时的那条');
    assert.equal(JSON.stringify(st.unread.map((m) => m.seq)), JSON.stringify([freshSeq]), '新鲜任务必须留在队列里');
    assert.equal(h.personaTaskMap(key).has(oldSeq), false, '过期任务的派发状态要一起清掉');

    // 卡在边界内的不丢（59 分钟）
    st.unread[0].time = now - 59 * 60 * 1000;
    assert.equal(JSON.stringify(h.discardExpiredPersonaTasks(key, st, now)), '[]', '59 分钟不算过期');
    // 没有时间戳的旧状态数据不因缺字段被误丢
    delete st.unread[0].time;
    assert.equal(JSON.stringify(h.discardExpiredPersonaTasks(key, st, now)), '[]', '缺时间戳时不判定过期');
  } finally { await h.close(); }
});

await test('#32 人格运行时接管后旧主会话必须退场（不能和人格分支同时在跑）', async () => {
  const h = await bridgeHarness();
  try {
    h.setReady(true);
    // 关掉运行时：旧链路正常建立主会话
    h.cfg.socialV2 = h.cfg.socialV2 || {};
    h.cfg.socialV2.runtime = { ...(h.cfg.socialV2.runtime || {}), enabled: false };
    h.setMode('reserved2');
    assert.equal(h.legacyReserved2PathDisabled(), false, '运行时关闭时旧链路是唯一路径，不能停');

    const key = 'group:456'; // fixture 白名单里的群（reserved2 建会话要通过 modeAllowed）
    const sid = await h.ensureSession(key);
    assert.equal(h.state.sessions[key], sid, '旧链路应建立并记录主会话');

    // 开运行时：旧主会话立刻退场（DSH 侧停任务 + 归档 + 清唤醒定时器）
    h.cfg.socialV2.runtime = { ...(h.cfg.socialV2.runtime || {}), enabled: true };
    assert.equal(h.legacyReserved2PathDisabled(), true, '运行时接管后旧链路应判定为停用');
    const retired = h.retireLegacySessionsForPersonaRuntime('测试接管');
    assert.equal(retired, 1);
    assert.equal(h.state.sessions[key], undefined, '旧映射必须删掉，否则 DSH 里会一直挂着旧会话');
    // 归档是 fire-and-forget 的异步收尾，等一个 tick 再断言
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(h.calls.archived.includes(sid), true, '旧会话要归档，不能只删本地映射');

    // 运行时接管后：回复检查 / 主动机会 / 唤醒都不许再排给旧会话
    const before = h.calls.prompts.length;
    h.scheduleReplyCheckV2(key);
    h.scheduleProactiveCheckV2(key);
    await h.sendWakePromptV2(key, 'replyCheck');
    assert.equal(h.calls.prompts.length, before, '旧链路唤醒被拦住，不能再投递 prompt');
  } finally { await h.close(); }
});

await test('#33 开发者模式：拦截落盘与发送、完全静默不入未读', async () => {
  const h = await bridgeHarness();
  try {
    h.setMode('reserved2');
    const key = 'group:456';
    assert.equal(h.devModeEnabled(), false, '默认关闭，不能影响正常运行时');
    const sentBefore = h.calls.sent.length;
    await h.sendToQQ(key, '正常发送');
    assert.equal(h.calls.sent.length, sentBefore + 1, '关闭时消息照常发出');

    h.writeDevMode({ enabled: true, policy: 'guard' });
    assert.equal(h.devModeEnabled(), true);
    assert.equal(h.devPolicyLabel(), '拦截所有落盘和消息发送');
    // 落盘：AI/测试写入全拦，桥接核心状态照常（否则连开发者模式自己是开是关都记不住）
    assert.equal(h.isDevBlockedWrite(path.join(h.temp, 'state', 'knowledge.json')), true);
    assert.equal(h.isDevBlockedWrite(path.join(h.temp, 'state', 'sessions.json')), false);
    const knowledgeFile = path.join(h.temp, 'state', 'knowledge.json');
    h.atomicWriteJson(knowledgeFile, { items: [1] });
    assert.equal(fs.existsSync(knowledgeFile), false, '拦截名单里的文件不得落盘');
    const sessionsFile = path.join(h.temp, 'state', 'core-probe.json');
    h.atomicWriteJson(sessionsFile, { sessions: {} });
    assert.equal(fs.existsSync(sessionsFile), true, '核心状态照常落盘');

    const blockedBefore = h.calls.sent.length;
    await h.sendToQQ(key, '不该发出去');
    assert.equal(h.calls.sent.length, blockedBefore, '开发者模式不得向 QQ 发送任何消息');
    assert.equal(h.shouldBlockSilentReply(key), false, '开发者模式只在链路终点拦截，不在工具/代理入口拦截');

    // 完全静默：消息不进未读，也不排任何回合
    h.writeDevMode({ enabled: true, policy: 'off' });
    assert.equal(h.devOffActive(), true);
    const st = h.getSocialV2State(key);
    const unreadBefore = st.unread.length;
    await h.handleIncoming('group', 456, {
      user_id: 222, self_id: 999, group_id: 456,
      message: [{ type: 'text', data: { text: '在吗' } }],
      message_id: 1, time: Math.floor(Date.now() / 1000)
    }, h.cfg);
    assert.equal(h.getSocialV2State(key).unread.length, unreadBefore, '完全静默不得把消息入未读');
    const promptsBefore = h.calls.prompts.length;
    h.scheduleReplyCheckV2(key);
    h.scheduleProactiveCheckV2(key);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(h.calls.prompts.length, promptsBefore, '完全静默不得派发任何回合');
  } finally {
    h.writeDevMode({ enabled: false });
    await h.close();
  }
});

await test('#34 开发者模式：运行时会话统一建在测试工作区，可一键删除', async () => {
  const h = await bridgeHarness();
  try {
    h.setMode('reserved2');
    h.cfg.socialV2 = h.cfg.socialV2 || {};
    h.cfg.socialV2.runtime = { ...(h.cfg.socialV2.runtime || {}), enabled: false };
    h.writeDevMode({ enabled: true, policy: 'guard' });

    const ws1 = await h.createRunWorkspace(path.join(h.temp, 'agents', 'persona-1'), '人格一', 'persona');
    const ws2 = await h.createRunWorkspace(path.join(h.temp, 'agents'), '主会话', 'session');
    assert.equal(ws1, 'fixture-workspace', '开发者模式下工作区来自测试工作区');
    assert.equal(ws2, ws1, '所有运行时会话共用同一个测试工作区');
    assert.equal(h.readDevMode().testWorkspaceId, 'fixture-workspace', '测试工作区 id 要持久化');
    assert.equal(fs.existsSync(path.join(h.temp, 'state', 'dev-mode.json')), true, 'dev-mode.json 属于桥接核心状态，必须能落盘');

    const key = 'group:456';
    const sid = await h.ensureSession(key);
    assert.equal(h.state.sessions[key], sid);
    assert.equal(h.readDevMode().testSessionIds.includes(sid), true, '运行时会话要被登记，删除时才有确定边界');

    const result = await h.deleteDevTestWorkspace();
    assert.equal(result.ok, true);
    assert.equal(result.archived, 1, '测试会话要归档');
    assert.equal(h.calls.deleted.includes('fixture-workspace'), true, 'DSH 侧工作区要删除');
    assert.equal(h.state.sessions[key], undefined, '本地映射要一起清掉');
    assert.equal(h.readDevMode().testWorkspaceId, '', '删除后要清空测试工作区记录');
    assert.equal(fs.existsSync(path.join(h.temp, 'agents', 'test')), false, '本地测试目录要删掉');
  } finally {
    h.writeDevMode({ enabled: false });
    await h.close();
  }
});

await test('#35 开发者模式：旧工作区的运行时会话必须退役，调度改派到测试工作区', async () => {
  const h = await bridgeHarness();
  try {
    h.setMode('reserved2');
    h.cfg.socialV2 = h.cfg.socialV2 || {};
    h.cfg.socialV2.runtime = { ...(h.cfg.socialV2.runtime || {}), enabled: false };
    h.writeDevMode({ enabled: false, policy: 'guard' });
    // 场景：开发者模式开启前，正式工作区里已经有一套运行时会话（主会话 + 人格分支）。
    h.state.sessions['group:456'] = 'legacy-main-session';
    h.personaAgents.set('小鲸鱼', {
      workspaceId: 'ws-formal',
      workspacePath: path.join(h.temp, 'agents', 'personas', 'formal'),
      branches: { 'group:456': 'legacy-branch-session' }
    });
    h.writeDevMode({ enabled: true, policy: 'guard' });
    const result = await h.resetRuntimeSessionsForDevMode('开启开发者模式');
    assert.equal(result.archived >= 2, true, '旧主会话与旧人格分支都要归档');
    assert.equal(h.calls.archived.includes('legacy-main-session'), true, '旧主会话要归档');
    assert.equal(h.calls.archived.includes('legacy-branch-session'), true, '旧人格分支要归档');
    assert.equal(h.state.sessions['group:456'], undefined, '旧映射必须清掉，否则调度还派给旧会话');
    assert.equal(JSON.stringify(h.personaAgents.get('小鲸鱼').branches), '{}', '人格分支映射要清空');
    assert.equal(h.personaAgents.get('小鲸鱼').workspaceId, '', '人格工作区指针要清空，重建时才会指向测试工作区');
    assert.equal(h.readDevMode().testSessionIds.length, 0, '退役后登记表清零，等重建再记账');

    // 后续调度按需重建：工作区与登记都落在测试工作区
    const ws = await h.createRunWorkspace(path.join(h.temp, 'agents', 'personas', '小鲸鱼'), '人格一', 'persona');
    assert.equal(ws, 'fixture-workspace', '重建的人格工作区必须来自测试工作区');
    const sid = await h.ensureSession('group:456');
    assert.equal(h.readDevMode().testSessionIds.includes(sid), true, '重建的会话要登记，测试工作区才有边界');
    assert.equal(h.state.sessions['group:456'], sid);
  } finally {
    h.writeDevMode({ enabled: false });
    await h.close();
  }
});

await test('#36 开发者模式：拦截发生在链路终点，代理拿到正常成功返回', async () => {
  const h = await bridgeHarness();
  try {
    h.setMode('reserved2');
    h.writeDevMode({ enabled: true, policy: 'guard' });
    const key = 'group:456';

    // 文本通道：不抛错、不提前返回，排队后跳过真正的 bot 调用
    const before = h.calls.sent.length;
    await h.sendToQQ(key, '拦截探针');
    assert.equal(h.calls.sent.length, before, '链路终点不得真的发到 QQ');

    // OneBot 直发通道：返回合成成功，代理侧完全感知不到被拦
    const res = await h.onebotSend('group', 456, '拦截探针');
    assert.equal(JSON.stringify(res), JSON.stringify({ message_id: 0, message_seq: 0 }), '代理拿到成功返回');
    assert.equal(h.shouldBlockSilentReply(key), false, '入口层不再拦截');
  } finally {
    h.writeDevMode({ enabled: false });
    await h.close();
  }
});

await test('#37 日志分窗：QQ 消息行与系统事件行分开', async () => {
  const h = await bridgeHarness();
  try {
    fs.writeFileSync(path.join(h.temp, 'state', 'qq-activity.log'), [
      '[08:00:00] group:1 群友 小明：你好',
      '[08:00:01] group:1 agent 回复：在的',
      '[08:00:02] group:1 [reserved2] 消息已入未读：你好',
      '[08:00:03] 开发者模式：测试工作区已删除（归档 0 个会话）',
      '[08:00:04] group:1 [send] 成功 1/1 条：来了'
    ].join('\n') + '\n');
    const out = h.readQqMessageTail(50);
    assert.match(out, /群友 小明：你好/);
    assert.match(out, /agent 回复：在的/);
    assert.match(out, /\[send\] 成功/);
    assert.doesNotMatch(out, /消息已入未读/);
    assert.doesNotMatch(out, /开发者模式/);
  } finally {
    await h.close();
  }
});

await test('#38 检索到的记忆：只有自己发言的命中直接丢弃', async () => {
  const h = await bridgeHarness();
  try {
    h.setSelfIdentity('可爱大肥鱼', '123456');
    const hits = [
      { text: '群聊片段（10-26 12:00，1 人 1 条）：[1] 可爱大肥鱼：今天摸鱼' },
      { text: '群聊片段（10-26 12:00，2 人 2 条）：[1] 甲：在吗；[2] 可爱大肥鱼：在' },
      { text: '群 456 的管理员是 甲' }
    ];
    const kept = h.dropSelfOnlyMemoryHits(hits);
    assert.equal(kept.length, 2);
    assert.match(kept[0].text, /甲：在吗/);
    assert.match(kept[1].text, /管理员是 甲/);
  } finally {
    await h.close();
  }
});

await test('#39 qq_topic_open：主会话可给某个群友开专属话题队列', async () => {
  const h = await bridgeHarness({
    files: {
      'state/persona-config.json': { 蓝色大肥鱼: { groups: ['group:456'], system: '', user: '' } },
      'state/persona-agents.json': { 蓝色大肥鱼: { workspaceId: 'ws-fixture', workspacePath: 'fixture', branches: {} } }
    }
  });
  const server = h.startConsoleServer();
  try {
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    const port = server.address().port;
    const token = h.getSocialV2State('group:456').agentToken;
    const call = (body) => new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port, path: '/api/socialV2/topic/open', method: 'POST',
        headers: { 'content-type': 'application/json', 'x-agent-token': token, 'x-agent-call': '1', 'x-console-token': 'fixture-console-token' }
      }, (res) => {
        let text = '';
        res.on('data', (chunk) => { text += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body: text }));
      });
      req.on('error', reject);
      req.end(JSON.stringify(body));
    });
    const first = await call({ key: 'group:456', userId: '10001', sender: '甲' });
    assert.equal(first.status, 200, first.body);
    const data = JSON.parse(first.body);
    assert.equal(data.ok, true);
    assert.equal(data.topicKey, 'group:456#10001');
    assert.match(data.note, /话题代理/);
    // 工具开关关闭后在终点拒绝（注册期收敛由 test-audit-security-mcp 覆盖）
    h.cfg.socialV2.tools.topicOpen = false;
    const denied = await call({ key: 'group:456', userId: '10002', sender: '乙' });
    assert.equal(denied.status, 403, denied.body);
    assert.match(JSON.parse(denied.body).error, /qq_topic_open/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await h.close();
  }
});

if (failures) {
  console.error(`\n${failures} 项失败`);
  process.exitCode = 1;
} else {
  console.log('\n全部通过');
}


