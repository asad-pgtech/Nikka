/**
 * Identity keys and signed statements.
 *
 * Curve operations use @noble/curves (audited, pure JS) because WebCrypto Ed25519/X25519 is not
 * available on iOS Safari 16.4, one of the target browsers. Private keys only live in memory while the
 * vault is unlocked and are persisted encrypted under the vault key.
 */
import { ed25519, x25519 } from '@noble/curves/ed25519';
import { b64decode, b64encode, concatBytes, utf8 } from '../encoding';
import { deriveCode } from './code';

export interface IdentityKeys {
  signPriv: Uint8Array;
  signPub: Uint8Array;
  dhPriv: Uint8Array;
  dhPub: Uint8Array;
}

export interface Identity extends IdentityKeys {
  code: string;
}

/** Serialized form stored (encrypted) in the vault. */
export interface StoredIdentity {
  signPriv: string;
  dhPriv: string;
  displayName: string;
  /** Own profile picture (data: URL), shared with friends end-to-end encrypted. */
  avatar?: string;
  avatarTs?: number;
}

export function generateIdentityKeys(): IdentityKeys {
  const signPriv = ed25519.utils.randomPrivateKey();
  const dhPriv = x25519.utils.randomPrivateKey();
  return {
    signPriv,
    signPub: ed25519.getPublicKey(signPriv),
    dhPriv,
    dhPub: x25519.getPublicKey(dhPriv),
  };
}

export async function identityFromKeys(keys: IdentityKeys): Promise<Identity> {
  return { ...keys, code: await deriveCode(keys.signPub) };
}

export async function identityFromStored(stored: StoredIdentity): Promise<Identity> {
  const signPriv = b64decode(stored.signPriv);
  const dhPriv = b64decode(stored.dhPriv);
  return identityFromKeys({
    signPriv,
    signPub: ed25519.getPublicKey(signPriv),
    dhPriv,
    dhPub: x25519.getPublicKey(dhPriv),
  });
}

export function serializeIdentity(id: IdentityKeys, displayName: string): StoredIdentity {
  return { signPriv: b64encode(id.signPriv), dhPriv: b64encode(id.dhPriv), displayName };
}

/** Best-effort zeroization when locking. */
export function wipeIdentity(id: IdentityKeys): void {
  id.signPriv.fill(0);
  id.dhPriv.fill(0);
}

export const sign = (msg: Uint8Array, priv: Uint8Array): Uint8Array => ed25519.sign(msg, priv);

export function verify(sig: Uint8Array, msg: Uint8Array, pub: Uint8Array): boolean {
  try {
    return ed25519.verify(sig, msg, pub);
  } catch {
    return false;
  }
}

export function x25519Shared(priv: Uint8Array, peerPub: Uint8Array): Uint8Array {
  return x25519.getSharedSecret(priv, peerPub);
}

// ---- Signed statements (docs/PROTOCOL.md) -------------------------------------------------------

export const agreementKeyStatement = (dhPub: Uint8Array): Uint8Array =>
  concatBytes(utf8('lanchat-akey-v1:'), dhPub);

export const authStatement = (nonce: string): Uint8Array => utf8(`lanchat-auth-v1:${nonce}`);

export function friendStatement(
  kind: 'freq' | 'facc',
  from: string,
  to: string,
  identityKeyB64: string,
  agreementKeyB64: string,
  ts: number,
): Uint8Array {
  return utf8(`lanchat-${kind}-v1|${from}|${to}|${identityKeyB64}|${agreementKeyB64}|${ts}`);
}

export interface PublicKeys {
  identityKey: string;
  agreementKey: string;
  agreementKeySig: string;
}

export function publicKeysOf(id: Identity): PublicKeys {
  return {
    identityKey: b64encode(id.signPub),
    agreementKey: b64encode(id.dhPub),
    agreementKeySig: b64encode(sign(agreementKeyStatement(id.dhPub), id.signPriv)),
  };
}

/** Verify that a peer's published keys are self-consistent and bound to its code. */
export async function verifyPeerKeys(code: string, keys: PublicKeys): Promise<boolean> {
  try {
    const idKey = b64decode(keys.identityKey);
    const akey = b64decode(keys.agreementKey);
    if (idKey.length !== 32 || akey.length !== 32) return false;
    if ((await deriveCode(idKey)) !== code) return false;
    return verify(b64decode(keys.agreementKeySig), agreementKeyStatement(akey), idKey);
  } catch {
    return false;
  }
}
