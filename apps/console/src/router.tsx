// Router factory for TanStack Start. One QueryClient per router (per request on the server, once in the browser).
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRouter } from '@tanstack/react-router';
import { queryDefaults } from './lib/queries';
import { routeTree } from './routeTree.gen';

export function getRouter() {
  const queryClient = new QueryClient({ defaultOptions: { queries: queryDefaults } });
  return createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    defaultPreload: 'intent',
    Wrap: ({ children }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>,
  });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
