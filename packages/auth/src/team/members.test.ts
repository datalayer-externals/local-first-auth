import { ADMIN } from 'role/index.js'
import { setup } from 'util/testing/index.js'
import 'util/testing/expect/toLookLikeKeyset.js'
import { describe, expect, it } from 'vitest'

describe('Team', () => {
  describe('members', () => {
    it('has Alice as a root member', () => {
      const { alice } = setup('alice')

      expect(alice.team.members().length).toBe(1)
      const A = alice.team.members('alice')
      expect(A.userId).toBe('alice')
    })

    it('has lockboxes for Alice containing the admin and team secrets', () => {
      const { alice } = setup('alice')
      const adminKeyset = alice.team.roleKeys(ADMIN)
      expect(adminKeyset).toLookLikeKeyset()

      const teamKeys = alice.team.teamKeys()
      expect(teamKeys).toLookLikeKeyset()
    })

    it('adds a member', () => {
      const { alice } = setup('alice', 'bob')
      expect(alice.team.members().length).toBe(2)
      expect(alice.team.members('bob').userId).toBe('bob')
    })

    it('makes lockboxes for added members', () => {
      // Alice creates a team, adds Bob
      const { bob } = setup('alice', { user: 'bob', admin: false })

      // Bob has team keys
      const teamKeys = bob.team.teamKeys()
      expect(teamKeys).toLookLikeKeyset()

      // Bob is not an admin so he doesn't have admin keys
      const bobLooksForAdminKeys = () => bob.team.roleKeys(ADMIN)
      expect(bobLooksForAdminKeys).toThrow()
    })

    it('makes an admin lockbox for an added admin member', () => {
      // Alice creates a team, adds Bob as an admin
      const { bob } = setup('alice', { user: 'bob', admin: true })

      // Bob is an admin and has admin keys
      const adminKeyset = bob.team.roleKeys(ADMIN)
      expect(adminKeyset).toLookLikeKeyset()
    })

    it("doesn't care if you add a member twice", () => {
      const { alice, bob } = setup('alice', { user: 'bob', member: false })

      const addBob = () => {
        alice.team.addForTesting(bob.user)
      }

      expect(addBob).not.toThrow()

      // Try adding bob again
      const addBobAgain = () => {
        alice.team.addForTesting(bob.user)
      }

      expect(addBobAgain).not.toThrow()
    })

    it('removes a member', () => {
      const { alice } = setup('alice', 'bob')

      expect(alice.team.has('bob')).toBe(true)
      expect(alice.team.memberWasRemoved('bob')).toBe(false)

      alice.team.remove('bob')
      expect(alice.team.has('bob')).toBe(false)

      // MemberWasRemoved works as expected
      expect(alice.team.memberWasRemoved('alice')).toBe(false) // Alice is still a member
      expect(alice.team.memberWasRemoved('bob')).toBe(true) // Bob is no longer a member
      expect(alice.team.memberWasRemoved('charlie')).toBe(false) // Charlie was never a member
    })

    it('rotates keys after removing a member', () => {
      const { alice } = setup('alice', { user: 'bob', admin: true })

      // Keys have never been rotated
      expect(alice.team.teamKeys().generation).toBe(0)
      expect(alice.team.adminKeys().generation).toBe(0)

      // Remove bob from team
      alice.team.remove('bob')

      // Team keys & admin keys have now been rotated once
      expect(alice.team.teamKeys().generation).toBe(1)
      expect(alice.team.adminKeys().generation).toBe(1)
    })

    it("doesn't do anything if asked to remove a nonexistent member", () => {
      const { alice } = setup('alice')

      // Try removing bob although he hasn't been added
      const removeBob = () => {
        alice.team.remove('bob')
      }

      expect(removeBob).not.toThrow()
    })

    it('gets an individual member', () => {
      const { alice } = setup('alice', 'bob')
      const member = alice.team.members('bob')
      expect(member.userId).toBe('bob')
    })

    it('throws if asked to get a nonexistent member', () => {
      const { alice } = setup('alice', 'bob')

      const getNed = () => alice.team.members('ned')
      expect(getNed).toThrow(/not found/)
    })

    it('lists all members', () => {
      const { alice, bob, charlie } = setup([
        'alice',
        { user: 'bob', member: false },
        { user: 'charlie', member: false },
      ])

      expect(alice.team.members()).toHaveLength(1)
      expect(alice.team.members().map(m => m.userId)).toEqual(['alice'])

      alice.team.addForTesting(bob.user)
      alice.team.addForTesting(charlie.user)
      expect(alice.team.members()).toHaveLength(3)
      expect(alice.team.members().map(m => m.userId)).toEqual(['alice', 'bob', 'charlie'])
    })
  })
})
