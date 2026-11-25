import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  Tray,
  type IpcMainInvokeEvent,
} from "electron";
import { updateMonitorHooks, installCodexHooks, installCopilotHooks } from "@vibemate/hook-installer";
import { discoverSshHosts, discoverWsl } from "./environment-discovery.js";
import { EnvironmentStore } from "./environment-store.js";
import type { DesktopConfiguration, EnvironmentConfig } from "./environment-types.js";
import { ManagedEnvironmentLauncher } from "./managed-environment-launcher.js";
import { ReceiverConnectionManager } from "./receiver-connection-manager.js";
import { ManualSshLauncher } from "./manual-ssh-launcher.js";
import { connectionKey, parseSshCredentials, parseSshDeviceInput, SshConnectionService } from "./ssh-connection.js";
import { configureSshEnvironment, previousFingerprint } from "./ssh-environment-settings.js";
import { PetWindow } from "./pet-window.js";
import { parseReminderState, ReminderWindow } from "./reminder-window.js";
import { WindowPositionStore } from "./window-position.js";
import { describeNotice, TaskNotifier, type TaskNotice } from "./task-notifier.js";
import { SeenSessionStore } from "./seen-store.js";
import { focusSessionWindow, warmCodeWindowHelper, WindowFocusError } from "./focus-session.js";
import { resumeSession } from "./resume-session.js";

const sourceDirectory = fileURLToPath(new URL(".", import.meta.url));
const rendererDirectory = join(sourceDirectory, "../src/renderer");
const preloadPath = join(sourceDirectory, "../src/preload.cjs");

function hookRunnerPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "app", "hook-runner", "cli.js")
    : fileURLToPath(new URL("../../../packages/hook-runner/dist/cli.js", import.meta.url));
}

async function installWindowsHooks(): Promise<void> {
  const options = {
    runnerPath: hookRunnerPath(), nodePath: process.execPath, platform: process.platform,
    electronAsNode: app.isPackaged,
  };
  const results = await Promise.allSettled([installCodexHooks(options), installCopilotHooks(options),
    updateMonitorHooks("claude", "install", options), updateMonitorHooks("antigravity", "install", options)]);
  if (results.every((result) => result.status === "rejected")) {
    const first = results[0];
    throw first?.status === "rejected" ? first.reason : new Error("Agent Hook 安装失败");
  }
  for (const result of results) {
    if (result.status === "rejected") console.error("Optional Agent hook install failed:", result.reason);
  }
}

let configuration: DesktopConfiguration;
let environmentStore: EnvironmentStore;
let seenStore: SeenSessionStore | undefined;
let receiverManager: ReceiverConnectionManager;
const sshConnections = new SshConnectionService(async ({ host, port, fingerprint }) => {
  const options = {
    type: "question" as const,
    title: "确认设备身份",
    message: `首次连接 ${host}:${port}，是否信任这台设备？`,
    detail: `设备指纹：\n${fingerprint}\n\n请与设备管理者核对。确认后将保存此设备身份，身份改变时会停止连接。`,
    buttons: ["取消", "信任并继续"], defaultId: 0, cancelId: 0,
  };
  const result = controlWindow ? await dialog.showMessageBox(controlWindow, options) : await dialog.showMessageBox(options);
  return result.response === 1;
});

let controlWindow: BrowserWindow | undefined;
const positions = new WindowPositionStore(app.getPath("userData"));
const reminder = new ReminderWindow(positions, {
  preload: preloadPath, page: join(rendererDirectory, "preview.html"), onLoad: () => publishSnapshot(),
});
const pet = new PetWindow(positions, {
  preload: preloadPath, page: join(rendererDirectory, "pet.html"), onLoad: () => publishSnapshot(),
});
let tray: Tray | undefined;
let snapshotScheduled = false;
let quitting = false;

function getSnapshot() {
  const base = receiverManager?.getSnapshot() ?? {
    devices: [], environments: [], sessions: [], pendingPermissions: [],
    preferences: { petEnabled: false, showPet: true, showPreview: true, systemNotifications: true, reminderMode: "pinned" as const, focus: { kind: "all" as const } },
    onboardingCompleted: false,
  };
  return seenStore ? { ...base, seenSessions: seenStore.getAll() } : base;
}

