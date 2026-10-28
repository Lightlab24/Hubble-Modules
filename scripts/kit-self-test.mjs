import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";

const expectedStatuses = {
  create: "created",
  build: "built",
  test: "passed",
  validate: "valid",
  pack: "valid",
  inspect: "valid",
};

export function runKitCommand(tool, args, cwd) {
  const expected = expectedStatuses[args[0]];
  if (!expected) throw Error(`Unknown kit self-test command: ${args[0]}`);
  // Node resolves the entry URL through symlinks; pass the same canonical path
  // so the portable CLI's direct-entry check actually executes on macOS.
  const output = execFileSync(process.execPath, [realpathSync(tool), ...args], {
    cwd,
    timeout: 60_000,
    encoding: "utf8",
    stdio: "pipe",
  });
  let result;
  try {
    result = JSON.parse(output);
  } catch {
    throw Error(`Kit self-test ${args[0]} did not return a JSON result`);
  }
  if (result?.status !== expected)
    throw Error(`Kit self-test ${args[0]} did not return status ${expected}`);
  return result;
}
