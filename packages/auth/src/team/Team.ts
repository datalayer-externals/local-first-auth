import type {
  KeyMetadata,
  KeyScope,
  Keyring,
  Keyset,
  KeysetWithSecrets,
  Payload,
  Store,
  UnixTimestamp,
  User,
  UserWithSecrets,
} from '@localfirst/crdx'
import {
  createKeyset,
  createStore,
  getLatestGeneration,
  isKeyset,
  redactKeys,
} from '@localfirst/crdx'
import { randomKey, signatures, symmetric, type Base58 } from '@localfirst/crypto'
import * as identity from 'connection/identity.js'
import { type Challenge } from 'connection/types.js'
import { type LocalUserContext } from 'context/index.js'
import * as devices from 'device/index.js'
import {
  getDeviceId,
  parseDeviceId,
  redactDevice,
  type Device,
  type DeviceWithSecrets,
} from 'device/index.js'
import { EventEmitter } from 'eventemitter3'
import * as invitations from 'invitation/index.js'
import { type ProofOfInvitation } from 'invitation/index.js'
import { normalize } from 'invitation/normalize.js'
import * as lockbox from 'lockbox/index.js'
import { ADMIN, type Role } from 'role/index.js'
import { cast } from 'server/cast.js'
import { type Host, type Server } from 'server/types.js'
import { KeyType, VALID, assert, debug, scopesMatch } from 'util/index.js'
import { ADMIN_SCOPE, ALL, TEAM_SCOPE, initialState } from './constants.js'
import { membershipResolver as resolver } from './membershipResolver.js'
import { redactUser } from './redactUser.js'
import { reducer } from './reducer.js'
import * as select from './selectors/index.js'
import { maybeDeserialize, serializeTeamGraph } from './serialize.js'
import { isNewTeam } from './types.js'
import type {
  EncryptedEnvelope,
  Member,
  SignedEnvelope,
  TeamAction,
  TeamGraph,
  TeamOptions,
  TeamState,
  InviteResult,
  LookupIdentityResult,
} from './types.js'

const { DEVICE, USER } = KeyType
/**
 * The `Team` class wraps a `TeamGraph` and exposes methods for adding and removing
 * members, assigning roles, creating and using invitations, and encrypting messages for
 * individuals, for the team, or for members of specific roles.
 */
export class Team extends EventEmitter {
  public state: TeamState = initialState

  private readonly store: Store<TeamState, TeamAction>
  private readonly context: LocalUserContext
  private readonly log: (o: any, ...args: any[]) => void
  private readonly seed: string

  /**
   * We can make a team instance either by creating a brand-new team, or restoring one from a stored graph.
   */
  constructor(options: TeamOptions) {
    super()

    // ignore coverage
    this.seed = options.seed ?? randomKey()

    if ('user' in options.context) {
      this.context = options.context
    } else {
      // If we're on a server, we'll use the server's hostname for everything
      // and the server's keys as both user keys and device keys
      const { server } = options.context
      this.context = {
        ...options.context,
        device: cast.toDevice(server),
        user: cast.toUser(server),
      }
    }

    this.log = debug(`lf:auth:team:${this.userName}`)

    // Initialize a CRDX store for the team
    if (isNewTeam(options)) {
      assert(!this.isServer, 'Cannot create a team on a server')

      // Create a new team with the current user as founding member
      const { device, user } = this.context

      // Team & role secrets are never stored in plaintext, only encrypted into individual
      // lockboxes. Here we generate new keysets for the team and for the admin role, and store
      // these in new lockboxes for the founding member
      const teamLockbox = lockbox.create(options.teamKeys, user.keys)
      const adminKeys = createKeyset(ADMIN_SCOPE, this.seed)
      const adminLockbox = lockbox.create(adminKeys, user.keys)

      // We also store the user's keys in a lockbox for the user's device
      const deviceLockbox = lockbox.create(user.keys, this.context.device.keys)

      // We're creating a new graph; this information is to be recorded in the root link
      const rootPayload = {
        name: options.teamName,
        rootMember: redactUser(user),
        rootDevice: devices.redactDevice(device),
        lockboxes: [teamLockbox, adminLockbox, deviceLockbox],
      }

      // Create CRDX store
      this.store = createStore({
        user,
        reducer,
        resolver,
        initialState,
        rootPayload,
        keys: options.teamKeys,
      })
    } else {
      // Rehydrate a team from an existing graph
      const graph = maybeDeserialize(options.source, options.teamKeyring)
      const { user } = this.context

      // Create CRDX store
      this.store = createStore({
        user,
        reducer,
        resolver,
        initialState,
        graph,
        keys: options.teamKeyring,
      })
    }

    this.state = this.store.getState()

    // Wire up event listeners
    this.on('updated', () => {
      // If we're admin, check for pending key rotations
      this.checkForPendingKeyRotations()
    })
  }