function publishSnapshot(): void {
  const snapshot = getSnapshot();
  for (const window of [controlWindow, pet.window, reminder.window]) {
    if (window && !window.isDestroyed()) {
      window.webContents.send("vibemate:snapshot", snapshot);
    }
  }
}

const taskNotifier = new TaskNotifier();
let offlineCheckTimer: NodeJS.Timeout | undefined;

function checkNotices(): void {
  for (const notice of taskNotifier.diff(getSnapshot())) deliverNotice(notice);
}

function scheduleSnapshot(): void {
  if (snapshotScheduled) {
    return;
  }
  snapshotScheduled = true;
  queueMicrotask(() => {
    snapshotScheduled = false;
    publishSnapshot();
    checkNotices();
  });
}

function deliverNotice(notice: TaskNotice): void {
  const window = reminder.window;
  if (window && !window.isDestroyed()) window.webContents.send("vibemate:notice", notice);
  if (!configuration.preferences.systemNotifications || !Notification.isSupported()) return;
  const { title, body } = describeNotice(notice);
  const toast = new Notification({ title, body, silent: notice.kind === "completed" });
  toast.on("click", () => {
    const target = reminder.window;
    if (!target || target.isDestroyed()) return;
    if (!target.isVisible()) togglePreviewWindow();
    target.webContents.send("vibemate:notice", { ...notice, expand: true });
  });
  toast.show();
}

function createControlWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 460,
    height: 600,
    minWidth: 380,
    minHeight: 480,
    show: !configuration?.onboardingCompleted,
    title: "VibeMate 设置",
    icon: createTrayIcon(),
    backgroundColor: "#111827",
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  void window.loadFile(join(rendererDirectory, "index.html"));
  window.webContents.once("did-finish-load", publishSnapshot);
  window.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      window.hide();
    }
  });
  window.on("closed", () => {
    if (controlWindow === window) {
      controlWindow = undefined;
    }
  });
  return window;
}

function togglePreviewWindow(): void {
  const window = reminder.window;
  if (!window) return;
  if (window.isVisible()) window.hide();
  else window.showInactive();
  configuration.preferences.showPreview = window.isVisible();
  void environmentStore.save(configuration).catch((error: unknown) => console.error("Could not save preview preference:", error));
  updateTrayMenu();
}

function showControlWindow(): void {
  if (!controlWindow) {
    controlWindow = createControlWindow();
  }
  controlWindow.show();
  controlWindow.focus();
}

async function setPetEnabled(enabled: boolean): Promise<void> {
  configuration.preferences.petEnabled = enabled;
  if (enabled) {
    configuration.preferences.showPet = true;
    (await pet.create(true)).showInactive();
  } else {
    await pet.destroy();
  }
  await environmentStore.save(configuration);
  receiverManager.setConfiguration(configuration);
  updateTrayMenu();
}

function togglePetWindow(): void {
  const window = pet.window;
  if (!window) {
    return;
  }
  if (window.isVisible()) {
    window.hide();
  } else {
    window.showInactive();
  }
  configuration.preferences.showPet = window.isVisible();
  void environmentStore.save(configuration).catch((error: unknown) => console.error("Could not save pet preference:", error));
  updateTrayMenu();
}

function createTrayIcon() {
  const iconBuffer = readFileSync(join(rendererDirectory, "assets", "tray-icon.png"));
  return nativeImage.createFromBuffer(iconBuffer).resize({ width: 20, height: 20 });
}

function updateTrayMenu(): void {
  if (!tray) {
    return;
  }
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: reminder.window?.isVisible() ? "隐藏悬浮提醒窗" : "显示悬浮提醒窗",
      click: togglePreviewWindow,
    },
    {
      label: "设置…",
      click: showControlWindow,
    },
    ...(pet.window ? [{
      label: pet.window.isVisible() ? "隐藏桌宠" : "显示桌宠",
      click: togglePetWindow,
    }] : []),
    { type: "separator" },
    {
      label: "退出 VibeMate",
      click: () => app.quit(),
    },
  ]));
}

