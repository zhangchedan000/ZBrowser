import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { appendFile, lstat, mkdir, open, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { once } from 'node:events'
import { dirname, resolve, sep } from 'node:path'
import { PassThrough } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const MAGIC = Buffer.concat([Buffer.from('ZBTEAMSYNC'), Buffer.from([1])])
const AUTH_TAG_BYTES = 16
const MAX_HEADER_BYTES = 16 * 1024
const MAX_RECORD_HEADER_BYTES = 16 * 1024
const MAX_FILES = 1_000_000
const MAX_BYTES = 500 * 1024 * 1024 * 1024

interface ArchiveHeader {
  schemaVersion: 1
  cipher: 'aes-256-gcm'
  nonce: string
}

interface RecordHeader {
  type: 'file' | 'end'
  path?: string
  size?: number
  fileCount?: number
  totalBytes?: number
  contentSha256?: string
}

async function writeChunk(stream: PassThrough, chunk: Buffer): Promise<void> {
  if (!stream.write(chunk)) await once(stream, 'drain')
}

async function writeRecord(stream: PassThrough, record: RecordHeader): Promise<void> {
  const bytes = Buffer.from(JSON.stringify(record))
  if (bytes.length > MAX_RECORD_HEADER_BYTES) throw new Error('团队同步记录头过大')
  const length = Buffer.allocUnsafe(4)
  length.writeUInt32BE(bytes.length)
  await writeChunk(stream, length)
  await writeChunk(stream, bytes)
}

async function *safeFiles(root: string): AsyncGenerator<{ source: string; path: string; size: number }> {
  const visit = async function *(current: string, rel: string): AsyncGenerator<{ source: string; path: string; size: number }> {
    const info = await lstat(current)
    if (info.isSymbolicLink()) throw new Error(`团队同步数据包含符号链接：${rel || '.'}`)
    if (info.isDirectory()) {
      for (const entry of (await readdir(current)).sort()) yield *visit(`${current}${sep}${entry}`, rel ? `${rel}/${entry}` : entry)
    } else if (info.isFile()) {
      if (!rel || rel.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error('团队同步数据路径无效')
      yield { source: current, path: rel, size: info.size }
    }
  }
  yield *visit(root, '')
}

function safeOutputPath(root: string, value: string): string {
  if (!value || value.startsWith('/') || value.includes('\\') || value.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('团队同步包包含不安全路径')
  }
  const target = resolve(root, ...value.split('/'))
  const normalizedRoot = resolve(root)
  if (!target.startsWith(`${normalizedRoot}${sep}`)) throw new Error('团队同步包路径越界')
  return target
}

class Reader {
  private readonly iterator: AsyncIterator<Buffer | string>
  private buffer: Buffer = Buffer.alloc(0)
  constructor(stream: NodeJS.ReadableStream & AsyncIterable<Buffer | string>) { this.iterator = stream[Symbol.asyncIterator]() }

  async exact(size: number): Promise<Buffer> {
    while (this.buffer.length < size) {
      const next = await this.iterator.next()
      if (next.done) throw new Error('团队同步包数据提前结束')
      const chunk = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value)
      this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk
    }
    const out = this.buffer.subarray(0, size)
    this.buffer = this.buffer.subarray(size)
    return out
  }

  async copy(size: number, target: string, digest: ReturnType<typeof createHash>): Promise<void> {
    await mkdir(dirname(target), { recursive: true })
    const output = createWriteStream(target, { flags: 'wx', mode: 0o600 })
    let remaining = size
    try {
      while (remaining > 0) {
        if (!this.buffer.length) {
          const next = await this.iterator.next()
          if (next.done) throw new Error('团队同步包文件数据提前结束')
          this.buffer = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value)
        }
        const length = Math.min(remaining, this.buffer.length)
        const chunk = this.buffer.subarray(0, length)
        this.buffer = this.buffer.subarray(length)
        digest.update(chunk)
        remaining -= length
        if (!output.write(chunk)) await once(output, 'drain')
      }
      output.end()
      await once(output, 'finish')
    } catch (error) {
      output.destroy()
      await rm(target, { force: true })
      throw error
    }
  }
}

async function readRecord(reader: Reader): Promise<RecordHeader> {
  const length = (await reader.exact(4)).readUInt32BE()
  if (length <= 0 || length > MAX_RECORD_HEADER_BYTES) throw new Error('团队同步记录头无效')
  try { return JSON.parse((await reader.exact(length)).toString('utf8')) as RecordHeader } catch { throw new Error('团队同步记录头损坏') }
}