  public get graph() {
    return this.store.getGraph() as TeamGraph
  }

  /** We use the hash of the graph's root as a unique ID for the team. */
  public get id() {
    return this.graph.root
  }

  /** ************** CONTEXT */

  private get isServer() {
    return 'server' in this.context
  }

  public get userName() {
    if (this.context.user) {
      return this.context.user.userId
    }

    return this.context.device.userId // Device is always known
  }

  public get userId() {
    if (this.context.user) {
      return this.context.user.userId
    }

    return this.context.device.userId // Device is always known
  }

  /** ************** TEAM STATE
   *
   * All the logic for *reading* team state is in selectors (see `/team/selectors`).
   *
   * Most of the logic for *modifying* team state is in transforms (see `/team/transforms`), which
   * are executed by the reducer. To mutate team state, we dispatch changes to the graph, and then
   * run the graph through the reducer to recalculate team state.
   *
   * Any crypto operations involving the current user's secrets (for example, opening or creating
   * lockboxes, or signing links) are done here, not in the selectors or in the reducer. Only the
   * public-facing outputs (for example, the resulting lockboxesInScope, or the signed links) are
   * posted on the graph.
   */

  /** Returns this team's user-facing name. */
  public get teamName() {
    return this.state.teamName
  }

  public save = () => serializeTeamGraph(this.graph)

  /**
   * Merges another graph (e.g. from a peer) with ours.
   * @returns This `Team` instance.
   */
  public merge = (theirGraph: TeamGraph) => {
    this.store.merge(theirGraph)
    this.state = this.store.getState()

    this.emit('updated', { head: this.graph.head })
    return this
  }

  /** Add a link to the graph, then recompute team state from the new graph */
  public dispatch(action: TeamAction, teamKeys: KeysetWithSecrets = this.teamKeys()) {
    this.store.dispatch(action, teamKeys)
    this.state = this.store.getState()

    this.emit('updated', { head: this.graph.head })
  }

  public lookupIdentity = (identityClaim: KeyScope): LookupIdentityResult => {
    assert(identityClaim.type === DEVICE) // We always authenticate as devices
    const deviceId = identityClaim.name
    const { userId, deviceName } = parseDeviceId(deviceId)
    if (this.memberWasRemoved(userId) || this.serverWasRemoved(userId)) {
      return 'MEMBER_REMOVED'
    }

    if (!this.has(userId) && !this.hasServer(userId)) {
      return 'MEMBER_UNKNOWN'
    }

    if (this.deviceWasRemoved(userId, deviceName)) {
      return 'DEVICE_REMOVED'
    }

    if (!this.hasDevice(userId, deviceName) && !this.hasServer(userId)) {
      return 'DEVICE_UNKNOWN'
    }

    return 'VALID_DEVICE'
  }

