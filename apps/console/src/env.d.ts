// The one piece of the Workers runtime the console uses: its wrangler `vars`, read on the server only.
// (The full @cloudflare/workers-types clash with the DOM lib this browser app needs.)
declare module 'cloudflare:workers' {
  export const env: { API_BASE?: string; IDP_BASE?: string };
}
