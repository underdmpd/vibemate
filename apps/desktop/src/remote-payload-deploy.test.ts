import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import test from "node:test";
import { REMOTE_PAYLOAD_DEPLOY_COMMAND } from "./remote-payload-deploy.js";

async function runDeploy(sourceDir: string, homeDir: string): Promise<void> {
  const archive = spawn("tar", ["-cf", "-", "-C", sourceDir, "."], { stdio: ["ignore", "pipe", "pipe"] });
  const target = spawn("sh", ["-c", REMOTE_PAYLOAD_DEPLOY_COMMAND], {
    env: { ...process.env, HOME: homeDir },
    stdio: ["pipe", "ignore", "pipe"],
  });
  let stderr = "";
  target.stderr.setEncoding("utf8");
  target.stderr.on("data", (chunk: string) => { stderr += chunk; });
  await Promise.all([
    pipeline(archive.stdout, target.stdin),
    new Promise<void>((resolve, reject) => {
      archive.once("error", reject);
      archive.once("exit", code => code === 0 ? resolve() : reject(new Error(`tar exited ${code}`)));
    }),
    new Promise<void>((resolve, reject) => {
      target.once("error", reject);
      target.once("exit", code => code === 0 ? resolve() : reject(new Error(`deploy exited ${code}: ${stderr}`)));
    }),
  ]);
}

test("remote payload deploy stages non-executable archives, restores 0700, and keeps node executable during redeploy", { skip: process.platform === "win32" }, async t => {
  const dir = await mkdtemp(join(tmpdir(), "vibemate-deploy-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const home = join(dir, "home");
  const payload = join(dir, "payload");
  await mkdir(join(payload, "runtime"), { recursive: true });
  await mkdir(join(payload, "app", "hook-runner", "dist"), { recursive: true });
  await mkdir(join(payload, "app", "receiver", "dist"), { recursive: true });

  const stubNode = "#!/bin/sh\necho ok\n";
  await writeFile(join(payload, "runtime", "node"), stubNode, "utf8");
  // Simulate Windows tar stripping POSIX +x bits from NTFS files.
  await chmod(join(payload, "runtime", "node"), 0o644);
  await writeFile(join(payload, "app", "package.json"), '{"type":"module"}\n', "utf8");
  await writeFile(join(payload, "app", "hook-runner", "dist", "cli.js"), "// v1\n", "utf8");
  await writeFile(join(payload, "app", "receiver", "dist", "cli.js"), "// receiver\n", "utf8");

  await runDeploy(payload, home);

  const deployedNode = join(home, ".vibemate", "runtime", "node");
  const deployedHook = join(home, ".vibemate", "app", "hook-runner", "dist", "cli.js");
  assert.equal((await stat(deployedNode)).mode & 0o777, 0o700);
  await access(deployedNode, constants.X_OK);
  assert.equal(await readFile(deployedHook, "utf8"), "// v1\n");
  assert.deepEqual((await readdir(join(home, ".vibemate"))).sort(), ["app", "runtime"]);

  // Redeploy with a larger non-executable payload while repeatedly probing X_OK on the live node path.
  await writeFile(join(payload, "runtime", "node"), `${stubNode}# ${"x".repeat(4 * 1024 * 1024)}\n`, "utf8");
  await chmod(join(payload, "runtime", "node"), 0o644);
  await writeFile(join(payload, "app", "hook-runner", "dist", "cli.js"), "// v2\n", "utf8");

  let deploying = true;
  let probes = 0;
  const probeErrors: string[] = [];
  const probeLoop = (async () => {
    while (deploying) {
      probes++;
      try {
        await access(deployedNode, constants.X_OK);
      } catch (error) {
        probeErrors.push(error instanceof Error ? error.message : String(error));
      }
      await new Promise(resolve => setImmediate(resolve));
    }
  })();

  try {
    await runDeploy(payload, home);
  } finally {
    deploying = false;
    await probeLoop;
  }

  assert.ok(probes > 0);
  assert.deepEqual(probeErrors, []);
  assert.equal((await stat(deployedNode)).mode & 0o777, 0o700);
  assert.equal(await readFile(deployedHook, "utf8"), "// v2\n");
  assert.deepEqual((await readdir(join(home, ".vibemate"))).sort(), ["app", "runtime"]);
});

test("remote payload deploy cleans up its staging directory when archive extraction fails", { skip: process.platform === "win32" }, async t => {
  const dir = await mkdtemp(join(tmpdir(), "vibemate-deploy-fail-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const home = join(dir, "home");

  const target = spawn("sh", ["-c", REMOTE_PAYLOAD_DEPLOY_COMMAND], {
    env: { ...process.env, HOME: home },
    stdio: ["pipe", "ignore", "pipe"],
  });
  target.stdin.end("not a valid tar archive");
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    target.once("error", reject);
    target.once("exit", resolve);
  });

  assert.notEqual(exitCode, 0);
  assert.deepEqual((await readdir(join(home, ".vibemate"))).sort(), ["app", "runtime"]);
});