  public verifyIdentityProof = (challenge: Challenge, proof: Base58) => {
    assert(challenge.type === DEVICE) // We always authenticate as devices
    const deviceId = challenge.name
    const { userId, deviceName } = parseDeviceId(deviceId)

    const device = this.hasServer(userId)
      ? this.servers(userId)
      : this.device(userId, deviceName, { includeRemoved: true })

    const validation = identity.verify(challenge, proof, device.keys)
    return validation.isValid
  }

  /** ************** MEMBERS */

  /** Returns true if the team has a member with the given userId */
  public has = (userId: string) => select.hasMember(this.state, userId)

  /** Returns a list of all members on the team */
  public members(): Member[] // Overload: all members
  /** Returns the member with the given user name */
  public members(userId: string, options?: { includeRemoved: boolean }): Member // Overload: one member
  //
  public members(userId: string = ALL, options = { includeRemoved: true }): Member | Member[] {
    return userId === ALL //
      ? this.state.members // All members
      : select.member(this.state, userId, options) // One member
  }

  /**
   * Add a member to the team. Since this method assumes that you know the member's secret keys, it
   * only makes sense for unit tests. In real-world scenarios, you'll need to use the `team.invite`
   * workflow to add members without relying on some kind of public key infrastructure.
   */
  public addForTesting = (user: UserWithSecrets, roles: string[] = [], device?: Device) => {
    const member = { ...redactUser(user), roles }

    // Make lockboxes for the new member
    const lockboxes = this.createMemberLockboxes(member)

    // Post the member to the graph
    this.dispatch({
      type: 'ADD_MEMBER',
      payload: { member, roles, lockboxes },
    })

    if (device) {
      // Post the member's device to the graph
      const deviceLockbox = lockbox.create(user.keys, device.keys)
      this.dispatch({
        type: 'ADD_DEVICE',
        payload: { device, lockboxes: [deviceLockbox] },
      })
    }
  }

  public add = (user: User, roles: string[] = []) => {
    const member = { ...user, roles }

    // Make lockboxes for the new member
    const lockboxes = this.createMemberLockboxes(member)

    // Post the member to the graph
    this.dispatch({
      type: 'ADD_MEMBER',
      payload: { member, roles, lockboxes },
    })
  }

  /** Remove a member from the team */
  public remove = (userId: string) => {
    // Create new keys & lockboxes for any keys this person had access to
    const lockboxes = this.rotateKeys({ type: USER, name: userId })

    // Post the removal to the graph
    this.dispatch({
      type: 'REMOVE_MEMBER',
      payload: {
        userId,
        lockboxes,
      },
    })
  }

  /** Returns true if the member was once on the team but was removed */
  public memberWasRemoved = (userId: string) => select.memberWasRemoved(this.state, userId)

  /** ************** ROLES */

  /** Returns all roles in the team */
  public roles(): Role[]
  /** Returns the role with the given name */
  public roles(roleName: string): Role
  //
  public roles(roleName: string = ALL): Role | Role[] {
    return roleName === ALL //
      ? this.state.roles // All roles
      : select.role(this.state, roleName) // One role
  }

  /** Returns true if the member with the given userId has the given role */
  public memberHasRole = (userId: string, roleName: string) =>
    select.memberHasRole(this.state, userId, roleName)

  /** Returns true if the member with the given userId is a member of the 3 role */
  public memberIsAdmin = (userId: string) => select.memberIsAdmin(this.state, userId)

  /** Returns true if the team has a role with the given name */
  public hasRole = (roleName: string) => select.hasRole(this.state, roleName)

  /** Returns a list of members who have the given role */
  public membersInRole = (roleName: string): Member[] => select.membersInRole(this.state, roleName)

  /** Returns a list of members who are in the admin role */
  public admins = (): Member[] => select.admins(this.state)

