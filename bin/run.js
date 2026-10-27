// Child entry that bin/dsh-cli.js starts on a Node with FFI. It runs the dsh
// CLI this package depends on and hands it this package's own pnpm, so
// `dsh plugin` works without pnpm on PATH.

import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { runCli } from '@deepseek-ai/dsh/lib/bin.js'

const require = createRequire(import.meta.url)
// pnpm exports only its manifest.
const manifestPath = require.resolve('pnpm')
const pnpm = join(dirname(manifestPath), require(manifestPath).bin.pnpm)

await runCli({ packageManager: { command: process.execPath, args: [pnpm], env: {} } })
