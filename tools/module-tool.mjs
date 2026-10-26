#!/usr/bin/env node
import { runModuleTool } from '../packages/module-tools/dist/module-tool.mjs'
runModuleTool(process.argv.slice(2)).then((result) => console.log(JSON.stringify(result, null, 2)), (error) => {
  console.error(JSON.stringify({ status: 'failed', message: error.message })); process.exitCode = 1
})