function createTray(): Tray {
  const nextTray = new Tray(createTrayIcon());
  nextTray.setToolTip("VibeMate");
  nextTray.on("click", showControlWindow);
  tray = nextTray;
  updateTrayMenu();
  return nextTray;
}

ipcMain.handle("vibemate:get-snapshot", () => getSnapshot());
ipcMain.on("vibemate:hide-preview", (event) => {
  if (event.sender !== reminder.window?.webContents) return;
  if (reminder.window.isVisible()) togglePreviewWindow();
});
ipcMain.on("vibemate:preview-state", (event, value: unknown) => {
  if (event.sender !== reminder.window?.webContents) return;
  const state = parseReminderState(value);
  if (state) reminder.setState(state);
});
ipcMain.on("vibemate:preview-drag", (event, phase: unknown, dx: unknown, dy: unknown) => {
  if (event.sender !== reminder.window?.webContents) return;
  if ((phase !== "start" && phase !== "move" && phase !== "end")
    || typeof dx !== "number" || typeof dy !== "number" || !Number.isFinite(dx) || !Number.isFinite(dy)) return;
  reminder.drag(phase, dx, dy);
});
ipcMain.on("vibemate:show-control", showControlWindow);
ipcMain.on("vibemate:quit", () => app.quit());
ipcMain.handle("vibemate:scan-environments", async () => {
  const localDevice = configuration.devices.find((device) => device.kind === "local");
  if (!localDevice) throw new Error("local device is missing");
  const [wsl, sshHosts] = await Promise.all([discoverWsl(), discoverSshHosts()]);
  const discovered: EnvironmentConfig[] = [
    ...wsl.map((distribution): EnvironmentConfig => ({
      environmentId: randomUUID(), deviceId: localDevice.deviceId,
      name: `WSL · ${distribution.name}`, kind: "wsl", enabled: false,
      distribution: distribution.name,
    })),
    ...sshHosts.map((sshHost): EnvironmentConfig => {
      let device = configuration.devices.find((item) => item.kind === "remote" && item.name === sshHost);
      if (!device) {
        device = { deviceId: randomUUID(), name: sshHost, kind: "remote" };
        configuration.devices.push(device);
      }
      return { environmentId: randomUUID(), deviceId: device.deviceId, name: sshHost, kind: "ssh", enabled: false, sshHost };
    }),
  ];
  configuration.environments = EnvironmentStore.mergeDiscovered(configuration.environments, discovered);
  receiverManager.setConfiguration(configuration);
  await environmentStore.save(configuration);
  return getSnapshot();
});

ipcMain.handle("vibemate:set-environment-enabled", async (_event, environmentId: unknown, enabled: unknown) => {
  if (typeof environmentId !== "string" || typeof enabled !== "boolean") throw new TypeError("invalid environment setting");
  const environment = configuration.environments.find((item) => item.environmentId === environmentId);
  if (!environment) throw new Error("environment not found");
  if (enabled && environment.kind === "windows") {
    await installWindowsHooks();
    await receiverManager.start(environmentId, true);
  }
  if (!enabled) await receiverManager.stop(environmentId);
  environment.enabled = enabled;
  configuration.onboardingCompleted = true;
  await environmentStore.save(configuration);
  receiverManager.setConfiguration(configuration);
  return getSnapshot();
});

ipcMain.handle("vibemate:start-environment", async (_event, environmentId: unknown) => {
  if (typeof environmentId !== "string") throw new TypeError("invalid environment id");
  await receiverManager.start(environmentId, true);
  const environment = configuration.environments.find((item) => item.environmentId === environmentId);
  if (environment) {
    environment.enabled = true;
    configuration.onboardingCompleted = true;
    await environmentStore.save(configuration);
    receiverManager.setConfiguration(configuration);
  }
  return getSnapshot();
});

ipcMain.handle("vibemate:stop-environment", async (_event, environmentId: unknown) => {
  if (typeof environmentId !== "string") throw new TypeError("invalid environment id");
  await receiverManager.stop(environmentId);
  const environment = configuration.environments.find((item) => item.environmentId === environmentId);
  if (environment?.kind !== "ssh" && environment) {
    environment.enabled = false;
    await environmentStore.save(configuration);
    receiverManager.setConfiguration(configuration);
  }
  return getSnapshot();
});

