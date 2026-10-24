// YAML authoring format (§4): parsed as the YAML 1.2 core schema, so `yes`, `no`, `on` and `off` are strings, never
// booleans. Because a YAML 1.1 boolean word that silently becomes a string is almost always a mistake, an unquoted one
// is rejected outright; quote it if the string is meant.
import { isAlias, isMap, isPair, isScalar, isSeq, parseDocument, type Node } from 'yaml';
import { parseSchema } from './validate/l1';
import { pointer, type ValidationIssue } from './report';
import type { ConfigDocument } from './schema';

const YAML_11_BOOLEANS = /^(yes|Yes|YES|no|No|NO|on|On|ON|off|Off|OFF)$/;

const issue = (path: string, message: string): ValidationIssue =>
  ({ layer: 'L1', code: 'SCHEMA_INVALID', severity: 'E', path, message });

function findYaml11Booleans(node: unknown, path: PropertyKey[], out: ValidationIssue[]): void {
  if (isAlias(node)) return;
  if (isMap(node)) {
    for (const pair of node.items) {
      if (!isPair(pair)) continue;
      const key = isScalar(pair.key) ? String(pair.key.value) : '?';
      findYaml11Booleans(pair.key, path, out);
      findYaml11Booleans(pair.value, [...path, key], out);
    }
  } else if (isSeq(node)) {
    node.items.forEach((item, i) => findYaml11Booleans(item, [...path, i], out));
  } else if (isScalar(node) && node.type === 'PLAIN' && typeof node.value === 'string' && YAML_11_BOOLEANS.test(node.value)) {
    out.push(issue(pointer(path), `unquoted "${node.value}" is a YAML 1.1 boolean; write true/false, or quote the string`));
  }
}

/** Parses YAML text (1.2 core schema) into the raw JS value, without schema validation. */
export function parseYaml(text: string): { ok: true; value: unknown } | { ok: false; issues: ValidationIssue[] } {
  const doc = parseDocument(text, { version: '1.2', schema: 'core', uniqueKeys: true, merge: false, prettyErrors: true });
  const issues: ValidationIssue[] = doc.errors.map((e) => issue('', `YAML: ${e.message}`));
  if (doc.directives?.yaml.explicit && doc.directives.yaml.version !== '1.2') {
    issues.push(issue('', `YAML: only YAML 1.2 is accepted, found %YAML ${doc.directives.yaml.version}`));
  }
  findYaml11Booleans(doc.contents as Node | null, [], issues);
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: doc.toJS({ maxAliasCount: 100 }) };
}

/** Parses and schema-checks (L1 SCHEMA_INVALID) a config document written as YAML. */
export function parseConfigYaml(text: string): { ok: true; document: ConfigDocument } | { ok: false; issues: ValidationIssue[] } {
  const y = parseYaml(text);
  if (!y.ok) return y;
  const s = parseSchema(y.value);
  return s.ok ? { ok: true, document: s.doc } : s;
}
