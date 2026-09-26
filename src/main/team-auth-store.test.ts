import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TeamAuthStore } from './team-auth-store'
import { TeamStore } from './team-store'

const roots: string[] = []

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'zbrowser-team-auth-'))
  roots.push(root)
  const team = new TeamStore(root)
  await team.initialize()
  const auth = new TeamAuthStore(root, team)
  await auth.initialize()
  return { team, auth }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('TeamAuthStore', () => {
  it('issues one-time-visible credentials that authenticate the member', async () => {
    const { team, auth } = await fixture()
    const member = await team.createMember(team.ownerId, 'Operator')
    const credential = await auth.issue(team.ownerId, member.id)
    expect(credential.secret.length).toBeGreaterThanOrEqual(43)
    expect(auth.authenticate(member.id, credential.secret).id).toBe(member.id)
    expect(() => auth.authenticate(member.id, credential.secret + 'x')).toThrow()
  })

  it('rotates and revokes credentials', async () => {
    const { team, auth } = await fixture()
    const member = await team.createMember(team.ownerId, 'Operator')
    const first = await auth.issue(team.ownerId, member.id)
    const second = await auth.issue(team.ownerId, member.id)
    expect(() => auth.authenticate(member.id, first.secret)).toThrow()
    expect(auth.authenticate(member.id, second.secret).id).toBe(member.id)
    await auth.revoke(team.ownerId, member.id)
    expect(() => auth.authenticate(member.id, second.secret)).toThrow('尚未生成')
  })
})