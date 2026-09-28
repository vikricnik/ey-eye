/**
 * Commands that moved when related ones were grouped under one word
 * (/pipeline …, /test …, /settings …, /preset …). Typing an old name says
 * where it went instead of "unknown command".
 */
const RENAMED: Record<string, string> = {
  "/pipelines": "/pipeline list",
  "/delete": "/pipeline rm <name>",
  "/tests": "/test (and /test run [case] runs them)",
  "/pset": "/settings set <setting> <value>",
  "/library": "/preset",
  "/nodes": "/node",
};

/** "/x is now /y" when `line` starts with a renamed command, else undefined. */
export function renamedCommandHint(line: string): string | undefined {
  const command = line.split(/\s+/, 1)[0]!;
  const replacement = RENAMED[command];
  return replacement === undefined ? undefined : `${command} is now ${replacement}`;
}
