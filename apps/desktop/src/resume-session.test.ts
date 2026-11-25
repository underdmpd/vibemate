import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { resumeTerminalArgs } from "./resume-session.js";

const id = "10b010b0-0000-4000-a000-000000000001";

test("resume requires an exact session ID", () => {
  for (const invalid of ["", "latest", "--last", id.slice(0, 8)]) {
    assert.throws(() => resumeTerminalArgs("codex", invalid, "C:\\work"), /ID/);
  }
});

test("terminal launcher passes original directory and exact resume arguments to each CLI", {
  skip: process.platform !== "win32",
}, async context => {
  const root = await mkdtemp(join(tmpdir(), "vibemate-resume-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, "项目 [test]; O'Brien");
  await mkdir(project);
  for (const agent of ["codex", "copilot"] as const) {
    const log = join(root, agent + ".json");
    const stub = join(root, agent + ".cmd");
    await writeFile(stub, '@echo off\r\nnode "%~dp0capture.cjs" %*\r\n');
    await writeFile(join(root, "capture.cjs"), 'require("node:fs").writeFileSync(process.env.RESUME_LOG,JSON.stringify([process.cwd(),process.argv.slice(2)]))');
    const args = resumeTerminalArgs(agent, id, project);
    assert.deepEqual(args.slice(0, 4), ["-w", "0", "new-tab", "powershell.exe"]);
    // Use one PATH spelling on Windows, where environment keys are case-insensitive.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "path"));
    await promisify(execFile)("powershell.exe", args.slice(4), {
      env: { ...env, PATH: root + ";" + process.env.PATH, RESUME_LOG: log }, timeout: 10000, windowsHide: true,
    });
    assert.deepEqual(JSON.parse(await readFile(log, "utf8")), [project, agent === "codex" ? ["resume", id] : ["--resume=" + id]]);
  }
});
