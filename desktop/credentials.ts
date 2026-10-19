import type { SecureCodec } from '../server/relay.js';
import { DEFAULT_LOCALE, translate, type Locale } from '../shared/i18n.js';
import { desktopMessages } from '../shared/locales/desktop.js';

interface StorageBackend {
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend?(): string;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}
/** The implementation is injected after Electron is ready; no plaintext fallback exists. */
export function createCredentialCodec(storage: StorageBackend, platform = process.platform, locale: () => Locale = () => DEFAULT_LOCALE): SecureCodec {
  const available = () => storage.isEncryptionAvailable() && !(platform === 'linux' && storage.getSelectedStorageBackend?.() === 'basic_text');
  return {
    available,
    encrypt(value) {
      if (!available()) throw new Error(translate(desktopMessages, locale(), 'credentials'));
      return storage.encryptString(value);
    },
    decrypt(value) {
      if (!available()) throw new Error(translate(desktopMessages, locale(), 'credentials'));
      return storage.decryptString(Buffer.from(value));
    },
  };
}