  /** Add a role to the team */
  public addRole = (role: Role | string) => {
    if (typeof role === 'string') {
      role = { roleName: role }
    }

    // We're creating this role so we need to generate new keys
    const roleKeys = createKeyset({ type: KeyType.ROLE, name: role.roleName }, this.seed)

    // Make a lockbox for the admin role, so that all admins can access this role's keys
    const lockboxForAdmin = lockbox.create(roleKeys, this.adminKeys())

    // Post the role to the graph
    this.dispatch({
      type: 'ADD_ROLE',
      payload: { ...role, lockboxes: [lockboxForAdmin] },
    })
  }

  /** Remove a role from the team */
  public removeRole = (roleName: string) => {
    assert(roleName !== ADMIN, 'Cannot remove admin role')

    this.dispatch({
      type: 'REMOVE_ROLE',
      payload: { roleName },
    })
  }

  /** Give a member a role */
  public addMemberRole = (userId: string, roleName: string) => {
    // Make a lockbox for the role
    const member = this.members(userId)
    const roleLockbox = lockbox.create(this.roleKeys(roleName), member.keys)

    // Post the member role to the graph
    this.dispatch({
      type: 'ADD_MEMBER_ROLE',
      payload: { userId, roleName, lockboxes: [roleLockbox] },
    })
  }

  /** Remove a role from a member */
  public removeMemberRole = (userId: string, roleName: string) => {
    if (roleName === ADMIN) {
      const adminCount = this.membersInRole(ADMIN).length
      assert(adminCount > 1, "Can't remove the last admin")
    }

    // Create new keys & lockboxes for any keys this person had access to via this role
    const lockboxes = this.rotateKeys({ type: KeyType.ROLE, name: roleName })

    // Post the removal to the graph
    this.dispatch({
      type: 'REMOVE_MEMBER_ROLE',
      payload: { userId, roleName, lockboxes },
    })
  }

  /** ************** DEVICES */

  /** Returns true if the given member has a device by the given name */
  public hasDevice = (userId: string, deviceName: string): boolean =>
    select.hasDevice(this.state, userId, deviceName)

  /** Find a member's device by name */
  public device = (
    userId: string,
    deviceName: string,
    options = { includeRemoved: false }
  ): Device => select.device(this.state, userId, deviceName, options)

  /** Remove a member's device */
  public removeDevice = (userId: string, deviceName: string) => {
    if (!this.hasDevice(userId, deviceName)) {
      return
    }

    // Create new keys & lockboxes for any keys this device had access to
    const deviceId = getDeviceId({ userId, deviceName })
    const lockboxes = this.rotateKeys({ type: DEVICE, name: deviceId })

    // Post the removal to the graph
    this.dispatch({
      type: 'REMOVE_DEVICE',
      payload: {
        userId,
        deviceName,
        lockboxes,
      },
    })
  }

  /** Returns true if the device was once on the team but was removed */
  public deviceWasRemoved = (userId: string, deviceName: string) => {
    const deviceId = getDeviceId({ userId, deviceName })
    return select.deviceWasRemoved(this.state, deviceId)
  }

  /** ************** INVITATIONS */

  /**
   * To invite a new member:
   *
   * Alice generates an invitation using a secret seed. The seed an be randomly generated, or
   * selected by Alice. Alice sends the invitation to Bob using a trusted channel.
   *
   * Meanwhile, Alice adds Bob to the graph as a new member, with appropriate roles (if
   * any) and any corresponding lockboxes.
   *
   * Bob can't authenticate directly as that member, since it has random temporary keys created by
   * Alice. Instead, Bob generates a proof of invitation, and when they try to connect to Alice or
   * Charlie they present that proof instead of authenticating.
   *
   * Once Alice or Charlie verifies Bob's proof, they send him the team graph. Bob uses that to
   * instantiate the team, then he updates the team with his real public keys and adds his current
   * device information.
   */
  public inviteMember({
    seed = invitations.randomSeed(),
    expiration,
    maxUses,
  }: {
    /** A secret to be passed to the invitee via a side channel. If not provided, one will be randomly generated. */
    seed?: string

    /** Time when the invitation expires. If not provided, the invitation does not expire. */
    expiration?: UnixTimestamp

    /** Number of times the invitation can be used. If not provided, the invitation can be used any number of times. */
    maxUses?: number
  } = {}): InviteResult {
    // Normalize the seed (all lower case, strip spaces & punctuation)
    seed = normalize(seed)

    // Generate invitation
    const invitation = invitations.create({ seed, expiration, maxUses })
    const { id } = invitation

    // Post invitation to graph
    this.dispatch({
      type: 'INVITE_MEMBER',
      payload: { invitation },
    })

    // Return the secret invitation seed (to pass on to invitee) and the invitation id (which could be used to revoke later)
    return { id, seed }
  }

