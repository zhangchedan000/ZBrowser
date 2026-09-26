import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TeamStore } from './team-store'

const temporaryPaths: string[] = []

async function createStore(): Promise<{ store: TeamStore; path: string }> {
  const path = await mkdtemp(join(tmpdir(), 'zbrowser-team-'))
  temporaryPaths.push(path)
  const store = new TeamStore(path)
  await store.initialize()
  return { store, path }
}

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('TeamStore', () => {
  it('bootstraps one owner and allows one profile to be assigned to multiple members', async () => {
    const { store } = await createStore()
    const owner = store.getMember(store.ownerId)
    expect(owner.role).toBe('owner')
    expect(owner.enabled).toBe(true)

    const alice = await store.createMember(owner.id, '小张')
    const bob = await store.createMember(owner.id, '小李')
    const assignment = await store.setProfileAssignments(owner.id, 'profile-1', [alice.id, bob.id])

    expect(assignment.memberIds).toEqual([alice.id, bob.id])
    expect(store.canUse(alice.id, 'profile-1')).toBe(true)
    expect(store.canUse(bob.id, 'profile-1')).toBe(true)
    expect(store.canUse(alice.id, 'profile-2')).toBe(false)
    expect(store.canUse(owner.id, 'profile-2')).toBe(true)
  })

  it('enforces a single active lease even when a profile is assigned to multiple members', async () => {
    const { store } = await createStore()
    const owner = store.getMember(store.ownerId)
    const alice = await store.createMember(owner.id, 'Alice')
    const bob = await store.createMember(owner.id, 'Bob')
    await store.setProfileAssignments(owner.id, 'profile-1', [alice.id, bob.id])

    const first = await store.acquireLease(alice.id, 'device-a', 'profile-1')
    expect(first.memberId).toBe(alice.id)
    await expect(store.acquireLease(bob.id, 'device-b', 'profile-1')).rejects.toThrow('正在由')
    await store.releaseLease(alice.id, 'device-a', 'profile-1')
    const second = await store.acquireLease(bob.id, 'device-b', 'profile-1')
    expect(second.memberId).toBe(bob.id)
  })

  it('keeps member accounts read-only for team administration', async () => {
    const { store } = await createStore()
    const owner = store.getMember(store.ownerId)
    const member = await store.createMember(owner.id, 'Operator')

    await expect(store.createMember(member.id, 'Other')).rejects.toThrow('只有主账号')
    await expect(store.setProfileAssignments(member.id, 'profile-1', [])).rejects.toThrow('只有主账号')
    await expect(store.forceRelease(member.id, 'profile-1')).rejects.toThrow('只有主账号')
  })

  it('revokes use and removes active lease when a member is disabled', async () => {
    const { store } = await createStore()
    const owner = store.getMember(store.ownerId)
    const member = await store.createMember(owner.id, 'Operator')
    await store.setProfileAssignments(owner.id, 'profile-1', [member.id])
    await store.acquireLease(member.id, 'device-a', 'profile-1')

    await store.updateMember(owner.id, member.id, { enabled: false })
    expect(store.canUse(member.id, 'profile-1')).toBe(false)
    expect(store.state().leases).toHaveLength(0)
    await expect(store.acquireLease(member.id, 'device-a', 'profile-1')).rejects.toThrow('禁用')
  })

  it('drops assignments on trash and does not restore them automatically', async () => {
    const { store } = await createStore()
    const owner = store.getMember(store.ownerId)
    const member = await store.createMember(owner.id, 'Operator')
    await store.setProfileAssignments(owner.id, 'profile-1', [member.id])
    await store.acquireLease(member.id, 'device-a', 'profile-1')

    await store.onProfileTrashed(owner.id, 'profile-1')
    expect(store.assignedMemberIds('profile-1')).toEqual([])
    expect(store.state().leases).toHaveLength(0)

    await store.onProfileRestored(owner.id, 'profile-1')
    expect(store.assignedMemberIds('profile-1')).toEqual([])
    expect(store.canUse(member.id, 'profile-1')).toBe(false)
  })

  it('tracks synchronized profile revisions under the current lease', async () => {
    const { store } = await createStore()
    const owner = store.getMember(store.ownerId)
    const member = await store.createMember(owner.id, 'Operator')
    await store.setProfileAssignments(owner.id, 'profile-1', [member.id])
    await store.acquireLease(member.id, 'device-a', 'profile-1')

    const first = await store.recordSyncedRevision(member.id, 'device-a', 'profile-1', 'a'.repeat(64))
    const second = await store.recordSyncedRevision(member.id, 'device-a', 'profile-1', 'b'.repeat(64))
    expect(first.revision).toBe(1)
    expect(second.revision).toBe(2)
    expect(second.checksum).toBe('b'.repeat(64))
  })

  it('persists members, assignments and audit records across restart', async () => {
    const { store, path } = await createStore()
    const owner = store.getMember(store.ownerId)
    const member = await store.createMember(owner.id, 'Operator')
    await store.setProfileAssignments(owner.id, 'profile-1', [member.id])

    const reopened = new TeamStore(path)
    await reopened.initialize()
    expect(reopened.ownerId).toBe(owner.id)
    expect(reopened.getMember(member.id).name).toBe('Operator')
    expect(reopened.assignedMemberIds('profile-1')).toEqual([member.id])
    expect(reopened.audit().some((event) => event.type === 'profile_assigned')).toBe(true)
  })
})