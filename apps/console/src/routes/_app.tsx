// The signed-in layout. Rendered in the browser only (the token lives in sessionStorage), and it sends you to
// sign-in when there is no session or the API ends it with a 401.
import { Outlet, createFileRoute, redirect, useNavigate } from '@tanstack/react-router';
import { useEffect } from 'react';
import { AppShell } from '../components/AppShell';
import { getSession, useSession } from '../lib/session';

export const Route = createFileRoute('/_app')({
  ssr: false,
  beforeLoad: ({ location }) => {
    if (!getSession()) throw redirect({ to: '/sign-in', search: { redirect: location.href } });
  },
  component: AppLayout,
});

function AppLayout() {
  const session = useSession();
  const navigate = useNavigate();
  useEffect(() => {
    if (!session) void navigate({ to: '/sign-in', search: { redirect: window.location.pathname + window.location.search } });
  }, [session, navigate]);
  if (!session) return null;
  return (
    <AppShell session={session}>
      <Outlet />
    </AppShell>
  );
}