  /**
   *  To invite an existing member's device:
   *
   *  On his laptop, Bob generates an invitation using a secret seed. He gets that seed to his phone
   *  using a QR code or by typing it in.
   *
   *  On his phone, Bob connects to his laptop (or to Alice or Charlie). Bob's phone presents its
   *  proof of invitation.
   *
   *  Once an existing device (Bob's laptop or Alice or Charlie) verifies Bob's phone's proof, they
   *  send it the team graph. Using the graph, the phone instantiates the team, then adds itself as
   *  a device.
   *
   *  Note: A member can only invite their own devices. A non-admin member can only remove their own
   *  device; an admin member can remove a device for anyone.
   */
  public inviteDevice({
    seed = invitations.randomSeed(),
    expiration = (Date.now() + 30 * 60 * 1000) as UnixTimestamp, // 30 minutes
  }: {
    /** A secret to be passed to the device via a side channel. If not provided, one will be randomly generated. */
    seed?: string

    /** Time when the invitation expires. Defaults to 30 minutes from now. */
    expiration?: UnixTimestamp
  } = {}): InviteResult {
    assert(!this.isServer, "Server can't invite a device")

    seed = normalize(seed)

    // Generate invitation

    const { userId } = this

    const maxUses = 1 // Can't invite multiple devices with the same invitation
    const invitation = invitations.create({ seed, expiration, maxUses, userId })
    const { id } = invitation

    // Post invitation to graph
    this.dispatch({
      type: 'INVITE_DEVICE',
      payload: { invitation },
    })

    // Return the secret invitation seed (to pass on to invitee) and the invitation id (which could be used to revoke later)
    return { id, seed }
  }

  /** Revoke an invitation. */
  public revokeInvitation = (id: string) => {
    // Mark the invitation as revoked
    this.dispatch({
      type: 'REVOKE_INVITATION',
      payload: { id },
    })
  }

  /** Returns true if the invitation has ever existed in this team (even if it's been used or revoked) */
  public hasInvitation(id: Base58): boolean
  public hasInvitation(proof: ProofOfInvitation): boolean
  public hasInvitation(proofOrId: Base58 | ProofOfInvitation): boolean {
    const id =
      typeof proofOrId === 'string' //
        ? proofOrId // String id was passed
        : proofOrId.id // Proof of invitation was passed
    return select.hasInvitation(this.state, id)
  }

  /** Gets the invitation corresponding to the given id. If it does not exist, throws an error. */
  public getInvitation = (id: Base58) => select.getInvitation(this.state, id)

  /** Check whether (1) the invitation is still valid, and (2) the proof of invitation checks out. */
  public validateInvitation = (proof: ProofOfInvitation) => {
    const { id } = proof
    // TODO: These invitation errors really should be structured & instead of returning messages we should return codes
    if (!this.hasInvitation(id)) {
      return invitations.fail("This invitation code doesn't match.")
    }

    const invitation = this.getInvitation(id)

    // Make sure the invitation hasn't already been used, hasn't expired, and hasn't been revoked
    const canBeUsedResult = invitations.invitationCanBeUsed(invitation, Date.now())
    if (canBeUsedResult !== VALID) {
      return canBeUsedResult
    }

    // Validate the proof of invitation
    return invitations.validate(proof, invitation)
  }

