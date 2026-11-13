import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import process from "node:process";

/** A generator that runs longer than this is stuck. */
const TIMEOUT_MS = 60_000;

export interface GeneratorResult {
  code: number;
  output: string;
  /** The executable was not found. */
  missing: boolean;
}

const isFile = (path: string) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/**
 * A bare command name is looked up in PATH only. The process runs in the folder of the .driver file, which Windows
 * would search first: a program placed next to the definition must never be picked up that way.
 */
export function resolveExecutable(executable: string): string | undefined {
  if (isAbsolute(executable) || /[\\/]/.test(executable)) {
    return executable;
  }
  const extensions =
    process.platform === "win32" ? ["", ...(process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")] : [""];
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (directory === "") {
      continue; // An empty entry stands for the current folder.
    }
    for (const extension of extensions) {
      const candidate = join(directory, executable + extension);
      if (isFile(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

/** Run indigo_generator on a definition file. The generator writes its output next to the definition. */
export function runGenerator(executable: string, file: string, cwd: string): Promise<GeneratorResult> {
  const resolved = resolveExecutable(executable);
  if (!resolved) {
    return Promise.resolve({ code: 1, output: `'${executable}' was not found in PATH`, missing: true });
  }
  return new Promise((resolve) => {
    execFile(resolved, [file], { cwd, timeout: TIMEOUT_MS }, (error, stdout, stderr) => {
      const failure = error as (NodeJS.ErrnoException & { code?: number | string }) | null;
      const text = `${stdout}${stderr}`;
      resolve({
        code: failure ? (typeof failure.code === "number" ? failure.code : 1) : 0,
        output: failure && text.trim() === "" ? failure.message : text,
        missing: failure?.code === "ENOENT",
      });
    });
  });
}
