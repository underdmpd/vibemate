const $ = id => document.getElementById(id);
const api = window.vibemate;
// A task is either still running or it is the user's turn. Everything else is detail.
//   running   – the agent is working, nothing to do
//   done      – the turn ended; the user should go back and look
//   attention – the turn is blocked on a confirmation
//   error     – the turn failed, or the task cannot go on by itself (see problemText)
const rank = { error: 4, attention: 3, done: 2, running: 1, idle: 0 };
const statusText = { completed: '完成了', failed: '失败了', waiting_permission: '等你确认', idle: '空闲', ended: '会话已结束' };
// The only ways a "running" task silently stops being one. The first three are decided upstream and
// arrive as session.problem; a lost device is known here from the environment's connection.
const problemText = { api_failed: '模型请求失败', api_timeout: '模型请求超时', process_exited: '进程没了', offline: '设备掉线' };
const problemHint = {
  api_failed: '模型接口报错，任务停在半路。回去重试一次。',
  api_timeout: '模型一直没有返回，可能是网络或接口问题。',
  process_exited: 'Agent 进程意外退出，任务没有做完。',
  offline: '设备连不上了，任务可能还在跑，也可能已经停了。',
};
// A device that drops off is only reported once it has stayed away this long; short blips are ignored.
const OFFLINE_GRACE = 90_000;
const DOT_AFTER_EMPTY = 30_000;
const DRAG_THRESHOLD = 4;
const RECENT_ROWS = 3;
const TOAST_DURATION = 6_000;

let snapshot = {};
let expanded = location.hash==='#exp';
let pinnedExpanded = false;
let hovered = false;
let emptySince = Date.now();
let toastId; // session that was just announced; it leads the capsule while the toast lasts
let toastTimer;
let highlightId;
// session key -> the stop the user has already looked at. A new turn ending un-sees it again.
const seen = new Map();
const lastOpened = new Map();
const openingSessions = new Set();
let recentExpanded;
let showAllRecent = false;
// environmentId -> when it was first seen disconnected (used when the host does not say).
const offlineSince = new Map();
const identity = item => `${item.environmentId}/${item.agent}/${item.sessionId}`;

