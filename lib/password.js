import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import { readFileSync, mkdirSync, writeFileSync, renameSync, chmodSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

const derive = promisify(scrypt)
const options = { N: 16384, r: 8, p: 1 }
const file = () => join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'my-remote-password.json')
export const validPassword = value => typeof value === 'string' && value.length > 0

export function loadPassword() {
  try {
    const value = JSON.parse(readFileSync(file(), 'utf8'))
    if (value.version !== 1 || value.algorithm !== 'scrypt' || !/^[a-f0-9]{32}$/.test(value.salt) || !/^[a-f0-9]{128}$/.test(value.hash)) return null
    return { version: 1, algorithm: 'scrypt', salt: value.salt, hash: value.hash }
  } catch { return null }
}

export async function savePassword(password) {
  const salt = randomBytes(16).toString('hex')
  const hash = (await derive(password, salt, 64, options)).toString('hex')
  const record = { version: 1, algorithm: 'scrypt', salt, hash }
  const path = file(), tmp = `${path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    writeFileSync(tmp, JSON.stringify(record, null, 2), { mode: 0o600 })
    chmodSync(tmp, 0o600)
    renameSync(tmp, path)
  } catch (error) {
    try { unlinkSync(tmp) } catch { /* no temporary file */ }
    throw error
  }
  return record
}

export async function verifyPassword(password, record) {
  if (!validPassword(password)) return false
  const hash = await derive(password, record.salt, 64, options)
  return timingSafeEqual(hash, Buffer.from(record.hash, 'hex'))
}

/** Consume the entire body up to a strict byte bound; never retain oversized data. */
export async function readJson(req) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += Buffer.byteLength(chunk)
    if (size <= 4096) chunks.push(Buffer.from(chunk))
  }
  if (size > 4096) throw new Error('body-too-large')
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid-json')
  return value
}

/** Fixed windows, at most 1024 IP buckets + one conservative overflow bucket. */
export function createPairLimiter() {
  const entries = new Map(), windowMs = 5 * 60_000
  const overflow = Symbol('overflow')
  return {
    attempt(req) {
      const now = Date.now()
      for (const [key, entry] of entries) if (entry.until <= now) entries.delete(key)
      const address = String(req.headers['cf-connecting-ip'] ?? req.headers['x-forwarded-for']?.split(',')[0] ?? req.socket.remoteAddress ?? 'unknown').trim().slice(0, 128)
      const key = entries.has(address) || entries.size < 1024 ? address : overflow
      let entry = entries.get(key)
      if (!entry) { entry = { failures: 0, until: now + windowMs }; entries.set(key, entry) }
      if (entry.failures >= 5) return { blocked: true, retryAfter: Math.max(1, Math.ceil((entry.until - now) / 1000)) }
      // Reserve before async scrypt: parallel attempts cannot bypass the bound.
      entry.failures++
      return { blocked: false, success() { if (entries.get(key) === entry) entries.delete(key) } }
    },
  }
}
