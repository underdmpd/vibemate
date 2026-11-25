#!/usr/bin/env node

import {
  nativeFallback,
  readHookInput,
  resolveAgentSourcePid,
  runHook,
  type HookAgent,
} from "./index.js";

function parseAgent(value: string | undefined): HookAgent | undefined {
  return value === "codex" || value === "copilot" ? value : undefined;
}

function debug(error: unknown): void {
  if (process.env.VIBEMATE_HOOK_DEBUG !== "1") {
    return;
  }
  const message = error instanceof Error ? error.message : "unknown hook error";
  process.stderr.write(`VibeMate hook: ${message}\n`);
}

async function main(): Promise<void> {
  const agent = parseAgent(process.argv[2]);
  if (!agent) {
    debug(new Error("expected agent argument: codex or copilot"));
    return;
  }

  let stdout = nativeFallback(agent);
  try {
    const [input, sourcePid] = await Promise.all([
      readHookInput(process.stdin),
      resolveAgentSourcePid().catch(() => undefined),
    ]);
    const result = await runHook({
      agent,
      input,
      ...(process.argv[3] ? { eventName: process.argv[3] } : {}),
      ...(sourcePid !== undefined ? { sourcePid } : {}),
    });
    stdout = result.stdout;
  } catch (error) {
    debug(error);
  }
  process.stdout.write(stdout);
}

void main().catch(debug);
