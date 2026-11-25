(() => {
  const listeners = new Set();
  const noticeListeners = new Set();
  let snapshot;
  const verifications = new Map();
  const clone = () => structuredClone(snapshot);
  const feedback = text => { document.querySelector('#demo-feedback').textContent = text; };
  function emit(text) { for (const listener of listeners) listener(clone()); if (text) feedback(text); return clone(); }
  function environment(id) { return snapshot.environments.find(item => item.environmentId === id); }
  function release(id) {
    snapshot.pendingPermissions = snapshot.pendingPermissions.filter(item => item.environmentId !== id);
    for (const session of snapshot.sessions) {
      if (session.environmentId === id && session.agent === 'codex' && session.state === 'waiting_permission') session.state = 'idle';
    }
  }
  window.monitorDemo = (mode = 'mixed') => {
    const mixed = mode === 'mixed';
    snapshot = {
      devices: [{ deviceId: 'pc', name: '我的 Windows', kind: 'local' }, { deviceId: 'lab', name: '实验室 Linux', kind: 'remote' }, { deviceId: 'pi', name: '树莓派', kind: 'remote' }],
      environments: [
        { environmentId: 'windows', deviceId: 'pc', name: 'Windows 本机', kind: 'windows', status: 'connected', enabled: true, codexApprovalsEnabled: false },
        { environmentId: 'ubuntu', deviceId: 'pc', name: 'WSL · Ubuntu', kind: 'wsl', distribution: 'Ubuntu', status: 'connected', enabled: true, codexApprovalsEnabled: mixed },
        { environmentId: 'linux', deviceId: 'lab', name: '实验室 Linux', kind: 'ssh', sshHost: 'lab', status: 'connected', enabled: true, codexApprovalsEnabled: false },
        { environmentId: 'pi', deviceId: 'pi', name: '树莓派', kind: 'ssh', sshHost: 'pi', status: 'connected', enabled: true, codexApprovalsEnabled: false },
      ],
      preferences: { petEnabled: false, showPet: true, showPreview: true, systemNotifications: true, reminderMode: snapshot?.preferences?.reminderMode ?? 'pinned', focus: { kind: 'all' } },
      onboardingCompleted: true,
      sessions: [], pendingPermissions: [],
    };
    // [environment, agent, session, project, what the user asked for, what the agent said when it stopped,
    //  state in the "mixed" scene, state in the "now" scene, minutes since last activity, minutes running]
    const minute = 60_000;
    for (const [index, [id, agent, sessionId, project, title, summary, mixedState, nowState, quiet, ran]] of [
      ['pi', 'codex', '传感器驱动', 'sensor-hub', '修 I2C 读数偶发超时', '加了重试和超时保护，12 个测试全过。', 'working', 'completed', 2, 18],
      ['linux', 'copilot', '更新服务配置', 'gateway', '升级 nginx 配置', '配置改好了。要 reload 还是 restart？等你决定。', 'waiting_permission', 'completed', 6, 9],
      ['ubuntu', 'codex', '运行项目测试', 'robot-arm', '跑全量测试并修掉失败项', undefined, 'waiting_permission', 'working', 3, 31],
      ['windows', 'codex', '前端页面调整', 'vibemate-web', '调整设置页布局', '布局已调整，截图对比放在 docs/ 下。', 'working', 'working', 0.3, 12],
      ['ubuntu', 'copilot', '整理接口文档', 'api-docs', '整理接口文档', '文档已更新，新增 4 个接口说明。', 'completed', 'working', 1, 4],
    ].entries()) {
      const env = environment(id);
      const state = mixed ? mixedState : mode === 'now' ? nowState : mode;
      const age = mode === 'now' ? quiet * minute : index * 30_000;
      snapshot.sessions.push({ environmentId: id, deviceId: env.deviceId, environmentName: env.name, sourceProfile: id, project, title,
        summary: ['completed', 'failed'].includes(state) ? (state === 'failed' ? '构建失败：找不到依赖 libgpiod，需要你装一下。' : summary) : undefined,
        problem: mode === 'now' && sessionId === '运行项目测试' ? 'api_timeout' : undefined,
        agent, sessionId, state, startedAt: new Date(Date.now() - ran * minute).toISOString(),
        updatedAt: new Date(Date.now() - age).toISOString() });
    }
    if (mixed) snapshot.pendingPermissions.push({ environmentId: 'ubuntu', deviceId: 'pc', environmentName: 'WSL · Ubuntu',
      requestId: 'demo-permission', sourceProfile: 'ubuntu', agent: 'codex', sessionId: '运行项目测试',
      tool: { name: 'Bash · 运行项目测试', summary: '示例请求：npm test\n工作目录：/home/demo/project\n此按钮仅演示审批，不执行命令。' } });
    emit(mixed ? '示例：WSL 的 Codex 已主动开启桌面审批；Linux 的 Copilot 等待原生终端审批。' : '已切换模拟场景，未操作真实 Agent。');
  };
  // Mirrors TaskNotifier in the desktop main process: flip a session's state and announce it.
  window.simulateNotice = (sessionId, kind) => {
    const session = snapshot.sessions.find(item => item.sessionId === sessionId);
    if (!session) return;
    // api_failed / api_timeout / process_exited interrupt a running task; the state itself never moved on.
    const problem = ['api_failed', 'api_timeout', 'process_exited'].includes(kind) ? kind : undefined;
    session.state = problem ? 'working' : kind;
    session.problem = problem;
    session.updatedAt = new Date().toISOString();
    session.summary = kind === 'failed' ? '构建失败：找不到依赖 libgpiod，需要你装一下。'
      : kind === 'api_failed' ? '400 Bad Request：模型接口拒绝了请求。'
      : kind === 'completed' ? '改完了，测试全过。' : undefined;
    emit();
    const notice = { id: `${session.environmentId}/${session.agent}/${session.sessionId}`, kind,
      environmentName: session.environmentName, project: session.project, agent: session.agent, at: session.updatedAt };
    for (const listener of noticeListeners) listener(notice);
    const text = { completed: '完成了', failed: '失败了', waiting_permission: '等你确认', api_failed: '模型请求失败', api_timeout: '模型请求超时', process_exited: '进程没了' }[kind];
    feedback(`模拟提醒：${session.environmentName} · ${session.title} ${text}。桌面版会同时弹出系统通知。`);
  };
  window.simulateOffline = id => { environment(id).status = 'reconnecting'; environment(id).disconnectedAt = new Date(Date.now() - 120_000).toISOString(); emit(`模拟：${environment(id).name} 掉线了，上面的任务状态未知。`); };
  window.vibemate = {
    // Desktop: brings the VS Code window that hosts this session to the front.
    async focusSession(identity) {
      const session = snapshot.sessions.find(item => item.environmentId === identity.environmentId && item.sessionId === identity.sessionId);
      feedback(`模拟：已切到 VS Code 窗口「${session.environmentName} · ${session.project}」。`);
    },
    onNotice: listener => { noticeListeners.add(listener); return () => noticeListeners.delete(listener); },
    getSnapshot: async () => clone(),
    onSnapshot: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    async setReminderMode(mode) { snapshot.preferences.reminderMode = mode; return emit(mode === 'quiet' ? '安静模式：任务在跑时缩成小点，有任务停下或出问题才出现。' : '常驻模式：胶囊一直显示。'); },
    async setCodexApprovals(id, enabled) {
      environment(id).codexApprovalsEnabled = enabled;
      if (!enabled) release(id);
      return emit(enabled ? '模拟已开启此环境的 Codex 桌面审批。Copilot 仍沿用原生审批。' : '模拟已关闭桌面审批，等待中的请求交回原终端。');
    },
    async submitDecision(identity, decision) {
      const request = snapshot.pendingPermissions.find(item => item.requestId === identity.requestId && item.environmentId === identity.environmentId);
      if (!request) return 'not_found';
      snapshot.pendingPermissions = snapshot.pendingPermissions.filter(item => item !== request);
      const session = snapshot.sessions.find(item => item.agent === request.agent && item.sessionId === request.sessionId && item.environmentId === request.environmentId);
      session.state = decision === 'allow' ? 'working' : 'idle'; session.updatedAt = new Date().toISOString();
      emit(decision === 'allow' ? '模拟已允许，任务继续工作。未执行真实命令。' : '模拟已拒绝本次操作；未操作真实 Agent。'); return 'accepted';
    },
    async stopEnvironment(id) {
      environment(id).status = 'stopped'; environment(id).enabled = false; release(id);
      snapshot.sessions = snapshot.sessions.filter(item => item.environmentId !== id);
      return emit('模拟已停止此环境监控，其他环境不受影响。');
    },
    async startEnvironment(id) { environment(id).status = 'connected'; environment(id).enabled = true; return emit('模拟已连接，等待新的会话上报。'); },
    async setEnvironmentEnabled(id, enabled) { return enabled ? this.startEnvironment(id) : this.stopEnvironment(id); },
    async setFocus(focus) { snapshot.preferences.focus = focus; return emit('已保存示例关注范围；独立悬浮桌宠不包含在此主面板预览中。'); },
    async scanEnvironments() { return emit('模拟扫描完成：此页面使用固定示例环境，没有读取你的 Windows。'); },
    async pickPrivateKey() { return '/demo/id_ed25519'; },
    async testSshConnection({ profile }) {
      const verificationId = crypto.randomUUID();
      verifications.set(verificationId, JSON.stringify(profile));
      return { verificationId, hostname: profile.name, architecture: 'arm64', agents: { codex: true, copilot: true } };
    },
    async saveSshEnvironment({ profile, environmentId, verificationId }) {
      if (verificationId && verifications.get(verificationId) !== JSON.stringify(profile)) throw new Error('连接检查已失效，请重新测试');
      verifications.delete(verificationId);
      let env = environmentId ? environment(environmentId) : undefined;
      if (!env) {
        const id = `demo-${crypto.randomUUID()}`;
        snapshot.devices.push({ deviceId: id, name: profile.name, kind: 'remote' });
        env = { environmentId: id, deviceId: id, kind: 'ssh', status: 'stopped', enabled: false, codexApprovalsEnabled: false };
        snapshot.environments.push(env);
      }
      const { name, ...connection } = profile;
      Object.assign(env, { name, sshHost: profile.host, sshConnection: connection });
      return { snapshot: emit('已保存模拟设备配置，没有连接真实设备。'), environmentId: env.environmentId };
    },
    async removeSshEnvironment(id) {
      release(id);
      snapshot.environments = snapshot.environments.filter(item => item.environmentId !== id);
      snapshot.devices = snapshot.devices.filter(item => snapshot.environments.some(env => env.deviceId === item.deviceId));
      return emit('已移除模拟设备配置，未操作真实设备。');
    },
    async addSshEnvironment(host) {
      if (!snapshot.environments.some(item => item.sshHost === host)) {
        const id = `demo-${Date.now()}`;
        snapshot.devices.push({ deviceId: id, name: host, kind: 'remote' });
        snapshot.environments.push({ environmentId: id, deviceId: id, name: host, kind: 'ssh', sshHost: host, status: 'stopped', enabled: false, codexApprovalsEnabled: false });
      }
      return emit('已加入示例环境列表，没有执行 SSH 连接。');
    },
  };
  window.monitorDemo(location.pathname === '/floating' ? 'now' : 'mixed');
})();
