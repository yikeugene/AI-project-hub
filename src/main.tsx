import { Component, StrictMode, useEffect, type ErrorInfo, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { createTranslator, DEFAULT_LOCALE, type Locale } from '../shared/i18n';
import App from './App';
import { I18nProvider, useLocale, useT } from './i18n';
import { shellCatalog } from './locales/shell';
import './styles.css';

class AppErrorBoundary extends Component<{ children: ReactNode; locale?: Locale }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error('AI Project Hub render error', error, info.componentStack); }
  render() {
    const t = createTranslator(shellCatalog, this.props.locale ?? DEFAULT_LOCALE);
    if (this.state.error) return <main className="fatal-error"><h1>{t('boundary.title')}</h1><p>{t('boundary.description')}</p><pre>{this.state.error.message}</pre><button className="button button-primary" onClick={() => window.location.reload()}>{t('boundary.reload')}</button></main>;
    return this.props.children;
  }
}
function WorkspaceRoot() {
  const locale = useLocale(); const t = useT(shellCatalog);
  useEffect(() => {
    document.title = t('document.title');
    document.querySelector('meta[name="description"]')?.setAttribute('content', t('document.description'));
  }, [t]);
  return <AppErrorBoundary locale={locale}><App /></AppErrorBoundary>;
}
createRoot(document.getElementById('root')!).render(<StrictMode><I18nProvider><WorkspaceRoot /></I18nProvider></StrictMode>);
