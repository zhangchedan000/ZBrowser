import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultProfileDraft } from '../shared/defaults'
import { ProfileStore } from './profile-store'
import { TeamStore } from './team-store'
import { TeamSyncManager } from './team-sync-manager'

const roots: string[] = []

async function root(prefix: string): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), prefix))
  roots.push(value)
  return value
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true })))
})

async function sourceFixture() {
  const vault = await root('zbrowser-team-sync-source-')
  const profiles = new ProfileStore(vault)
  const team = new TeamStore(vault)
  await Promise.all([profiles.initialize(), team.initialize()])
  const member = await team.createMember(team.ownerId, 'Operator')
  const profile = await profiles.create(defaultProfileDraft())
  await team.setProfileAssignments(team.ownerId, profile.id, [member.id])
  await writeFile(join(profiles.profileDataPath(profile.id), 'Cookies'), 'logged-in-cookie')
  return { vault, profiles, team, member, profile, sync: new TeamSyncManager(profiles, team) }
}

async function targetFixture(sourceVault: string) {
  const vault = await root('zbrowser-team-sync-target-')
  await mkdir(vault, { recursive: true })
  await copyFile(join(sourceVault, 'team.json'), join(vault, 'team.json'))
  const profiles = new ProfileStore(vault)
  const team = new TeamStore(vault)
  await Promise.all([profiles.initialize(), team.initialize()])
  return { vault, profiles, team, sync: new TeamSyncManager(profiles, team) }
}

describe('TeamSyncManager', () => {
  it('copies a complete assigned environment with the original id and browser state', async () => {
    const source = await sourceFixture()
    const target = await targetFixture(source.vault)
    const snapshot = await source.sync.createSnapshot(source.team.ownerId, source.member.id, source.profile.id)

    const revision = await target.sync.applySnapshot(source.member.id, snapshot.path)

    expect(revision.revision).toBe(1)
    expect(target.profiles.list()).toHaveLength(1)
    expect(target.profiles.get(source.profile.id).id).toBe(source.profile.id)
    expect(await readFile(join(target.profiles.profileDataPath(source.profile.id), 'Cookies'), 'utf8')).toBe('logged-in-cookie')
  })

  it('rejects a tampered synchronized browser state', async () => {
    const source = await sourceFixture()
    const target = await targetFixture(source.vault)
    const snapshot = await source.sync.createSnapshot(source.team.ownerId, source.member.id, source.profile.id)
    await writeFile(join(snapshot.path, 'user-data', 'Cookies'), 'tampered')

    await expect(target.sync.applySnapshot(source.member.id, snapshot.path)).rejects.toThrow('完整性校验失败')
    expect(target.profiles.list()).toHaveLength(0)
  })

  it('permanently removes only team-synced local copies after access is revoked', async () => {
    const source = await sourceFixture()
    const target = await targetFixture(source.vault)
    const snapshot = await source.sync.createSnapshot(source.team.ownerId, source.member.id, source.profile.id)
    await target.sync.applySnapshot(source.member.id, snapshot.path)
    const localDraft = defaultProfileDraft()
    localDraft.name = '本机私人环境'
    const localProfile = await target.profiles.create(localDraft)

    await target.team.setProfileAssignments(target.team.ownerId, source.profile.id, [])
    const removed = await target.sync.removeRevokedLocalProfiles(source.member.id)

    expect(removed).toEqual([source.profile.id])
    expect(target.profiles.list().map((item) => item.id)).toEqual([localProfile.id])
    expect((await target.profiles.listTrash()).some((item) => item.profileId === source.profile.id)).toBe(false)
  })
})