  /** An existing team member calls this to admit a new member & their device to the team based on proof of invitation */
  public admitMember = (
    proof: ProofOfInvitation,
    memberKeys: Keyset | KeysetWithSecrets, // We accept KeysetWithSecrets here to simplify testing - in practice we'll only receive Keyset
    userName: string // The new member's desired user-facing name
  ) => {
    const validation = this.validateInvitation(proof)
    if (!validation.isValid) {
      throw validation.error
    }

    const { id } = proof

    // TODO: make lockbox naming consistent?
    // lockbox_TeamKeysForMember
    // lockbox_UserKeysForDevice
    // lockbox_AdminKeysForMember

    // we know the team keys, so we can put them in a lockbox for the new member now (even if we're not an admin)
    const teamKeysLockbox = lockbox.create(this.teamKeys(), memberKeys)

    // Post admission to the graph
    this.dispatch({
      type: 'ADMIT_MEMBER',
      payload: {
        id,
        userName,
        memberKeys: redactKeys(memberKeys),
        lockboxes: [teamKeysLockbox],
      },
    })
  }

  /** A member calls this to admit a new device for themselves based on proof of invitation */
  public admitDevice = (proof: ProofOfInvitation, device: DeviceWithSecrets | Device) => {
    const validation = this.validateInvitation(proof)
    if (!validation.isValid) {
      throw validation.error
    }

    const { id } = proof
    const { userId, deviceName, keys } = device

    assert(this.userId === userId, "Can't admit someone else's device")

    const deviceLockbox = lockbox.create(this.context.user.keys, keys)

    // Post admission to the graph
    this.dispatch({
      type: 'ADMIT_DEVICE',
      payload: {
        id,
        userId,
        deviceName,
        deviceKeys: redactKeys(keys),
        lockboxes: [deviceLockbox],
      },
    })
  }

  /** Once the new member has received the graph and can instantiate the team, they call this to add their device. */
  public join = (teamKeyring: Keyring) => {
    assert(!this.isServer, "Can't join as member on server")

    const teamKeys = getLatestGeneration(teamKeyring)

    const deviceLockbox = lockbox.create(this.context.user.keys, this.context.device.keys)
    const device = redactDevice(this.context.device)
    this.dispatch(
      {
        type: 'ADD_DEVICE',
        payload: {
          device,
          lockboxes: [deviceLockbox],
        },
      },
      teamKeys
    )
  }

  /** ************** SERVERS */

  /**
   * A server is an always-on, always-connected device that is available to the team but does not
   * belong to any one member. For example, `automerge-repo` calls this a "sync server".
   *
   * A server has a host name that uniquely identifies it (e.g. `example.com`, `localhost:8080`, or
   * `188.26.221.135`).
   *
   * The expected usage is for the application to add a server or servers immediately after the team
   * is created. However, the application can add or remove servers at any time.
   *
   * Just before adding a server, the application should send it the latest graph and the team keys
   * (so it can decrypt the team graph). No invitation or authentication is necessary in this phase,
   * as a TLS connection to a trusted address is sufficient to ensure the security of that
   * connection. In response, the server should send back its public keys. This library is not
   * involved in that process.
   *
   * The application should then add the server to the team using `addServer`, passing in the
   * server's public keys. At that point the server will be able to authenticate with other devices
   * using the same protocol as for members.
   *
   * The only actions that a server can dispatch to the graph are `ADMIT_MEMBER` and `ADMIT_DEVICE`.
   * The server needs to be able to admit invited members and devices in order to support
   * star-shaped networks where every device connects to a server, rather than directly to each
   * other.)
   */
  public addServer = (server: Server) => {
    const lockboxes = this.createMemberLockboxes(cast.toMember(server))

    this.dispatch({
      type: 'ADD_SERVER',
      payload: { server, lockboxes },
    })
  }

