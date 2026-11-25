import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

// Responses arrive in request order. Each helper owns its pending requests, including
// when it exits unexpectedly and a later click starts a replacement.
export function startCodeWindowWorker(executable: string) {
  const child = spawn(executable, ["--serve", "stdin"], { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
  const lines = createInterface({ input: child.stdout });
  const pending: { resolve: (value: string) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }[] = [];
  let closed = false;

  function close(error = new Error("Window helper closed")) {
    if (closed) return;
    closed = true;
    for (const request of pending.splice(0)) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    lines.close();
    child.stdin.destroy();
    child.kill();
  }
  child.once("error", close);
  child.stdin.on("error", close);
  child.once("close", () => close());
  lines.on("line", line => {
    const request = pending.shift();
    if (request) {
      clearTimeout(request.timer);
      request.resolve(line);
    }
  });
  return {
    get closed() { return closed; },
    close,
    focus(project: string): Promise<string> {
      return new Promise((resolve, reject) => {
        if (closed) { reject(new Error("Window helper closed")); return; }
        const timer = setTimeout(() => close(new Error("Window helper timed out")), 8000);
        pending.push({ resolve, reject, timer });
        child.stdin.write(Buffer.from(project, "utf8").toString("base64") + "\n");
      });
    },
  };
}
