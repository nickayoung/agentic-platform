// Vite's import.meta.glob, used to scan the package source for code generation.
interface ImportMeta {
  glob(pattern: string, opts: { query: '?raw'; import: 'default'; eager: true }): Record<string, string>;
}
