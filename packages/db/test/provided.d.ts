import 'vitest';

declare module 'vitest' {
  interface ProvidedContext {
    occRuns: number;
    occOps: number;
  }
}
