import { createCipheriv, createDecipheriv, createHmac, randomBytes, scryptSync } from "node:crypto";

const VERSION = 1;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

export class CryptoService {
  private constructor(
    private readonly encryptionKey: Buffer,
    private readonly indexKey: Buffer
  ) {}

  static derive(token: string, salt: Buffer): CryptoService {
    const material = scryptSync(token, Buffer.concat([salt, Buffer.from("imap2api:v1")]), 64);
    return new CryptoService(material.subarray(0, 32), material.subarray(32));
  }

  encrypt(value: unknown): Buffer {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv("aes-256-gcm", this.encryptionKey, iv);
    const plaintext = Buffer.from(JSON.stringify(value), "utf8");
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), ciphertext]);
  }

  decrypt<T>(payload: Buffer): T {
    if (payload[0] !== VERSION || payload.length < 1 + IV_LENGTH + TAG_LENGTH) {
      throw new Error("Unsupported or invalid encrypted payload");
    }
    const iv = payload.subarray(1, 1 + IV_LENGTH);
    const tag = payload.subarray(1 + IV_LENGTH, 1 + IV_LENGTH + TAG_LENGTH);
    const ciphertext = payload.subarray(1 + IV_LENGTH + TAG_LENGTH);
    const decipher = createDecipheriv("aes-256-gcm", this.encryptionKey, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(plaintext.toString("utf8")) as T;
  }

  fingerprint(value: string): string {
    return createHmac("sha256", this.indexKey).update(value.trim().toLowerCase()).digest("hex");
  }
}
