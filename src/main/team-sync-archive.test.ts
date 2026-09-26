import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { decryptTeamSyncArchive, encryptTeamSyncDirectory } from './team-sync-archive'

const roots: string[] = []
async function root(prefix: string) {
  const value = await mkdtemp(join(tmpdir(), prefix))
  roots.push(value)
  return value
}
afterEach(async () => Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true }))))

describe('team sync archive', () => {
  it('encrypts and restores a snapshot directory', async () => {
    const source = await root('zbrowser-sync-archive-source-')
    const output = await root('zbrowser-sync-archive-output-')
    const restored = await root('zbrowser-sync-archive-restored-')
    await writeFile(join(source, 'manifest.json'), '{"ok":true}')
    await writeFile(join(source, 'Cookies'), 'secret-cookie')
    const key = Buffer.alloc(32, 7)
    const archive = join(output, 'profile.zbsync')

    await encryptTeamSyncDirectory(source, archive, key)
    expect((await readFile(archive)).includes(Buffer.from('secret-cookie'))).toBe(false)
    await decryptTeamSyncArchive(archive, restored, key)
    expect(await readFile(join(restored, 'Cookies'), 'utf8')).toBe('secret-cookie')
  })

  it('rejects the wrong member key', async () => {
    const source = await root('zbrowser-sync-archive-source-')
    const output = await root('zbrowser-sync-archive-output-')
    const restored = join(await root('zbrowser-sync-archive-restored-'), 'snapshot')
    await writeFile(join(source, 'Cookies'), 'secret-cookie')
    const archive = join(output, 'profile.zbsync')
    await encryptTeamSyncDirectory(source, archive, Buffer.alloc(32, 1))

    await expect(decryptTeamSyncArchive(archive, restored, Buffer.alloc(32, 2))).rejects.toThrow()
  })
})
