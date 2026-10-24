// Compiled config (§4.15).
//
// PLACEHOLDER: for Phase 0 the compiled form is only the upgraded, defaulted document and its content hash. CEL ASTs,
// expanded mat spots, resolved @staff references, normalised durations, the per-resource template index, counter
// key formats and the tzdb version (§4.15) are added as the engines that need them land.
import { contentHash } from './canonical';
import { ConfigDocumentSchema } from './schema';
import { withDefaults, type ConfigDocument21 } from './upgrade';

export interface CompiledConfig {
  schema_version: '2.1';
  content_hash: string;                               // contentHash(document)
  document: ConfigDocument21;
}

/** Deterministic: the same document always gives the same output. Throws if the document fails the schema. */
export function compile(doc: unknown): CompiledConfig {
  const document = withDefaults(ConfigDocumentSchema.parse(doc));
  return { schema_version: '2.1', content_hash: contentHash(document), document };
}
