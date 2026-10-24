// Typed diagnostics for the CEL profile (§5). Compile errors use the L3 validation codes (§6.3);
// runtime errors are EXPR_ERROR (absorbable by && / || and the all/exists macros) or EXPR_BUDGET (fatal).

/** L3 error codes (§6.3, table "L3"). */
export type CompileErrorCode = 'EXPR_SYNTAX' | 'EXPR_TYPE' | 'EXPR_UNKNOWN_VAR' | 'EXPR_COST' | 'UNKNOWN_HISTORY_KEY';
/** L3 warning codes. */
export type WarningCode = 'EXPR_NULLABLE';
/** Evaluate-time codes (§5.5, §5.6). */
export type RuntimeErrorCode = 'EXPR_ERROR' | 'EXPR_BUDGET';

/** Finer reason inside a code, stable for tests and the config agent. */
export type CompileRule =
  | 'syntax'
  | 'reserved_word'
  | 'forbidden_construct'
  | 'int_literal_range'
  | 'invalid_literal'
  | 'regex'
  | 'unknown_variable'
  | 'unknown_field'
  | 'unknown_function'
  | 'no_overload'
  | 'type_mismatch'
  | 'enum_value'
  | 'macro_range'
  | 'result_type'
  | 'history_key'
  | 'source_length'
  | 'max_nodes'
  | 'max_depth'
  | 'static_cost'
  | 'nullable_select';

export type RuntimeRule =
  | 'int_overflow'
  | 'division_by_zero'
  | 'modulus_by_zero'
  | 'no_such_key'
  | 'no_such_field'
  | 'null_select'
  | 'index_out_of_range'
  | 'no_matching_overload'
  | 'invalid_argument'
  | 'timestamp_range'
  | 'duration_range'
  | 'unbound_variable'
  | 'duplicate_key'
  | 'result_type'
  | 'steps'
  | 'comprehension_input'
  | 'string_size'
  | 'list_size';

export interface Position {
  /** 0-based UTF-16 offset into the source. */
  offset: number;
  /** 1-based. */
  line: number;
  /** 1-based, in UTF-16 code units. */
  column: number;
}

export interface Diagnostic<C extends string, R extends string> {
  code: C;
  rule: R;
  message: string;
  position: Position;
}

export type CompileError = Diagnostic<CompileErrorCode, CompileRule>;
export type CompileWarning = Diagnostic<WarningCode, CompileRule>;
export type RuntimeError = Diagnostic<RuntimeErrorCode, RuntimeRule>;

export function positionAt(source: string, offset: number): Position {
  let line = 1;
  let col = 1;
  const end = Math.min(offset, source.length);
  for (let i = 0; i < end; i++) {
    if (source.charCodeAt(i) === 10) {
      line++;
      col = 1;
    } else col++;
  }
  return { offset, line, column: col };
}

/** Thrown inside the lexer and parser; caught by `compile`. */
export class CompileFail extends Error {
  override name = 'CompileFail';
  constructor(
    readonly code: CompileErrorCode,
    readonly rule: CompileRule,
    message: string,
    readonly offset: number,
  ) {
    super(message);
  }
}

/** Thrown inside the interpreter; caught by `evaluate`. `fatal` errors are never absorbed. */
export class EvalFail extends Error {
  override name = 'EvalFail';
  readonly code: RuntimeErrorCode;
  constructor(
    readonly rule: RuntimeRule,
    message: string,
    public offset: number,
    readonly fatal = false,
  ) {
    super(message);
    this.code = fatal ? 'EXPR_BUDGET' : 'EXPR_ERROR';
  }
}
