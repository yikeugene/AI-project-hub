import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { DEFAULT_LOCALE, translate, type Locale, type MessageCatalog, type MessageParams } from '../shared/i18n';

interface LanguageContext { locale: Locale; setLocale: (locale: Locale) => void }
const I18nContext = createContext<LanguageContext>({ locale: DEFAULT_LOCALE, setLocale: () => {} });

export function I18nProvider({ children, initialLocale = DEFAULT_LOCALE }: { children: ReactNode; initialLocale?: Locale }) {
  const [locale, setLocale] = useState<Locale>(initialLocale);
  const value = useMemo(() => ({ locale, setLocale }), [locale]);
  useEffect(() => { document.documentElement.lang = locale; }, [locale]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() { return useContext(I18nContext); }
export function useLocale() { return useI18n().locale; }
export function useT<K extends string>(catalog: MessageCatalog<K>) {
  const { locale } = useI18n();
  return useCallback((key: K, params?: MessageParams) => translate(catalog, locale, key, params), [catalog, locale]);
}