export async function encryptTeamSyncDirectory(sourceRoot: string, destination: string, key: Buffer): Promise<void> {
  if (key.length !== 32) throw new Error('团队同步加密密钥无效')
  const nonce = randomBytes(12)
  const header: ArchiveHeader = { schemaVersion: 1, cipher: 'aes-256-gcm', nonce: nonce.toString('base64') }
  const headerBytes = Buffer.from(JSON.stringify(header))
  const headerLength = Buffer.allocUnsafe(4)
  headerLength.writeUInt32BE(headerBytes.length)
  const staging = destination + '.partial'
  await mkdir(dirname(destination), { recursive: true })
  await writeFile(staging, Buffer.concat([MAGIC, headerLength, headerBytes]), { mode: 0o600 })
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(headerBytes)
  const input = new PassThrough()
  const completion = pipeline(input, cipher, createWriteStream(staging, { flags: 'a', mode: 0o600 }))
  const digest = createHash('sha256')
  let fileCount = 0
  let totalBytes = 0
  try {
    for await (const file of safeFiles(sourceRoot)) {
      fileCount += 1
      totalBytes += file.size
      if (fileCount > MAX_FILES || totalBytes > MAX_BYTES) throw new Error('团队同步数据超过安全限制')
      await writeRecord(input, { type: 'file', path: file.path, size: file.size })
      digest.update(file.path).update('\0').update(String(file.size)).update('\0')
      for await (const chunk of createReadStream(file.source)) {
        digest.update(chunk as Buffer)
        await writeChunk(input, chunk as Buffer)
      }
    }
    await writeRecord(input, { type: 'end', fileCount, totalBytes, contentSha256: digest.digest('hex') })
    input.end()
    await completion
    await appendFile(staging, cipher.getAuthTag())
    await rm(destination, { force: true })
    await rename(staging, destination)
  } catch (error) {
    input.destroy()
    await completion.catch(() => undefined)
    await rm(staging, { force: true })
    throw error
  }
}

export async function decryptTeamSyncArchive(source: string, destinationRoot: string, key: Buffer): Promise<void> {
  if (key.length !== 32) throw new Error('团队同步解密密钥无效')
  const sourceInfo = await stat(source)
  if (!sourceInfo.isFile() || sourceInfo.size < MAGIC.length + 4 + AUTH_TAG_BYTES) throw new Error('团队同步包文件无效')
  const handle = await open(source, 'r')
  let headerBytes: Buffer
  let header: ArchiveHeader
  let payloadOffset: number
  let authTag: Buffer
  try {
    const prefix = Buffer.alloc(MAGIC.length + 4)
    await handle.read({ buffer: prefix, position: 0 })
    if (!prefix.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('不是受支持的团队同步包')
    const length = prefix.readUInt32BE(MAGIC.length)
    if (length <= 0 || length > MAX_HEADER_BYTES) throw new Error('团队同步包头无效')
    headerBytes = Buffer.alloc(length)
    await handle.read({ buffer: headerBytes, position: MAGIC.length + 4 })
    header = JSON.parse(headerBytes.toString('utf8')) as ArchiveHeader
    if (header.schemaVersion !== 1 || header.cipher !== 'aes-256-gcm') throw new Error('团队同步包版本不受支持')
    payloadOffset = MAGIC.length + 4 + length
    authTag = Buffer.alloc(AUTH_TAG_BYTES)
    await handle.read({ buffer: authTag, position: sourceInfo.size - AUTH_TAG_BYTES })
  } finally { await handle.close() }
  const nonce = Buffer.from(header!.nonce, 'base64')
  if (nonce.length !== 12) throw new Error('团队同步包 nonce 无效')
  const decipher = createDecipheriv('aes-256-gcm', key, nonce)
  decipher.setAAD(headerBytes!)
  decipher.setAuthTag(authTag!)
  await mkdir(destinationRoot, { recursive: true })
  const reader = new Reader(createReadStream(source, { start: payloadOffset!, end: sourceInfo.size - AUTH_TAG_BYTES - 1 }).pipe(decipher))
  const digest = createHash('sha256')
  let fileCount = 0
  let totalBytes = 0
  try {
    while (true) {
      const record = await readRecord(reader)
      if (record.type === 'end') {
        if (record.fileCount !== fileCount || record.totalBytes !== totalBytes || record.contentSha256 !== digest.digest('hex')) {
          throw new Error('团队同步包完整性校验失败')
        }
        break
      }
      if (record.type !== 'file' || typeof record.path !== 'string' || !Number.isSafeInteger(record.size) || record.size! < 0) throw new Error('团队同步包记录无效')
      fileCount += 1
      totalBytes += record.size!
      if (fileCount > MAX_FILES || totalBytes > MAX_BYTES) throw new Error('团队同步包内容超过安全限制')
      digest.update(record.path).update('\0').update(String(record.size)).update('\0')
      await reader.copy(record.size!, safeOutputPath(destinationRoot, record.path), digest)
    }
  } catch (error) {
    await rm(destinationRoot, { recursive: true, force: true })
    if ((error as Error).message.includes('authenticate data')) throw new Error('团队同步包密钥错误或数据已损坏')
    throw error
  }
}