  // TODO: If we wanted to restrict the server's read access to application data (as opposed to the
  // team membership data), we would currently have to create a new role that is only for human
  // members (and ensure that every member was added to it), and encrypt the application data with
  // that role's keys. It might make more sense to separate out the **graph keys** (for encrypting
  // the team graph) from the **team keys** (for encrypting data for human members of the team).

  /** Removes a server from the team. */
  public removeServer = (host: string) => {
    this.dispatch({
      type: 'REMOVE_SERVER',
      payload: { host },
    })
  }

  /** Returns a list of all servers on the team. */
  public servers(): Server[] // Overload: all servers
  /** Returns the server with the given host */
  public servers(host: Host, options?: { includeRemoved: boolean }): Server // Overload: one server
  //
  public servers(
    host: Host = ALL, //
    options = { includeRemoved: true }
  ) {
    return host === ALL //
      ? this.state.servers // All servers
      : select.server(this.state, host, options) // One server
  }

  /** Returns true if the server was once on the team but was removed */
  public serverWasRemoved = (host: Host) => select.serverWasRemoved(this.state, host)

  public hasServer = (host: Host) => select.hasServer(this.state, host)

  /** ************** CRYPTO */

  /**
   * Symmetrically encrypt a payload for the given scope using keys available to the current user.
   *
   * > *Note*: Since this convenience function uses symmetric encryption, we can only use it to
   * encrypt for scopes the current user has keys for (e.g. the whole team, or roles they belong
   * to). If we need to encrypt asymmetrically, we use the functions in the crypto module directly.
   */
  public encrypt = (payload: Payload, roleName?: string): EncryptedEnvelope => {
    const scope = roleName ? { type: KeyType.ROLE, name: roleName } : TEAM_SCOPE
    const { secretKey, generation } = this.keys(scope)
    return {
      contents: symmetric.encrypt(payload, secretKey),
      recipient: { ...scope, generation },
    }
  }

  /** Decrypt a payload using keys available to the current user. */
  public decrypt = (message: EncryptedEnvelope): Payload => {
    const { secretKey } = this.keys(message.recipient)
    return symmetric.decrypt(message.contents, secretKey)
  }

  /** Sign a message using the current user's keys. */
  public sign = (contents: Payload): SignedEnvelope => {
    assert(this.context.user)
    const {
      keys: {
        type,
        name,
        generation,
        signature: { secretKey },
      },
    } = this.context.user

    return {
      contents,
      signature: signatures.sign(contents, secretKey),
      author: { type, name, generation },
    }
  }

  /** Verify a signed message against the author's public key */
  public verify = (message: SignedEnvelope): boolean =>
    signatures.verify({
      payload: message.contents,
      signature: message.signature,
      publicKey: this.members(message.author.name).keys.signature,
    })

  /** ************** KEYS
   *
   * These methods all return keysets *with secrets* that are available to the local user. To get
   * other members' public keys, look up the member - the `keys` property contains their public keys.
   */

  /**
   * Returns the secret keyset (if available to the current device) for the given type and name. To
   * get other members' public keys, look up the member - the `keys` property contains their public
   * keys.
   */
  public keys = (scope: KeyMetadata | KeyScope) =>
    select.keys(this.state, this.context.device.keys, scope)

  /** Returns the keys for the given role. */
  public roleKeys = (roleName: string, generation?: number) =>
    this.keys({ type: KeyType.ROLE, name: roleName, generation })

  /** Returns the current team keys or a specific generation of team keys */
  public teamKeys = (generation?: number) => this.keys({ ...TEAM_SCOPE, generation })

  public teamKeyring = () => select.teamKeyring(this.state, this.context.device.keys)

  /** Returns the admin keyset. */
  public adminKeys = (generation?: number) => this.roleKeys(ADMIN, generation)

