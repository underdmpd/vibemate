import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { AggregatedSession, EnvironmentView } from "./environment-types.js";

const execFileAsync = promisify(execFile);

export interface FocusCommand {
  command: string;
  args: string[];
}

export interface FocusSessionOptions {
  platform?: NodeJS.Platform;
  activateExisting?: (project: string) => Promise<void>;
  findLocalGitRoot?: (cwd: string) => Promise<string | undefined>;
  runCommand?: (command: string, args: string[], options: { shell: boolean; timeout: number }) => Promise<void>;
}

/**
 * Extracts the most recent working directory reported for a session.
 */
export function sessionCwd(session: Pick<AggregatedSession, "recentEvents">): string | undefined {
  for (let index = session.recentEvents.length - 1; index >= 0; index -= 1) {
    const cwd = session.recentEvents[index]?.cwd;
    if (cwd && cwd.trim()) return cwd.trim();
  }
  return undefined;
}

/**
 * Walks upward from a local directory to find the nearest `.git` entry so that opening a
 * subdirectory in VS Code reuses the existing repository window instead of opening a new one.
 */
export async function findLocalGitRoot(cwd: string): Promise<string | undefined> {
  let current = resolve(cwd);
  for (let depth = 0; depth < 32; depth += 1) {
    try {
      await access(join(current, ".git"));
      return current;
    } catch {
      const parent = dirname(current);
      if (parent === current) return undefined;
      current = parent;
    }
  }
  return undefined;
}

/**
 * Builds the Tier-1 VS Code focus command (`code <path>` / `code --remote wsl+<distro> <path>` /
 * `code --remote ssh-remote+<alias> <path>`).
 * Uses `--reuse-window` omitted intentionally: VS Code focuses an already-open window matching the
 * folder URI when invoked without `-n/--new-window`.
 */
export function buildFocusCommand(
  environment: Pick<EnvironmentView, "kind"> & { distribution?: string; sshHost?: string; sshConnection?: { host: string } },
  folderPath: string,
  platform: NodeJS.Platform = process.platform,
): FocusCommand {
  const command = platform === "win32" ? "code.cmd" : "code";
  if (environment.kind === "wsl") {
    if (!environment.distribution) {
      throw new Error("WSL environment is missing distribution name");
    }
    return {
      command,
      args: ["--remote", `wsl+${environment.distribution}`, folderPath],
    };
  }
  if (environment.kind === "ssh") {
    const target = environment.sshHost || environment.sshConnection?.host;
    if (!target) {
      throw new Error("SSH environment is missing host alias");
    }
    return {
      command,
      args: ["--remote", `ssh-remote+${target}`, folderPath],
    };
  }
  return {
    command,
    args: [folderPath],
  };
}

export class WindowFocusError extends Error {}

async function activateExistingCodeWindow(project: string): Promise<void> {
  // Electron cannot pass a script inside app.asar directly to PowerShell.
  const script = fileURLToPath(new URL("../src/focus-code-window.ps1", import.meta.url)).replace(/\bapp\.asar([\\/])/, "app.asar.unpacked$1");
  const { stdout } = await execFileAsync("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script,
  ], { env: { ...process.env, VIBEMATE_FOCUS_PROJECT: project }, windowsHide: true, timeout: 8000 });
  const result = stdout.trim();
  if (result === "focused") return;
  if (result === "none") throw new WindowFocusError("没有打开的 VS Code 窗口。");
  if (result === "unmatched") throw new WindowFocusError("无法唯一匹配项目窗口，请手动切换。");
  throw new WindowFocusError("Windows 未能将 VS Code 切到前台，请手动切换。");
}

async function defaultRunCommand(
  command: string,
  args: string[],
  options: { shell: boolean; timeout: number },
): Promise<void> {
  await execFileAsync(command, args, {
    shell: options.shell,
    timeout: options.timeout,
    windowsHide: true,
  });
}

/**
 * Tier-1 "one-click go back": brings the matching VS Code window to the front.
 */
export async function focusSessionWindow(
  environment: EnvironmentView,
  session: AggregatedSession,
  options: FocusSessionOptions = {},
): Promise<void> {
  const platform = options.platform ?? process.platform;
  const rawCwd = sessionCwd(session);
  if (platform === "win32" && environment.kind === "windows") {
    const root = rawCwd && await (options.findLocalGitRoot ?? findLocalGitRoot)(rawCwd).catch(() => undefined);
    await (options.activateExisting ?? activateExistingCodeWindow)(basename(root || rawCwd || ""));
    return;
  }
  if (!rawCwd) {
    throw new Error("session has no working directory");
  }

  let targetPath = rawCwd;
  if (environment.kind === "windows") {
    const finder = options.findLocalGitRoot ?? findLocalGitRoot;
    const gitRoot = await finder(rawCwd).catch(() => undefined);
    if (gitRoot) targetPath = gitRoot;
  }

  const focusCmd = buildFocusCommand(environment, targetPath, platform);
  const runner = options.runCommand ?? defaultRunCommand;
  await runner(focusCmd.command, focusCmd.args, {
    shell: platform === "win32",
    timeout: 8_000,
  });

}
