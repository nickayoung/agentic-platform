// The signed-in frame: navigation, who you are (from GET /me, or the sign-in token until /me is live) and sign out.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { meQuery } from '../lib/queries';
import { clearSession, type Session } from '../lib/session';

const NAV = [
  { to: '/roster', label: 'Desk roster' },
  { to: '/classes', label: 'Classes' },
  { to: '/people', label: 'People' },
  { to: '/time-off', label: 'Time off' },
  { to: '/hours', label: 'Hours' },
  { to: '/config', label: 'Config' },
] as const;

const groupRole = (g: string) => g.replace(/^lotus-/, '').replace(/s$/, '');

export function AppShell({ session, children }: { session: Session; children: ReactNode }) {
  const me = useQuery(meQuery());
  const qc = useQueryClient();
  const navigate = useNavigate();
  const name = me.data?.resource?.name ?? session.user.name;
  const roles = me.data ? me.data.roles : session.user.groups.filter((g) => g !== 'lotus-staff').map(groupRole);
  const locations = me.data ? me.data.locations : session.user.studios ?? null;

  const signOut = () => {
    clearSession();
    qc.clear();
    void navigate({ to: '/sign-in' });
  };

  return (
    <div className="shell">
      <header className="topbar">
        <Link to="/roster" className="brand">
          <span className="brand-mark" aria-hidden>◐</span>
          <span>Kairos</span>
          <span className="brand-tenant">Lotus &amp; Line</span>
        </Link>
        <span className="env-chip" title="Preview environment">preview</span>
        <div className="whoami">
          <div className="whoami-text">
            <span className="whoami-name">{name}</span>
            <span className="whoami-roles">
              {roles.map((r) => <span key={r} className="role-chip">{r}</span>)}
              {locations && locations.length > 0 && <span className="muted small">· {locations.join(', ')}</span>}
              {me.isError && <span className="muted small" title="GET /me isn't available yet; showing the sign-in token's groups"> (from token)</span>}
            </span>
          </div>
          <button type="button" className="btn btn-ghost" onClick={signOut}>Sign out</button>
        </div>
      </header>
      <nav className="sidenav" aria-label="Main">
        <div className="sidenav-inner">
          {NAV.map((n) => (
            <Link key={n.to} to={n.to} className="nav-link" activeProps={{ className: 'nav-link active', 'aria-current': 'page' }}>
              {n.label}
            </Link>
          ))}
        </div>
      </nav>
      <main className="main">{children}</main>
    </div>
  );
}
