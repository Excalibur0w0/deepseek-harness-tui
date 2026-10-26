/**
 * System clipboard reads for Ctrl+V, following opencode's `clipboard.ts`:
 * `osascript` on macOS, `wl-paste` or `xclip` on Linux, and PowerShell on
 * Windows and WSL. A missing tool or an empty clipboard reads as undefined.
 */

import { spawn } from 'node:child_process'
import { readFile, rm } from 'node:fs/promises'
import { platform, release, tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Run a command and collect its stdout.
 * @param {string} command - executable name.
 * @param {string[]} args - arguments.
 * @returns {Promise<Buffer>} stdout; rejects on a spawn failure or a nonzero exit.
 */
function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'] })
    const output = []
    child.on('error', reject)
    child.stdout.on('data', chunk => output.push(chunk))
    child.on('close', code => {
      if (code === 0) resolve(Buffer.concat(output))
      else reject(new Error(`${command} exited with code ${code}`))
    })
  })
}

/**
 * @param {string} command - executable name.
 * @param {string[]} args - arguments.
 * @returns {Promise<Buffer>} stdout, or an empty buffer when the command fails.
 */
function attempt(command, args) {
  return run(command, args).catch(() => Buffer.alloc(0))
}

const WINDOWS_IMAGE = '$img = [System.Windows.Forms.Clipboard]::GetImage(); if ($img) { $ms = New-Object System.IO.MemoryStream; $img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); [System.Convert]::ToBase64String($ms.ToArray()) }'

/**
 * Read an image from the clipboard as PNG.
 * @returns {Promise<Buffer | undefined>} the PNG bytes, or undefined when the clipboard holds no image.
 */
export async function readClipboardImage() {
  const os = platform()
  if (os === 'darwin') {
    const file = join(tmpdir(), `dsh-tui-clipboard-${process.pid}.png`)
    try {
      await run('osascript', [
        '-e', 'set imageData to the clipboard as «class PNGf»',
        '-e', `set fileRef to open for access POSIX file "${file}" with write permission`,
        '-e', 'set eof fileRef to 0',
        '-e', 'write imageData to fileRef',
        '-e', 'close access fileRef',
      ])
      const data = await readFile(file)
      return data.length > 0 ? data : undefined
    } catch {
      // No PNG on the clipboard: AppleScript cannot coerce it, so there is no image to paste.
      return undefined
    } finally {
      await rm(file, { force: true })
    }
  }
  if (os === 'win32' || release().includes('WSL')) {
    const encoded = await attempt('powershell.exe', ['-NonInteractive', '-NoProfile', '-Command', `Add-Type -AssemblyName System.Windows.Forms; ${WINDOWS_IMAGE}`])
    const data = Buffer.from(encoded.toString().trim(), 'base64')
    return data.length > 0 ? data : undefined
  }
  if (os === 'linux') {
    const wayland = await attempt('wl-paste', ['-t', 'image/png'])
    if (wayland.length > 0) return wayland
    const x11 = await attempt('xclip', ['-selection', 'clipboard', '-t', 'image/png', '-o'])
    if (x11.length > 0) return x11
  }
  return undefined
}

/**
 * Read text from the clipboard.
 * @returns {Promise<string | undefined>} the text, or undefined when there is none.
 */
export async function readClipboardText() {
  const os = platform()
  let output = Buffer.alloc(0)
  if (os === 'darwin') output = await attempt('pbpaste', [])
  else if (os === 'win32' || release().includes('WSL')) output = await attempt('powershell.exe', ['-NonInteractive', '-NoProfile', '-Command', 'Get-Clipboard -Raw'])
  else if (os === 'linux') {
    output = await attempt('wl-paste', ['--no-newline'])
    if (output.length === 0) output = await attempt('xclip', ['-selection', 'clipboard', '-o'])
  }
  const text = output.toString('utf8')
  return text === '' ? undefined : text
}