const minutes = ms => Math.max(1, Math.round(ms / 60_000));
function duration(ms) {
  const m = minutes(ms);
  return m < 60 ? `${m} 分钟` : `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
}

function classify(value) {
  const now = Date.now();
  const items = [];
  const connected = new Set();
  const lost = new Set();
  for (const env of value.environments ?? []) {
    if (env.status === 'connected') { connected.add(env.environmentId); offlineSince.delete(env.environmentId); continue; }
    if (!offlineSince.has(env.environmentId)) offlineSince.set(env.environmentId, now);
    const since = env.disconnectedAt ? Date.parse(env.disconnectedAt) : offlineSince.get(env.environmentId);
    if (now - since >= OFFLINE_GRACE) lost.add(env.environmentId);
  }
  for (const session of value.sessions ?? []) {
    const running = session.state === 'working' || session.state === 'thinking';
    const offline = !connected.has(session.environmentId);
    const problem = running && lost.has(session.environmentId) ? 'offline' : problemText[session.problem] ? session.problem : undefined;
    let kind;
    if (problem || session.state === 'failed') kind = 'error';
    else if (session.state === 'completed') kind = 'done';
    else if (session.state === 'waiting_permission') kind = 'attention';
    else if (running) kind = 'running';
    else if (session.state === 'idle' || session.state === 'ended') kind = 'idle';
    else continue;
    const key = identity(session);
    const mark = `${session.updatedAt}/${problem ?? ''}`;
    const isSeen = kind !== 'running' && seen.get(key) === mark;
    const status = problem ? problemText[problem]
      : kind === 'running' ? (session.startedAt ? `已跑 ${duration(now - Date.parse(session.startedAt))}` : '在跑')
      : statusText[session.state];
    items.push({ session, key, kind, status, problem, mark, offline, seen: isSeen, open: kind !== 'running' && kind !== 'idle' && !isSeen,
      title: session.title ?? session.project ?? session.sessionId });
  }
  return items.sort((a, b) => b.open - a.open || rank[b.kind] - rank[a.kind]
    || Date.parse(b.session.updatedAt) - Date.parse(a.session.updatedAt));
}

// "toast" is what keeps a docked window slid out: it lasts for as long as a task is waiting for the user.
function currentMode(taskCount, openCount, quiet) {
  if (expanded) return 'expanded';
  if (openCount > 0) return 'toast';
  if (quiet && !hovered) return 'dot';
  if (taskCount === 0 && Date.now() - emptySince > DOT_AFTER_EMPTY) return 'dot';
  return 'capsule';
}

let reportScheduled = false;
function reportState() {
  if (reportScheduled) return;
  reportScheduled = true;
  requestAnimationFrame(() => {
    reportScheduled = false;
    const monitor = $('monitor');
    api.reportPreviewState?.({
      mode: monitor.dataset.mode,
      width: Math.ceil(monitor.offsetWidth),
      height: Math.ceil(monitor.offsetHeight),
      hovered,
    });
  });
}

// Looking at a task (and jumping back to its window, where the host supports it) settles it.
async function goBack(item) {
  if (api.focusSession) {
    if (openingSessions.has(item.key)) return;
    openingSessions.add(item.key);
    $('feedback').textContent = '';
    render(snapshot);
    const { environmentId, agent, sessionId } = item.session;
    try {
      const message = await api.focusSession({ environmentId, agent, sessionId });
      if (message) { $('feedback').textContent = message; return; }
    } catch { $('feedback').textContent = '没能切到那个窗口，请手动回到对应终端。'; return; }
    finally { openingSessions.delete(item.key); render(snapshot); }
  }
  lastOpened.set(item.key, Date.now());
  acknowledge(item);
}

function acknowledge(item) {
  $('feedback').textContent = '';
  seen.set(item.key, item.mark);
  render(snapshot);
  void api.markSessionSeen?.(item.key, item.mark).catch(() => undefined);
}

async function resumeInTerminal(item) {
  if (openingSessions.has(item.key)) return;
  openingSessions.add(item.key);
  render(snapshot);
  const { environmentId, agent, sessionId } = item.session;
  try {
    const message = await api.resumeSession({ environmentId, agent, sessionId });
    $('feedback').textContent = message || '已请求在 Windows Terminal 中继续。';
    if (!message) lastOpened.set(item.key, Date.now());
  } catch {
    $('feedback').textContent = '无法打开这条对话，请重试。';
  } finally {
    setTimeout(() => { openingSessions.delete(item.key); render(snapshot); }, 1200);
  }
}

function buildTask(item, value) {
  const { session, key } = item;
  // A finished task on a device that has since gone away: nothing to go back to.
  const offline = item.offline;
  const agentName = ({ codex: 'Codex', copilot: 'Copilot', claude: 'Claude Code', antigravity: 'Antigravity' })[session.agent];

  const card = document.createElement('div');
  card.className = `task kind-${item.kind}${item.open ? ' open' : ''}${item.seen ? ' seen' : ''}${offline ? ' offline' : ''}${key === highlightId ? ' highlight' : ''}`;

  const icon = document.createElement('span'); icon.className = 'icon'; icon.dataset.kind = offline ? 'offline' : item.kind;
  const main = document.createElement('span'); main.className = 'task-main';
  const title = document.createElement('span'); title.className = 'task-title'; title.textContent = item.title; title.title = `${item.title} · ${session.sessionId}`;
  const meta = document.createElement('span'); meta.className = 'task-meta';
  meta.textContent = [session.environmentName ?? '本机', session.project !== item.title && session.project, agentName].filter(Boolean).join(' · ');
  main.append(title, meta);
  const side = document.createElement('span'); side.className = 'task-actions';
  const state = document.createElement('span'); state.className = 'task-side';
  state.textContent = offline ? '已断线'
    : session.agent === 'copilot' && session.state === 'waiting_permission' ? '回终端处理'
    : item.status;
  main.append(state);
  card.append(icon, main, side);

  const localWindows = value.environments?.some(env => env.environmentId === session.environmentId && env.kind === 'windows');
  const terminal = localWindows && session.terminalTarget;
  if (localWindows && !offline && api.resumeSession && session.state === 'ended' && ['codex', 'copilot'].includes(session.agent)) {
    side.classList.add('resume-actions');
    const resume = document.createElement('button');
    resume.disabled = openingSessions.has(key);
    resume.textContent = resume.disabled ? '正在打开…' : '在 Windows Terminal 继续';
    resume.onclick = () => resumeInTerminal(item);
    side.append(resume);
  }
  if (terminal === 'unknown' && session.state !== 'ended') {
    const hint = document.createElement('span');
    hint.className = 'task-side';
    hint.textContent = '请手动切回终端';
    side.append(hint);
  }
  if (terminal !== 'unknown' && api.focusSession && !offline && session.state !== 'ended' && item.problem !== 'process_exited') {
    const jump = document.createElement('button');
    jump.disabled = openingSessions.has(key);
    jump.textContent = jump.disabled ? '正在切换…' : terminal ? '打开终端窗口' : '回到任务';
    jump.onclick = () => goBack(item);
    side.append(jump);
  }
  if (item.open) {
    const dismiss = document.createElement('button');
    dismiss.textContent = '知道了';
    dismiss.onclick = () => acknowledge(item);
    side.append(dismiss);
  }

  if (item.kind !== 'running' && !offline) {
    // What the agent said when it stopped; without it, at least say where to look.
    const text = item.problem ? session.summary ?? problemHint[item.problem]
      : session.summary ?? (session.state === 'failed' ? '任务遇到问题，请回原终端查看原因。' : '');
    if (text) { const detail = document.createElement('p'); detail.className = 'task-detail'; detail.textContent = text; card.append(detail); }
  }
  return card;
}

function sectionLabel(text) {
  const label = document.createElement('div'); label.className = 'section-label'; label.textContent = text; return label;
}

function render(value) {
  snapshot = value;
  if (value.seenSessions && typeof value.seenSessions === 'object') {
    for (const [k, v] of Object.entries(value.seenSessions)) {
      if (typeof v === 'string') seen.set(k, v);
    }
  }
  const items = classify(value);

  const open = items.filter(item => item.open);
  const running = items.filter(item => item.kind === 'running');
  const activeCount = open.length + running.length;
  if (activeCount) emptySince = Date.now();
  const recent = items.filter(item => item.seen || item.kind === 'idle')
    .sort((a, b) => (lastOpened.get(b.key) ?? Date.parse(b.session.updatedAt))
      - (lastOpened.get(a.key) ?? Date.parse(a.session.updatedAt)));
  const onlineDevices = new Set((value.environments ?? []).filter(e => e.status === 'connected').map(e => e.deviceId)).size;

  // The capsule says one thing: the task waiting for the user, else how many are still running.
  const lead = open.find(item => item.key === toastId) ?? open[0];
  const kind = lead ? lead.kind : running.length ? 'running' : onlineDevices ? 'idle' : 'offline';
  const monitor = $('monitor');
  monitor.dataset.kind = kind;
  const quiet = value.preferences?.reminderMode === 'quiet';
  monitor.toggleAttribute('data-quiet', quiet);
  monitor.dataset.mode = currentMode(activeCount, open.length, quiet);
  $('mode-toggle').hidden = !api.setReminderMode;
  $('mode-toggle').textContent = quiet ? '安静模式' : '常驻模式';
  $('mode-toggle').title = quiet ? '现在：任务在跑时缩成小点，有事才出现。点击改为一直显示' : '现在：一直显示。点击改为任务在跑时缩成小点';
  $('capsule-icon').dataset.kind = kind;
  $('capsule-text').textContent = lead ? `${lead.session.environmentName ?? '本机'} · ${lead.title}`
    : running.length ? `${running.length} 个在跑`
    : onlineDevices ? `${onlineDevices} 台设备在线 · 空闲` : '未连接设备';
  $('capsule-status').textContent = lead ? lead.status : '';
  $('capsule-extra').textContent = open.length > 1 ? `+${open.length - 1}` : '';
  $('capsule').setAttribute('aria-label', lead ? `${$('capsule-text').textContent} ${lead.status}，点击展开` : '展开任务监控');
  $('capsule').title = '点击查看任务列表';

  $('headline').textContent = open.length ? `${open.length} 个轮到你` : running.length ? `${running.length} 个在跑` : '任务监控';
  $('connection').textContent = `${onlineDevices} 台设备在线`;
  $('expanded').hidden = !expanded;

  const nodes = [];
  for (const [label, group] of [['轮到你', open], ['在跑', running]]) {
    if (!group.length) continue;
    if (open.length && running.length) nodes.push(sectionLabel(label));
    nodes.push(...group.map(item => buildTask(item, value)));
  }
  if (recent.length) {
    const visible = !activeCount || recentExpanded;
    if (activeCount) {
      const toggle = document.createElement('button');
      toggle.className = 'recent-toggle';
      toggle.textContent = `最近任务（${recent.length}） ${visible ? '▴' : '▾'}`;
      toggle.setAttribute('aria-expanded', String(Boolean(visible)));
      toggle.onclick = () => { recentExpanded = !visible; render(snapshot); };
      nodes.push(toggle);
    } else nodes.push(sectionLabel('最近任务'));
    if (visible) {
      nodes.push(...(showAllRecent ? recent : recent.slice(0, RECENT_ROWS)).map(item => buildTask(item, value)));
      if (recent.length > RECENT_ROWS) {
        const more = document.createElement('button');
        more.className = 'recent-toggle';
        more.textContent = showAllRecent ? '收起列表' : `查看全部（${recent.length}）`;
        more.onclick = () => { showAllRecent = !showAllRecent; render(snapshot); };
        nodes.push(more);
      }
    }
  }
  if (!nodes.length) { const empty = document.createElement('div'); empty.className = 'empty'; empty.textContent = '暂时没有活跃任务'; nodes.push(empty); }
  $('tasks').replaceChildren(...nodes);
  reportState();
}

function showNotice(notice) {
  // The task itself stays on the capsule until handled; the toast only brings the newest one to
  // the front and reveals a docked window for a few seconds.
  toastId = notice.id;
  highlightId = notice.id;
  emptySince = Date.now();
  clearTimeout(toastTimer);
  const expire = () => {
    if (hovered) { toastTimer = setTimeout(expire, 1_000); return; }
    toastId = undefined; render(snapshot);
  };
  toastTimer = setTimeout(expire, TOAST_DURATION);
  if (notice.expand) { toastId = undefined; setExpanded(true); }
  render(snapshot);
}

function updatePinButton() {
  const button = $('pin-expanded');
  if (!button) return;
  button.setAttribute('aria-pressed', String(pinnedExpanded));
  button.title = pinnedExpanded
    ? '已固定展开（点击窗口外不会收起），点击取消固定'
    : '固定展开：点击窗口外也不会收起';
}

function setExpanded(next) {
  if (expanded === next) return;
  expanded = next;
  if (next) { toastId = undefined; clearTimeout(toastTimer); }
  if (!next) { $('feedback').textContent = ''; highlightId = undefined; }
  render(snapshot);
}

// Manual dragging keeps click-to-expand working (app-region drag swallows clicks).
function draggable(element, onClick) {
  element.addEventListener('pointerdown', event => {
    if (event.button !== 0 || event.target.closest('button:not(#capsule)')) return;
    const startX = event.screenX; const startY = event.screenY;
    let dragging = false;
    element.setPointerCapture(event.pointerId);
    const move = e => {
      const dx = e.screenX - startX; const dy = e.screenY - startY;
      if (!dragging && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      if (!dragging) { dragging = true; api.dragPreview?.('start', 0, 0); }
      api.dragPreview?.('move', dx, dy);
    };
    const up = () => {
      element.removeEventListener('pointermove', move);
      element.removeEventListener('pointerup', up);
      element.removeEventListener('pointercancel', up);
      if (dragging) api.dragPreview?.('end', 0, 0);
      else onClick?.();
    };
    element.addEventListener('pointermove', move);
    element.addEventListener('pointerup', up);
    element.addEventListener('pointercancel', up);
  });
}

draggable($('capsule'), () => setExpanded(true));
draggable($('expanded-header'));
$('pin-expanded').onclick = () => {
  pinnedExpanded = !pinnedExpanded;
  updatePinButton();
};
$('collapse').onclick = () => setExpanded(false);
$('mode-toggle').onclick = async () => {
  try { render(await api.setReminderMode(snapshot.preferences?.reminderMode === 'quiet' ? 'pinned' : 'quiet')); }
  catch { $('feedback').textContent = '没能切换模式。'; }
};
$('hide').onclick = () => api.hidePreview?.();
$('open-settings').onclick = () => api.showControlPanel();
document.body.addEventListener('mouseenter', () => { hovered = true; render(snapshot); });
document.body.addEventListener('mouseleave', () => { hovered = false; render(snapshot); });
// Clicking outside the expanded window collapses it unless the user pinned it open.
window.addEventListener('blur', () => {
  if (expanded && !pinnedExpanded) setExpanded(false);
});
updatePinButton();

api.onSnapshot(render);
api.onNotice?.(showNotice);
render(await api.getSnapshot());
setInterval(() => render(snapshot), 10_000);
