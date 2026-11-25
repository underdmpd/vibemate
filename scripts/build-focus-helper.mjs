import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Windows ships the .NET Framework compiler. Other build hosts retain the PowerShell fallback.
if (process.platform === "win32") {
  const framework = join(process.env.SystemRoot, "Microsoft.NET");
  const compiler = ["Framework64", "Framework"].map(dir => join(framework, dir, "v4.0.30319", "csc.exe")).find(existsSync);
  if (!compiler) throw new Error("Cannot find the Windows .NET Framework C# compiler");
  const desktop = fileURLToPath(new URL("../apps/desktop/", import.meta.url));
  mkdirSync(join(desktop, "dist"), { recursive: true });
  execFileSync(compiler, ["/nologo", "/optimize+", "/platform:anycpu", "/target:exe",
    "/out:" + join(desktop, "dist", "FocusCodeWindow.exe"), join(desktop, "src", "FocusCodeWindow.cs")], { stdio: "inherit" });
}
