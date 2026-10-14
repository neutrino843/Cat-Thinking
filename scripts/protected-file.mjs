import { open, rename, rm } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { dirname, isAbsolute } from 'node:path'

/** Flush the contents before publication; POSIX also flushes the directory entry. */
export async function writeProtectedJson(path, value) {
  if (!isAbsolute(path)) throw new Error('protected_output_path_invalid')
  const serialized = `${JSON.stringify(value)}\n`
  const temporary = `${path}.${randomBytes(16).toString('hex')}.tmp`
  try {
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(serialized)
      await handle.sync()
    } finally { await handle.close() }
    await rename(temporary, path)
    // Windows does not expose portable directory fsync through Node. Its
    // checkpoint supports process interruption; power-loss recovery stays closed
    // if the directory entry was lost. Never replay a missing paid result.
    if (process.platform !== 'win32') {
      const directory = await open(dirname(path), 'r')
      try { await directory.sync() } finally { await directory.close() }
    }
  } finally { await rm(temporary, { force: true }) }
}
