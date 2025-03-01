import { type Keyset, type KeysetWithSecrets } from '@localfirst/crdx'
import { truncateHashes } from 'util/index.js'

export const keysetSummary = (keyset: Keyset | KeysetWithSecrets) => {
  const { name, generation, encryption } = keyset
  const publicKey = typeof encryption === 'string' ? encryption : encryption.publicKey
  return `${name}(${truncateHashes(publicKey)})#${generation}`
}