ipcMain.handle("vibemate:add-ssh-environment", async (_event, value: unknown) => {
  if (typeof value !== "string" || !/^[a-zA-Z0-9._-]{1,255}$/.test(value)) {
    throw new TypeError("请输入 ~/.ssh/config 中的主机别名");
  }
  let device = configuration.devices.find((item) => item.kind === "remote" && item.name === value);
  if (!device) {
    device = { deviceId: randomUUID(), name: value, kind: "remote" };
    configuration.devices.push(device);
  }
  if (!configuration.environments.some((item) => item.kind === "ssh" && item.sshHost.toLowerCase() === value.toLowerCase())) {
    configuration.environments.push({ environmentId: randomUUID(), deviceId: device.deviceId, name: value, kind: "ssh", enabled: false, sshHost: value });
  }
  await environmentStore.save(configuration);
  receiverManager.setConfiguration(configuration);
  return getSnapshot();
});

function settingsInput(event: IpcMainInvokeEvent, value: unknown): Record<string, unknown> {
  if (!controlWindow || event.sender !== controlWindow.webContents) throw new Error("请从 VibeMate 设置页配置设备");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("设备信息格式不正确");
  return value as Record<string, unknown>;
}

ipcMain.handle("vibemate:pick-private-key", async (event) => {
  settingsInput(event, {});
  const result = await dialog.showOpenDialog(controlWindow!, { title: "选择 SSH 私钥文件", properties: ["openFile"] });
  return result.canceled ? undefined : result.filePaths[0];
});

ipcMain.handle("vibemate:test-ssh-connection", async (event, value: unknown) => {
  const input = settingsInput(event, value);
  const profile = parseSshDeviceInput(input.profile);
  if (input.environmentId !== undefined && typeof input.environmentId !== "string") throw new TypeError("设备编号不正确");
  const existing = configuration.environments.find(item => input.environmentId
    ? item.environmentId === input.environmentId
    : item.kind === "ssh" && item.sshConnection?.host.toLowerCase() === profile.host.toLowerCase() && item.sshConnection.port === profile.port);
  if (input.environmentId && existing?.kind !== "ssh") throw new Error("设备不存在，请刷新设置后重试");
  return sshConnections.test(profile, parseSshCredentials(input.credentials), previousFingerprint(existing?.kind === "ssh" ? existing : undefined, profile));
});

ipcMain.handle("vibemate:save-ssh-environment", async (event, value: unknown) => {
  const input = settingsInput(event, value);
  const profile = parseSshDeviceInput(input.profile);
  if (input.environmentId !== undefined && typeof input.environmentId !== "string") throw new TypeError("设备编号不正确");
  if (input.verificationId !== undefined && typeof input.verificationId !== "string") throw new TypeError("连接检查编号不正确");
  const existing = configuration.environments.find(item => input.environmentId
    ? item.environmentId === input.environmentId
    : item.kind === "ssh" && item.sshConnection?.host.toLowerCase() === profile.host.toLowerCase()
      && item.sshConnection.port === profile.port && item.sshConnection.username === profile.username);
  const view = receiverManager.getSnapshot().environments.find(item => item.environmentId === existing?.environmentId);
  if (view?.status === "connected" || view?.status === "starting") throw new Error("请先停止该设备监控，再修改连接信息");
  const verified = input.verificationId ? sshConnections.takeVerification(input.verificationId, profile) : undefined;
  const next = configureSshEnvironment(configuration, profile, verified?.connection, input.environmentId as string | undefined);
  await environmentStore.save(next.configuration);
  if (existing) await receiverManager.stop(existing.environmentId);
  if (existing?.kind === "ssh" && existing.sshConnection
    && connectionKey(existing.sshConnection) !== connectionKey(next.environment.sshConnection!)) sshConnections.forget(existing.sshConnection);
  if (verified) sshConnections.remember(next.environment.sshConnection!, verified.credentials);
  configuration = next.configuration;
  receiverManager.setConfiguration(configuration);
  return { snapshot: getSnapshot(), environmentId: next.environment.environmentId };
});

