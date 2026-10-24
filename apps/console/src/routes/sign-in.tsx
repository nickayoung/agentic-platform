// Demo sign-in (preview only): pick a demo staff member from the sign-in service, enter the demo password, and
// keep the token it issues. Production uses the tenant's staff sign-in instead (§19.14).
import { useForm } from '@tanstack/react-form';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { ProblemNotice } from '../components/Problem';
import { idp } from '../lib/api';
import { startSession, useSession } from '../lib/session';
import type { IdpUser } from '../lib/types';

export const Route = createFileRoute('/sign-in')({
  ssr: false,
  validateSearch: (s: Record<string, unknown>): { redirect?: string } =>
    typeof s.redirect === 'string' && s.redirect.startsWith('/') && !s.redirect.startsWith('//') ? { redirect: s.redirect } : {},
  component: SignIn,
});

const GROUPS: { key: string; label: string }[] = [
  { key: 'lotus-owners', label: 'Owner' },
  { key: 'lotus-managers', label: 'Studio managers' },
  { key: 'lotus-desk', label: 'Desk staff' },
  { key: 'lotus-teachers', label: 'Teachers' },
];

const groupOf = (u: IdpUser) => GROUPS.find((g) => u.groups.includes(g.key))?.key ?? 'other';
const pretty = (k: string) => k.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

function SignIn() {
  const { redirect } = Route.useSearch();
  const session = useSession();
  const navigate = useNavigate();
  const router = useRouter();
  const qc = useQueryClient();
  const [error, setError] = useState<unknown>(null);
  const users = useQuery({ queryKey: ['idp', 'users'], queryFn: idp.users, staleTime: Infinity });

  const done = () => {
    if (redirect && redirect !== '/sign-in') router.history.push(redirect);
    else void navigate({ to: '/roster' });
  };

  useEffect(() => {
    if (session) done();
  }, []); // only on arrival: already signed in

  const form = useForm({
    defaultValues: { sub: '', password: '' },
    onSubmit: async ({ value }) => {
      setError(null);
      try {
        const r = await idp.token(value.sub, value.password);
        qc.clear();
        startSession(r.token, r.user);
        done();
      } catch (e) {
        setError(e);
      }
    },
  });

  return (
    <div className="signin-page">
      <div className="signin-card">
        <div className="signin-brand">
          <span className="brand-mark" aria-hidden>◐</span>
          <div>
            <h1>Kairos console</h1>
            <p className="muted">Lotus &amp; Line Yoga · <span className="env-chip">preview</span></p>
          </div>
        </div>
        <p className="muted small">Demo sign-in for the preview tenant. Choose who you are, then enter the demo password.</p>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void form.handleSubmit();
          }}
        >
          <form.Field name="sub" validators={{ onSubmit: ({ value }) => (value ? undefined : 'Choose who you are') }}>
            {(field) => (
              <fieldset className="user-picker">
                <legend>Sign in as</legend>
                {users.isPending && <div className="skeleton" aria-busy="true" />}
                {users.isError && <ProblemNotice error={users.error} title="Couldn't load the demo users" />}
                {users.data &&
                  [...GROUPS, { key: 'other', label: 'Other' }].map((g) => {
                    const list = users.data.items.filter((u) => groupOf(u) === g.key);
                    if (!list.length) return null;
                    return (
                      <div key={g.key} className="user-group">
                        <h3>{g.label}</h3>
                        <div className="user-grid">
                          {list.map((u) => (
                            <label key={u.sub} className={field.state.value === u.sub ? 'user-option selected' : 'user-option'}>
                              <input type="radio" name="sub" value={u.sub} checked={field.state.value === u.sub} onChange={() => field.handleChange(u.sub)} />
                              <span className="user-name">{u.name}</span>
                              <span className="user-meta">{u.studios?.length ? u.studios.map(pretty).join(', ') : 'All studios'}</span>
                            </label>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                {field.state.meta.errors.length > 0 && <p className="field-error">{field.state.meta.errors.join(', ')}</p>}
              </fieldset>
            )}
          </form.Field>

          <form.Field name="password" validators={{ onSubmit: ({ value }) => (value ? undefined : 'Enter the demo password') }}>
            {(field) => (
              <label className="field">
                <span>Password</span>
                <input
                  type="password"
                  autoComplete="current-password"
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value)}
                />
                {field.state.meta.errors.length > 0 && <span className="field-error">{field.state.meta.errors.join(', ')}</span>}
              </label>
            )}
          </form.Field>

          <form.Subscribe selector={(s) => s.isSubmitting}>
            {(submitting) => (
              <button type="submit" className="btn btn-primary btn-block" disabled={submitting}>
                {submitting ? 'Signing in…' : 'Sign in'}
              </button>
            )}
          </form.Subscribe>
        </form>
        {error !== null && <ProblemNotice error={error} title="Sign-in refused" />}
      </div>
    </div>
  );
}
