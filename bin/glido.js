#!/usr/bin/env node

import { run } from '../src/cli.js'

run(process.argv.slice(2)).catch((error) => {
  if (error?.name === 'AbortError' || error?.message === 'Aborted with Ctrl+C') {
    console.log('\nSee you next prompt.')
    return
  }
  console.error(`\nGlido error: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
