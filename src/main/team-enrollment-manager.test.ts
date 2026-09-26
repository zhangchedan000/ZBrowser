import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultProfileDraft } from '../shared/defaults'
import { identitySecretCodec } from './secret-codec'
import { ProfileStore } from './profile-store'
import { TeamAuthStore } from './team-auth-store'
import { TeamEnrollmentManager } from './team-enrollment-manager'
import { TeamSessionStore } from './team-session-store'
import { TeamStore } from './team-store'
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
  await Promise.all([profiles.initialize(), team.initialize()])
  const auth = new TeamAuthStore(vault, team)
  await auth.initialize()
  const session = new TeamSessionStore(vault, team, auth, identitySecretCodec)
  await session.initialize()
  const sync = new TeamSyncManager(profiles, team)
  const enrollment = new TeamEnrollmentManager(profiles, team, auth, session, sync)
  return { vault, profiles, team, auth, session, sync, enrollment }
}

describe('TeamEnrollmentManager', () => {
  it('moves an assigned environment and member identity to a fresh child device in one bundle', async () => {
    const owner = await appFixture('zbrowser-owner-device-')
    const member = await owner.team.createMember(owner.team.ownerId, 'Operator')
    const profile = await owner.profiles.create(defaultProfileDraft())
    await owner.team.setProfileAssignments(owner.team.ownerId, profile.id, [member.id])
    await writeFile(join(owner.profiles.profileDataPath(profile.id), 'Cookies'), 'shop-login')
    const output = await root('zbrowser-enrollment-output-')
    const bundle = join(output, 'operator.zbrowser-team')

    const exported = await owner.enrollment.exportBundle(owner.team.ownerId, member.id, bundle)
    expect(exported.profileCount).toBe(1)

    const child = await appFixture('zbrowser-child-device-')
    const imported = await child.enrollment.importBundle(bundle)

    expect(imported.memberId).toBe(member.id)
    expect(child.session.deviceRole).toBe('member')
    expect(child.session.currentMember().id).toBe(member.id)
    expect(child.profiles.list()).toHaveLength(1)
    expect(child.profiles.get(profile.id).id).toBe(profile.id)
    expect(await readFile(join(child.profiles.profileDataPath(profile.id), 'Cookies'), 'utf8')).toBe('shop-login')
  })

  it('refuses to overwrite a device that already contains local profiles', async () => {
    const owner = await appFixture('zbrowser-owner-device-')
    const member = await owner.team.createMember(owner.team.ownerId, 'Operator')
    const profile = await owner.profiles.create(defaultProfileDraft())
    await owner.team.setProfileAssignments(owner.team.ownerId, profile.id, [member.id])
    const output = await root('zbrowser-enrollment-output-')
    const bundle = join(output, 'operator.zbrowser-team')
    await owner.enrollment.exportBundle(owner.team.ownerId, member.id, bundle)

    const child = await appFixture('zbrowser-child-device-')
    await child.profiles.create(defaultProfileDraft())
    await expect(child.enrollment.importBundle(bundle)).rejects.toThrow('新设备')
  })
})