  /**
   * Replaces the current user or device's secret keyset with the one provided.
   * (This can also be used by an admin to change another user's secret keyset.)
   */
  public changeKeys = (newKeys: KeysetWithSecrets) => {
    const { device, user } = this.context
    const isForUser = newKeys.type === USER
    const isForDevice = newKeys.type === DEVICE
    const isForServer = newKeys.type === KeyType.SERVER

    const oldKeys: KeysetWithSecrets = isForDevice ? device.keys : user.keys
    newKeys.generation = oldKeys.generation + 1

    // Treat the old keys as compromised, and generate new lockboxes for any keys they could see
    const lockboxes = this.rotateKeys(newKeys)

    // Post our new public keys to the graph
    const type = isForDevice
      ? 'CHANGE_DEVICE_KEYS'
      : isForUser
      ? 'CHANGE_MEMBER_KEYS'
      : 'CHANGE_SERVER_KEYS'

    const keys = redactKeys(newKeys)
    this.dispatch({ type, payload: { keys, lockboxes } })

    // Update our user and/or device keys in context
    // (a server plays the role of both a user and a device)
    if (isForServer || isForDevice) {
      device.keys = newKeys
    }

    if (isForServer || isForUser) {
      user.keys = newKeys
    }
  }

  private checkForPendingKeyRotations() {
    // Only admins can rotate keys
    if (!this.memberIsAdmin(this.userId)) {
      return
    }

    // TODO: should we introduce a random delay here, so these don't pile up?
    for (const userId of this.state.pendingKeyRotations) {
      // We don't know if the user was added to any other roles, so we're just preemptively rotating
      // all lockboxes *we* can see (since we're an admin, we have access to all keys)
      const lockboxes = this.rotateKeys({
        type: USER,
        name: this.userId,
      })
      this.dispatch({ type: 'ROTATE_KEYS', payload: { userId, lockboxes } })
    }
  }

  private readonly createMemberLockboxes = (member: Member) => {
    const roleKeys = member.roles.map(this.roleKeys)
    const createLockbox = (keys: KeysetWithSecrets) => lockbox.create(keys, member.keys)
    return [...roleKeys, this.teamKeys()].map(createLockbox)
  }

  /**
   * Given a compromised scope (e.g. a member or a role), find all scopes that are visible from that
   * scope, and generates new keys and lockboxes for each of those. Returns all of the new lockboxes
   * in a single array to be posted to the graph.
   *
   * You can pass it a scope, or a keyset (which includes the scope information). If you pass a
   * keyset, it will replace the existing keys with these.
   *
   * @param compromised If `compromised` is a keyset, that will become the new keyset for the
   * compromised scope. If it is just a scope, new keys will be randomly generated for that scope.
   */
  private readonly rotateKeys = (compromised: KeyScope | KeysetWithSecrets) => {
    const newKeyset = isKeyset(compromised)
      ? compromised // We're given a keyset - use it as the new keys
      : createKeyset(compromised) // We're just given a scope - generate new keys for it

    // identify all the keys that are indirectly compromised
    const visibleScopes = select.visibleScopes(this.state, compromised)
    const otherNewKeysets = visibleScopes.map(scope => createKeyset(scope))

    // Generate new keys for each one
    const newKeysets = [newKeyset, ...otherNewKeysets]

    // Create new lockboxes for each of these
    const newLockboxes = newKeysets.flatMap(newKeyset => {
      const oldLockboxes = select.lockboxesInScope(this.state, newKeyset)

      return oldLockboxes.map(oldLockbox => {
        // Check whether we have new keys for the recipient of this lockbox
        const updatedKeyset = newKeysets.find(k => scopesMatch(k, oldLockbox.recipient))
        return lockbox.rotate({
          oldLockbox,
          newContents: newKeyset,
          // If we did, address the new lockbox to those keys
          updatedRecipientKeys: updatedKeyset ? redactKeys(updatedKeyset) : undefined,
        })
      })
    })

    return newLockboxes
  }
}
