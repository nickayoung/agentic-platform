// The document shell. Its loader is the only server work the console does: hand the page the API and sign-in
// base URLs from wrangler vars (§19.14: no business calls go through the console's Worker).
import type { QueryClient } from '@tanstack/react-query';
import { HeadContent, Outlet, Scripts, createRootRouteWithContext } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { getRuntimeConfig, setRuntimeConfig } from '../lib/runtime-config';
import css from '../styles.css?url';

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  loader: async () => {
    const config = await getRuntimeConfig();
    setRuntimeConfig(config);
    return config;
  },
  staleTime: Infinity,
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { name: 'color-scheme', content: 'light dark' },
      { title: 'Kairos console · Lotus & Line' },
    ],
    links: [
      { rel: 'stylesheet', href: css },
      { rel: 'icon', href: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="%235b5bd6"/><path d="M8 1a7 7 0 0 0 0 14z" fill="%23fff"/></svg>' },
    ],
  }),
  shellComponent: RootDocument,
  component: Root,
});

function Root() {
  // the loader ran on the server; on the client its data arrives with the page
  setRuntimeConfig(Route.useLoaderData());
  return <Outlet />;
}

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
