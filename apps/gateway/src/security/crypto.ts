import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const ENVELOPE_VERSION = "v1";
const IV_BYTES = 12;

function encode(value: Buffer) {
  return value.toString("base64url");
}

function decode(value: string) {
  return Buffer.from(value, "base64url");
}

export class EnvelopeCipher {
  public constructor(private readonly key: Buffer) {
    if (key.length !== 32) throw new Error("EnvelopeCipher requires a 32-byte key.");
  }

  public encrypt(plaintext: string, context: string) {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(context, "utf8"));
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [ENVELOPE_VERSION, encode(iv), encode(ciphertext), encode(tag)].join(".");
  }

  public decrypt(envelope: string, context: string) {
    const parts = envelope.split(".");
    if (parts.length !== 4 || parts[0] !== ENVELOPE_VERSION) {
      throw new Error("Unsupported encrypted value format.");
    }

    const ivPart = parts[1];
    const ciphertextPart = parts[2];
    const tagPart = parts[3];
    if (!ivPart || !ciphertextPart || !tagPart) throw new Error("Malformed encrypted value.");

    try {
      const decipher = createDecipheriv("aes-256-gcm", this.key, decode(ivPart));
      decipher.setAAD(Buffer.from(context, "utf8"));
      decipher.setAuthTag(decode(tagPart));
      return Buffer.concat([decipher.update(decode(ciphertextPart)), decipher.final()]).toString(
        "utf8",
      );
    } catch {
      throw new Error("Encrypted value could not be authenticated.");
    }
  }
}

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

export function hashToken(token: string) {
  return createHash("sha256").update(token, "utf8").digest("base64url");
}

export function privacyHash(value: string, key: Buffer) {
  return createHmac("sha256", key).update(value, "utf8").digest("base64url").slice(0, 22);
}

export function constantTimeTextEqual(left: string, right: string) {
  const leftDigest = createHash("sha256").update(left, "utf8").digest();
  const rightDigest = createHash("sha256").update(right, "utf8").digest();
  return timingSafeEqual(leftDigest, rightDigest);
}
