# @kairos/expr: library or in house

**Decision: in house.** A small lexer, parser, type checker and tree-walking interpreter for exactly the §5 profile (about 3.2k lines of source). This is the A-13 fallback, and §5.1 allows it.

## Libraries evaluated (2026-10-24)

| | `@marcbachmann/cel-js` 8.0.0 | `cel-js` 0.8.2 |
|---|---|---|
| Interprets, no `eval` / `new Function` | Yes. The source has no code generation | Yes, but it depends on chevrotain and ramda |
| Type-checks against declared variables | Yes (`Environment`, `check()`) | No |
| Timestamps, durations, maps, lists | Yes | No timestamps or durations |
| AST node and depth limits | Yes (`limits.maxAstNodes`, `maxDepth`) | No |
| Static cost estimate | No | No |
| Runtime step budget, comprehension input and produced-size limits | No | No |
| `T\|null` fields (§5.3 Nulls), `EXPR_NULLABLE` lint | No. It has `optional<T>` and `null_type`, which are different semantics | No |
| Restricting to the profile (no bytes or uint, literal-only `matches`, macros over activation lists only, the §5.4 function set) | Only partly: the standard library is always registered | No |
| Linear-time regex | No. It uses JS `RegExp`, which backtracks | No |

`cel-js` fails on type checking and time types. `@marcbachmann/cel-js` is the closer fit, but every limit enforced at evaluation (step budget, comprehension input, produced string and list sizes) would need changes to its evaluator. Everything enforced at compile time (cost estimate, nullable typing, the profile restrictions, closed history maps, enum literals) would need a second pass over its AST, and so would the error codes. That means owning a fork of most of the library anyway. The profile is small enough that our own implementation is less code to own, and it matches the spec exactly.

## Notes on the design

- **Interpretation only.** The checked AST is plain data, and `matches` patterns compile to a Thompson-NFA program, which is also plain data. Nothing builds code from strings. A test in workerd scans `src/` for `eval` and `Function(` to keep it that way.
- **Exact numbers.** `int` is a `bigint` checked against 64-bit bounds. Timestamps and durations are `bigint` nanoseconds. `Intl` is used only to read wall-clock parts in a zone.
- **Cost.** Each evaluated node costs one step. O(n) work costs extra steps: strings at 1 per 256 code units, lists at 1 per 64 elements, regex at (n+1)·program/4096. The static estimate uses the same units. It assumes that comprehensions run over 256 elements and that strings are 1 KiB, so for inputs within §5.5 sizes it is an upper bound on runtime steps.
- **Fatal limits.** Hitting the step budget, the comprehension input limit or a produced-size limit gives `EXPR_BUDGET`. `&&`, `||`, `all` and `exists` never absorb it. Ordinary runtime errors give `EXPR_ERROR`, and those operators absorb them as CEL does.
