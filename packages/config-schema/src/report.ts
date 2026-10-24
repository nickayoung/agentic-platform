// Validation report (§6.3). Errors block publish; warnings must be acknowledged; `I` is informational
// (`DST_SHIFTED_OCCURRENCE`).

export type Layer = 'L1' | 'L2' | 'L3' | 'L4';
export type Severity = 'E' | 'W' | 'I';

export interface ValidationIssue {
  layer: Layer;
  code: string;
  severity: Severity;
  path: string;                                       // JSON Pointer (RFC 6901) into the document; '' is the root
  message: string;
}

export interface ValidationReport {
  ok: boolean;                                        // no issue with severity E
  issues: ValidationIssue[];
}

export const report = (issues: ValidationIssue[]): ValidationReport =>
  ({ ok: !issues.some((i) => i.severity === 'E'), issues });

export const pointer = (path: readonly PropertyKey[]): string =>
  path.map((p) => `/${String(p).replace(/~/g, '~0').replace(/\//g, '~1')}`).join('');

/** Collects issues for one layer, with paths given as segments. */
export class Issues {
  readonly list: ValidationIssue[] = [];
  readonly layer: Layer;
  constructor(layer: Layer) { this.layer = layer; }

  add(code: string, severity: Severity, path: readonly PropertyKey[], message: string): void {
    this.list.push({ layer: this.layer, code, severity, path: pointer(path), message });
  }
  error(code: string, path: readonly PropertyKey[], message: string): void { this.add(code, 'E', path, message); }
  warn(code: string, path: readonly PropertyKey[], message: string): void { this.add(code, 'W', path, message); }
}
