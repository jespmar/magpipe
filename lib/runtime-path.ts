/**
 * Paths worked out at run time only (D54): where tools live on the operator's computer, under
 * their home folder or a folder an environment variable names.
 *
 * Next's build traces the files server code may read by evaluating its path expressions. A path
 * built from the home folder or an environment variable becomes a search of folders on the build
 * machine itself, and on Windows that search fails on the protected junctions under AppData
 * (EPERM on "Application Data"), which stops the installer build. Built through these helpers,
 * the tracer sees calls it cannot follow and searches nothing; at run time they are plain
 * `path.join`, `os.homedir()` and `process.env`.
 */
import os from 'node:os';
import path from 'node:path';

/** `path.join` of the parts given, leaving out empty ones. */
export function runtimePath(...parts: (string | undefined)[]): string {
  return path.join(...parts.filter((p): p is string => Boolean(p)));
}

/** The operator's home folder. */
export function homeDir(): string {
  return os.homedir();
}

/** An environment variable, read when called. */
export function envVar(name: string): string | undefined {
  return process.env[name] || undefined;
}