ipcMain.handle("vibemate:remove-ssh-environment", async (event, environmentId: unknown) => {
  settingsInput(event, {});
  if (typeof environmentId !== "string") throw new TypeError("设备编号不正确");
  const environment = configuration.environments.find(item => item.environmentId === environmentId);
  if (environment?.kind !== "ssh") throw new Error("设备不存在，请刷新设置后重试");
  const answer = await dialog.showMessageBox(controlWindow!, {
    type: "question", title: "移除设备配置", message: `从 VibeMate 移除“${environment.name}”的连接配置？`,
    detail: "将停止此设备监控并移除本次保存的登录凭证。设备上的接收端文件和 Agent Hook 会保留，你可以稍后重新添加设备。",
    buttons: ["取消", "移除配置"], defaultId: 0, cancelId: 0,
  });
  if (answer.response !== 1) return getSnapshot();
  await receiverManager.stop(environmentId);
  const next = structuredClone(configuration);
  next.environments = next.environments.filter(item => item.environmentId !== environmentId);
  if (!next.environments.some(item => item.deviceId === environment.deviceId)) next.devices = next.devices.filter(item => item.deviceId !== environment.deviceId);
  await environmentStore.save(next);
  if (environment.sshConnection) {
    sshConnections.forget(environment.sshConnection);
    if (!next.environments.some(item => item.kind === "ssh"
      && item.sshConnection?.host.toLowerCase() === environment.sshConnection!.host.toLowerCase()
      && item.sshConnection.port === environment.sshConnection!.port)) sshConnections.forgetHost(environment.sshConnection);
  }
  configuration = next; receiverManager.setConfiguration(configuration);
  return getSnapshot();
});

ipcMain.handle("vibemate:set-system-notifications", async (event, enabled: unknown) => {
  settingsInput(event, {});
  if (typeof enabled !== "boolean") throw new TypeError("invalid notification setting");
  configuration.preferences.systemNotifications = enabled;
  await environmentStore.save(configuration);
  receiverManager.setConfiguration(configuration);
  return getSnapshot();
});

ipcMain.handle("vibemate:set-reminder-mode", async (event, mode: unknown) => {
  // Reachable from both the settings page and the reminder window's own footer.
  if (event.sender !== reminder.window?.webContents) settingsInput(event, {});
  if (mode !== "pinned" && mode !== "quiet") throw new TypeError("invalid reminder mode");
  configuration.preferences.reminderMode = mode;
  await environmentStore.save(configuration);
  receiverManager.setConfiguration(configuration);
  return getSnapshot();
});

ipcMain.handle("vibemate:set-pet-enabled", async (event, enabled: unknown) => {
  settingsInput(event, {});
  if (typeof enabled !== "boolean") throw new TypeError("invalid pet setting");
  await setPetEnabled(enabled);
  return getSnapshot();
});

ipcMain.handle("vibemate:mark-session-seen", async (event, key: unknown, mark: unknown) => {
  if (event.sender !== reminder.window?.webContents) throw new Error("unauthorized");
  if (typeof key !== "string" || !key || typeof mark !== "string" || !mark) {
    throw new TypeError("invalid seen mark");
  }
  await seenStore?.markSeen(key, mark);
  publishSnapshot();
  return getSnapshot();
});

ipcMain.handle("vibemate:focus-session", async (event, identity: unknown, action?: unknown) => {
  if (event.sender !== reminder.window?.webContents && event.sender !== controlWindow?.webContents) {
    throw new Error("unauthorized");
  }
  if (
    !identity
    || typeof identity !== "object"
    || !("environmentId" in identity)
    || !("agent" in identity)
    || !("sessionId" in identity)
    || typeof identity.environmentId !== "string"
    || (identity.agent !== "codex" && identity.agent !== "copilot" && identity.agent !== "claude" && identity.agent !== "antigravity")
    || typeof identity.sessionId !== "string"
  ) {
    throw new TypeError("invalid session identity");
  }
  const snapshot = getSnapshot();
  const environment = snapshot.environments.find((item) => item.environmentId === identity.environmentId);
  const session = snapshot.sessions.find((item) => (
    item.environmentId === identity.environmentId
    && item.agent === identity.agent
    && item.sessionId === identity.sessionId
  ));
  if (!environment || !session) {
    throw new Error("session not found");
  }
  try {
    if (action === "resume") await resumeSession(environment, session);
    else await focusSessionWindow(environment, session);
  } catch (error) {
    if (error instanceof WindowFocusError) return error.message;
    throw error;
  }
});

