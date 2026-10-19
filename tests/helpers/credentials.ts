import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { SecureCodec } from '../../server/relay.js';

/** Isolated test-only encryption; the packaged app uses Electron/Windows DPAPI instead. */
export function testCredentialCodec(key = randomBytes(32)): SecureCodec {
  return {
    available: () => true,
    encrypt(value) {
      const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce);
      const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]);
    },
    decrypt(value) {
      const bytes = Buffer.from(value), decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
    },
  };
}
