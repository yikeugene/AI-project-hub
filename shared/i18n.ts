export const LOCALES = ['en', 'zh-TW'] as const;
export type Locale = typeof LOCALES[number];
export const DEFAULT_LOCALE: Locale = 'en';
export type MessageParams = Readonly<Record<string, string | number>>;
export type MessageCatalog<K extends string = string> = { [L in Locale]: Record<K, string> };

export function normalizeLocale(value: unknown): Locale {
  return value === 'zh-TW' ? 'zh-TW' : DEFAULT_LOCALE;
}

export function translate<K extends string>(catalog: MessageCatalog<K>, locale: Locale, key: K, params: MessageParams = {}): string {
  const message = catalog[locale][key] ?? catalog.en[key];
  return message.replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g, (placeholder, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : placeholder);
}

export function createTranslator<K extends string>(catalog: MessageCatalog<K>, locale: Locale) {
  return (key: K, params?: MessageParams) => translate(catalog, locale, key, params);
}

/** Retain the message identity so an already-visible error follows a language change. */
export class LocalizedError<K extends string = string> extends Error {
  constructor(readonly catalog: MessageCatalog<K>, readonly key: K, readonly params: MessageParams = {}) {
    super(translate(catalog, DEFAULT_LOCALE, key, params));
    this.name = 'LocalizedError';
  }
  localize(locale: Locale): string { return translate(this.catalog, locale, this.key, this.params); }
}