ipcMain.handle("vibemate:set-focus", async (_event, focus: unknown) => {
  if (!focus || typeof focus !== "object" || !("kind" in focus)
    || !["all", "device", "environment", "project", "session"].includes(String(focus.kind))
    || (focus.kind !== "all" && (!("id" in focus) || typeof focus.id !== "string"))) {
    throw new TypeError("invalid pet focus");
  }
  const focusValue = focus as { kind: "all" | "device" | "environment" | "project" | "session"; id?: string };
  configuration.preferences.focus = focusValue.kind === "all"
    ? { kind: "all" }
    : { kind: focusValue.kind, id: focusValue.id as string };
  await environmentStore.save(configuration);
  receiverManager.setConfiguration(configuration);
  return getSnapshot();
});

async function startDesktop(): Promise<void> {
  // Windows only shows toasts for apps with an AppUserModelID matching the installer's appId.
  if (process.platform === "win32") app.setAppUserModelId("com.dfrobot.vibemate");
  await app.whenReady();
  warmCodeWindowHelper();
  try {
    environmentStore = new EnvironmentStore(join(app.getPath("userData"), "environments.json"), hostname());
    seenStore = new SeenSessionStore(join(app.getPath("userData"), "seen-sessions.json"));
    [configuration] = await Promise.all([environmentStore.load(), seenStore.load()]);
    const payloadRoot = app.isPackaged
      ? join(process.resourcesPath, "linux-payload")
      : fileURLToPath(new URL("../../../build/linux-payload", import.meta.url));
    receiverManager = new ReceiverConnectionManager(configuration, new ManagedEnvironmentLauncher(payloadRoot, new ManualSshLauncher(payloadRoot, sshConnections)), (error) => {
      console.error("Environment Receiver error:", error.message);
    });
    receiverManager.subscribe(scheduleSnapshot);
    offlineCheckTimer = setInterval(() => {
      checkNotices();
    }, 5_000);
    offlineCheckTimer.unref();
    const local = configuration.environments.find((environment) => environment.kind === "windows" && environment.enabled);
    if (local) {
      await installWindowsHooks();
      await receiverManager.start(local.environmentId);
    }
    if (process.platform === "win32") {
      const runningWsl = new Set((await discoverWsl()).filter((item) => item.running).map((item) => item.name.toLowerCase()));
      const enabledRunning = configuration.environments.filter((environment) => (
        environment.kind === "wsl" && environment.enabled && runningWsl.has(environment.distribution.toLowerCase())
      ));
      await Promise.allSettled(enabledRunning.map((environment) => receiverManager.start(environment.environmentId)));
    }
    controlWindow = createControlWindow();
    if (configuration.preferences.petEnabled) await pet.create(configuration.preferences.showPet);
    await reminder.create(configuration.preferences.showPreview);
    createTray();
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown startup error";
    console.error(`VibeMate desktop failed to start: ${message}`);
    app.exit(1);
  }
}

void startDesktop();

app.on("activate", () => {
  showControlWindow();
});

let stopping = false;
app.on("before-quit", (event) => {
  if (stopping) {
    return;
  }
  event.preventDefault();
  stopping = true;
  quitting = true;
  void (async () => {
    try {
      await pet.save();
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown position save error";
      console.error(`Could not save pet position during shutdown: ${message}`);
    }
    if (offlineCheckTimer) {
      clearInterval(offlineCheckTimer);
      offlineCheckTimer = undefined;
    }
    try {
      await receiverManager?.stopAll(3_000);
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown shutdown error";
      console.error(`VibeMate desktop shutdown failed: ${message}`);
    }
    sshConnections.clear();
    app.quit();
  })();
});
