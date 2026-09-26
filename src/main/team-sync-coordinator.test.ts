import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultProfileDraft } from '../shared/defaults'
import { identitySecretCodec } from './secret-codec'
import { ProfileStore } from './profile-store'
import { SettingsStore } from './settings-store'
import { TeamAuthStore } from './team-auth-store'
import { TeamEnrollmentManager } from './team-enrollment-manager'
import { TeamSessionStore } from './team-session-store'
import { TeamStore } from './team-store'
import { TeamSyncCoordinator } from './team-sync-coordinator'
import { TeamSyncManager } from './team-sync-manager'

const roots: string[] = []
async function root(prefix: string) {
  const value = await mkdtemp(join(tmpdir(), prefix))
  roots.push(value)
  return value
}
afterEach(async () => Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true }))))

async function appFixture(prefix: string) {
  const vault = await root(prefix)
  const profiles = new ProfileStore(vault)
  const team = new TeamStore(vault)
  const settings = new SettingsStore(vault)
  await Promise.all([profiles.initialize(), team.initialize(), settings.initialize()])
  const auth = new TeamAuthStore(vault, team)
  await auth.initialize()
  const session = new TeamSessionStore(vault, team, auth, identitySecretCodec)
  await session.initialize()
  const sync = new TeamSyncManager(profiles, team)
  const enrollment = new TeamEnrollmentManager(profiles, team, auth, session, sync)
  const coordinator = new TeamSyncCoordinator(profiles, team, auth, session, sync, settings)
  return { vault, profiles, team, auth, session, sync, enrollment, coordinator, settings }
}

describe('TeamSyncCoordinator', () => {
  it('automatically propagates browser-state updates and access revocation through an encrypted shared directory', async () => {
    const owner = await appFixture('zbrowser-sync-owner-')
    const member = await owner.team.createMember(owner.team.ownerId, 'Operator')
    const profile = await owner.profiles.create(defaultProfileDraft())
    await owner.team.setProfileAssignments(owner.team.ownerId, profile.id, [member.id])
    await writeFile(join(owner.profiles.profileDataPath(profile.id), 'Cookies'), 'login-v1')

    const bundleRoot = await root('zbrowser-sync-enrollment-')
    const bundle = join(bundleRoot, 'operator.zbrowser-team')
    await owner.enrollment.exportBundle(owner.team.ownerId, member.id, bundle)

    const child = await appFixture('zbrowser-sync-child-')
    await child.enrollment.importBundle(bundle)
    expect(await readFile(join(child.profiles.profileDataPath(profile.id), 'Cookies'), 'utf8')).toBe('login-v1')

    const shared = await root('zbrowser-sync-shared-')
    await owner.settings.update({ teamSyncDirectory: shared })
    await child.settings.update({ teamSyncDirectory: shared })
    await owner.coordinator.runOnce()
    await child.coordinator.runOnce()

    await writeFile(join(owner.profiles.profileDataPath(profile.id), 'Cookies'), 'login-v2')
    await owner.coordinator.publishProfile(profile.id)
    await child.coordinator.runOnce()
    expect(await readFile(join(child.profiles.profileDataPath(profile.id), 'Cookies'), 'utf8')).toBe('login-v2')

    await owner.team.setProfileAssignments(owner.team.ownerId, profile.id, [])
    await owner.coordinator.runOnce()
    await child.coordinator.runOnce()
    expect(child.profiles.list()).toHaveLength(0)
    expect((await child.profiles.listTrash()).some((item) => item.profileId === profile.id)).toBe(false)
  })

  it('keeps shared browser data encrypted at rest', async () => {
    const owner = await appFixture('zbrowser-sync-owner-')
    const member = await owner.team.createMember(owner.team.ownerId, 'Operator')
    const profile = await owner.profiles.create(defaultProfileDraft())
    await owner.team.setProfileAssignments(owner.team.ownerId, profile.id, [member.id])
    const credential = await owner.auth.issue(owner.team.ownerId, member.id)
    expect(credential.secret.length).toBeGreaterThan(40)
    await writeFile(join(owner.profiles.profileDataPath(profile.id), 'Cookies'), 'VERY-SECRET-COOKIE')
    const shared = await root('zbrowser-sync-shared-')
    await owner.settings.update({ teamSyncDirectory: shared })

    await owner.coordinator.runOnce()
    const profileDir = join(shared, `team-${owner.team.ownerId}`, `member-${member.id}`, 'profiles')
    const files = await import('node:fs/promises').then(({ readdir }) => readdir(profileDir))
    const archive = await readFile(join(profileDir, files.find((name) => name.endsWith('.zbsync'))!))
    expect(archive.includes(Buffer.from('VERY-SECRET-COOKIE'))).toBe(false)
  })
})