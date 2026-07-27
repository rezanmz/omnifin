import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const LEGACY_ENVELOPE_VERSION = "v1";
const ENVELOPE_VERSION = "v2";
const IV_BYTES = 12;
const ROOT_KEY_BYTES = 32;
const DERIVATION_SALT = Buffer.from("omnifin:v1:key-derivation", "utf8");
const ENVELOPE_KEY_PURPOSE = "omnifin:v1:envelope:aes-256-gcm";
const PRIVACY_HASH_KEY_PURPOSE = "omnifin:v1:privacy-hash:hmac-sha256";

export type PrivacyHashDomain =
  | "ip_address"
  | "oidc_failure_audit_bucket"
  | "oidc_failure_audit_ip_address"
  | "oidc_failure_audit_user_agent"
  | "oidc_session_id"
  | "rate_limit_client"
  | "user_agent";

function deriveDomainKey(rootKey: Buffer, purpose: string) {
  if (rootKey.length !== ROOT_KEY_BYTES) {
    throw new Error("Cryptographic root keys must be 32 bytes.");
  }
  return Buffer.from(
    hkdfSync("sha256", rootKey, DERIVATION_SALT, Buffer.from(purpose, "utf8"), ROOT_KEY_BYTES),
  );
}

function encode(value: Buffer) {
  return value.toString("base64url");
}

function decode(value: string) {
  return Buffer.from(value, "base64url");
}

export class EnvelopeCipher {
  private readonly key: Buffer;
  private readonly legacyKey: Buffer;

  public constructor(rootKey: Buffer) {
    if (rootKey.length !== ROOT_KEY_BYTES) {
      throw new Error("EnvelopeCipher requires a 32-byte key.");
    }
    this.legacyKey = Buffer.from(rootKey);
    this.key = deriveDomainKey(rootKey, ENVELOPE_KEY_PURPOSE);
  }

  public encrypt(plaintext: string, context: string) {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(context, "utf8"));
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [ENVELOPE_VERSION, encode(iv), encode(ciphertext), encode(tag)].join(".");
  }

  public decryptWithMetadata(envelope: string, context: string) {
    const parts = envelope.split(".");
    const version = parts[0];
    if (
      parts.length !== 4 ||
      (version !== ENVELOPE_VERSION && version !== LEGACY_ENVELOPE_VERSION)
    ) {
      throw new Error("Unsupported encrypted value format.");
    }

    const ivPart = parts[1];
    const ciphertextPart = parts[2];
    const tagPart = parts[3];
    if (!ivPart || !ciphertextPart || !tagPart) throw new Error("Malformed encrypted value.");

    try {
      const key = version === LEGACY_ENVELOPE_VERSION ? this.legacyKey : this.key;
      const decipher = createDecipheriv("aes-256-gcm", key, decode(ivPart));
      decipher.setAAD(Buffer.from(context, "utf8"));
      decipher.setAuthTag(decode(tagPart));
      return {
        needsReencryption: version === LEGACY_ENVELOPE_VERSION,
        plaintext: Buffer.concat([
          decipher.update(decode(ciphertextPart)),
          decipher.final(),
        ]).toString("utf8"),
      };
    } catch {
      throw new Error("Encrypted value could not be authenticated.");
    }
  }

  public decrypt(envelope: string, context: string) {
    return this.decryptWithMetadata(envelope, context).plaintext;
  }
}

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

export function hashToken(token: string) {
  return createHash("sha256").update(token, "utf8").digest("base64url");
}

export function privacyHash(domain: PrivacyHashDomain, value: string, key: Buffer) {
  const privacyKey = deriveDomainKey(key, `${PRIVACY_HASH_KEY_PURPOSE}:${domain}`);
  try {
    return createHmac("sha256", privacyKey).update(value, "utf8").digest("base64url").slice(0, 22);
  } finally {
    privacyKey.fill(0);
  }
}

export function constantTimeTextEqual(left: string, right: string) {
  const leftDigest = createHash("sha256").update(left, "utf8").digest();
  const rightDigest = createHash("sha256").update(right, "utf8").digest();
  return timingSafeEqual(leftDigest, rightDigest);
}
