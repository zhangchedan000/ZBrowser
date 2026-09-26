import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { identitySecretCodec } from './secret-codec'
import { TeamAuthStore } from './team-auth-store'
import { TeamSessionStore } from './team-session-store'
import { TeamStore } from './team-store'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'zbrowser-team-session-'))
  roots.push(root)
  const team = new TeamStore(root)
  await team.initialize()
  const auth = new TeamAuthStore(root, team)
  await auth.initialize()
  const session = new TeamSessionStore(root, team, auth, identitySecretCodec)
  await session.initialize()
  return { root, team, auth, session }
}

describe('TeamSessionStore', () => {
  it('starts as the owner on the original device', async () => {
    const { team, session } = await fixture()
    expect(session.deviceRole).toBe('owner')
    expect(session.currentMember().id).toBe(team.ownerId)
  })

  it('persists an authenticated member-only device session', async () => {
    const { root, team, auth, session } = await fixture()
    const member = await team.createMember(team.ownerId, 'Operator')
    const credential = await auth.issue(team.ownerId, member.id)
    await session.convertToMemberDevice(member.id, credential.secret)

    const reopened = new TeamSessionStore(root, team, auth, identitySecretCodec)
    await reopened.initialize()
    expect(reopened.deviceRole).toBe('member')
    expect(reopened.currentMember().id).toBe(member.id)
    await expect(Promise.resolve().then(() => reopened.login(member.id, 'x'.repeat(43)))).rejects.toThrow()
  })
})
