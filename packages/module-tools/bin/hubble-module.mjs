#!/usr/bin/env node
import { runModuleTool } from "../dist/module-tool.mjs";
try {
  console.log(
    JSON.stringify(await runModuleTool(process.argv.slice(2)), null, 2),
  );
} catch (error) {
  console.error(JSON.stringify({ status: "failed", message: error.message }));
  process.exitCode = 1;
}
