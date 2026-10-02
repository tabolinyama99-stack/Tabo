import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, setCsrf } from './api.js';

const SessionCtx = createContext(null);

function hexOk(c) { return /^#[0-9a-f]{6}$/i.test(c || ''); }
function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16); let r = (n >> 16) + amt, g = ((n >> 8) & 255) + amt, b = (n & 255) + amt;
  r = Math.max(0, Math.min(255, r)); g = Math.max(0, Math.min(255, g)); b = Math.max(0, Math.min(255, b));
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}
function luminance(hex) { const n = parseInt(hex.slice(1), 16); const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(n >> 16) + 0.7152 * f((n >> 8) & 255) + 0.0722 * f(n & 255); }

/** Apply company branding (colours, theme, favicon, title) to the whole app. */
export function applyBranding(branding, companyId, companyName) {
  const root = document.documentElement;
  const theme = localStorageGet('tael-theme') || branding?.theme || 'system';
  const dark = theme === 'dark' || (theme === 'system' && window.matchMedia?.('(prefers-color-scheme: dark)').matches);
  root.dataset.theme = dark ? 'dark' : 'light';
  root.dataset.density = branding?.density || 'comfortable';
  const style = root.style;
  if (!dark && hexOk(branding?.primary_color)) {
    style.setProperty('--brand', branding.primary_color);
    style.setProperty('--brand-strong', shade(branding.primary_color, -24));
    style.setProperty('--on-brand', luminance(branding.primary_color) > 0.45 ? '#06140f' : '#ffffff');
    style.setProperty('--chart-1', branding.primary_color);
  } else ['--brand', '--brand-strong', '--on-brand', '--chart-1'].forEach((p) => style.removeProperty(p));
  if (!dark && hexOk(branding?.secondary_color)) { style.setProperty('--accent', branding.secondary_color); style.setProperty('--chart-2', branding.secondary_color); }
  else ['--accent', '--chart-2'].forEach((p) => style.removeProperty(p));
  const fav = document.getElementById('app-favicon');
  if (fav) fav.href = branding?.favicon_document_id && companyId ? `/api/public/branding/${companyId}/favicon?v=${branding.favicon_document_id}` : '/favicon.svg';
  if (companyName) document.title = `${companyName} · TAEL Books`;
}
export function localStorageGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
export function localStorageSet(k, v) { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* ignore */ } }

export function SessionProvider({ children }) {
  const [state, setState] = useState({ loading: true, me: null });
  const refresh = useCallback(async () => {
    try {
      const me = await api.get('/auth/me');
      setCsrf(me.csrf_token);
      applyBranding({ ...me.settings?.branding, density: me.settings?.appearance?.density }, me.company?.id, me.company?.name);
      setState({ loading: false, me });
      return me;
    } catch {
      setState({ loading: false, me: null });
      return null;
    }
  }, []);
  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => {
    const h = () => setState({ loading: false, me: null });
    window.addEventListener('tael:unauthorized', h);
    return () => window.removeEventListener('tael:unauthorized', h);
  }, []);
  const value = useMemo(() => {
    const me = state.me;
    const perms = new Set(me?.permissions || []);
    return {
      ...state, refresh,
      can: (...p) => !!me && (me.user.is_super_admin || p.some((x) => perms.has(x))),
      isSuperAdmin: !!me?.user?.is_super_admin,
      term: (k) => me?.settings?.terminology?.[k] || k,
      logout: async () => { try { await api.post('/auth/logout'); } catch { /* ignore */ } setState({ loading: false, me: null }); },
    };
  }, [state, refresh]);
  return <SessionCtx.Provider value={value}>{children}</SessionCtx.Provider>;
}

export const useSession = () => useContext(SessionCtx);
