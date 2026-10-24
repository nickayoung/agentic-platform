// The profile's subset of the cel-spec conformance suite (github.com/google/cel-spec, tests/simple/testdata),
// run inside workerd. Case names follow cel-spec as `<file>/<section>/<test>` where a cel-spec case exists;
// `profile/...` cases cover the Kairos-specific rules of §5. Cases that cel-spec runs unchecked are run
// here through a `dyn` variable, because the profile always type-checks.

import { describe, expect, it } from 'vitest';
import { Duration, Timestamp } from '../src/index';
import { run, type Outcome } from './helpers';

type Case = [name: string, expr: string, expected: Outcome, act?: Record<string, unknown>];

const v = (value: unknown): Outcome => ({ value });
const err = (rule: string): Outcome => ({ error: 'EXPR_ERROR', rule });
const budget = (rule: string): Outcome => ({ error: 'EXPR_BUDGET', rule });
const cerr = (code: string, rule?: string): Outcome => (rule ? { compile: code, rule } : { compile: code });
const ts = (s: string) => Timestamp.parse(s)!;
const dur = (s: string) => Duration.parse(s)!;
const NOW = '2026-10-24T10:00:00Z';

function suite(title: string, cases: Case[]) {
  describe(title, () => {
    it.each(cases)('%s', (_name, expr, expected, act) => {
      const out = run(expr, { now: NOW, ...act });
      expect(out).toMatchObject(expected);
    });
  });
}

suite('basic', [
  ['basic/self_eval_zeroish/self_eval_int_zero', '0', v(0n)],
  ['basic/self_eval_zeroish/self_eval_uint_zero', '0u', cerr('EXPR_SYNTAX', 'forbidden_construct')],
  ['basic/self_eval_zeroish/self_eval_float_zero', '0.0', v(0)],
  ['basic/self_eval_zeroish/self_eval_float_zerowithexp', '0e+0', v(0)],
  ['basic/self_eval_zeroish/self_eval_string_empty', "''", v('')],
  ['basic/self_eval_zeroish/self_eval_string_empty_quotes', '""""""', v('')],
  ['basic/self_eval_zeroish/self_eval_string_raw_prefix', 'r""', v('')],
  ['basic/self_eval_zeroish/self_eval_bytes_empty', 'b""', cerr('EXPR_SYNTAX', 'forbidden_construct')],
  ['basic/self_eval_zeroish/self_eval_bool_false', 'false', v(false)],
  ['basic/self_eval_zeroish/self_eval_null', 'null', v(null)],
  ['basic/self_eval_zeroish/self_eval_empty_list', '[]', v([])],
  ['basic/self_eval_zeroish/self_eval_empty_map', '{}', v(new Map())],
  ['basic/self_eval_nonzeroish/self_eval_int_nonzero', '42', v(42n)],
  ['basic/self_eval_nonzeroish/self_eval_int_negative_min', '-9223372036854775808', v(-9223372036854775808n)],
  ['basic/self_eval_nonzeroish/self_eval_int_hex', '0x55555555', v(1431655765n)],
  ['basic/self_eval_nonzeroish/self_eval_int_hex_negative', '-0x55555555', v(-1431655765n)],
  ['basic/self_eval_nonzeroish/self_eval_float_negexp', '-2.3e+1', v(-23)],
  ['basic/self_eval_nonzeroish/self_eval_float_leading_dot', '.5', v(0.5)],
  ['basic/self_eval_nonzeroish/self_eval_string_escape', '"\\a\\b\\f\\n\\r\\t\\v\\"\\\'\\\\"', v('\x07\b\f\n\r\t\v"\'\\')],
  ['basic/self_eval_nonzeroish/self_eval_unicode_escape_four', '"\\u270c"', v('✌')],
  ['basic/self_eval_nonzeroish/self_eval_unicode_escape_eight', '"\\U0001F431"', v('\u{1F431}')],
  ['basic/self_eval_nonzeroish/self_eval_ascii_escape_seq', '"\\x41\\101"', v('AA')],
  ['basic/self_eval_nonzeroish/self_eval_raw_string', 'r"\\n"', v('\\n')],
  ['basic/self_eval_nonzeroish/self_eval_triple_quoted', "'''a\nb'''", v('a\nb')],
  ['basic/self_eval_nonzeroish/self_eval_list_singleitem', '[-1]', v([-1n])],
  ['basic/self_eval_nonzeroish/self_eval_map_singleitem', '{"k": "v"}', v(new Map([['k', 'v']]))],
  ['basic/self_eval_nonzeroish/self_eval_bool_true', 'true', v(true)],
  ['basic/variables/self_eval_bound_lookup', 'i', v(123n), { i: 123 }],
  ['basic/variables/self_eval_unbound_lookup', 'zzz', cerr('EXPR_UNKNOWN_VAR', 'unknown_variable')],
  ['basic/reserved/reserved_word', 'if', cerr('EXPR_SYNTAX', 'reserved_word')],
  ['basic/functions/unbound', 'f_unknown(17)', cerr('EXPR_TYPE', 'unknown_function')],
  ['basic/functions/unbound_is_runtime_error', 'string(1)', cerr('EXPR_TYPE', 'unknown_function')],
  ['basic/comments/line_comment', '1 + // one\n 1', v(2n)],
  ['basic/syntax/unterminated_string', "'abc", cerr('EXPR_SYNTAX', 'syntax')],
  ['basic/syntax/dangling_operator', '1 +', cerr('EXPR_SYNTAX', 'syntax')],
]);

suite('integer_math', [
  ['integer_math/int64_math/add_positive_positive', '40 + 2', v(42n)],
  ['integer_math/int64_math/sub_positive_negative', '42 - -5', v(47n)],
  ['integer_math/int64_math/multiply_positive_negative', '25 * -3', v(-75n)],
  ['integer_math/int64_math/divide_positive_negative', '10 / -2', v(-5n)],
  ['integer_math/int64_math/div_truncates', '-10 / 3', v(-3n)],
  ['integer_math/int64_math/mod_positive_negative', '47 % -5', v(2n)],
  ['integer_math/int64_math/mod_negative_positive', '-10 % 3', v(-1n)],
  ['integer_math/int64_math/negative', '-(5)', v(-5n)],
  ['integer_math/int64_math/double_negative', '--5', v(5n)],
  ['integer_math/int64_math/negate_variable', '-i', v(-7n), { i: 7 }],
  ['integer_math/int64_math/precedence', '2 + 3 * 4 - 10 / 5 % 3', v(12n)],
  ['integer_math/int64_math/int64_overflow_positive', '9223372036854775807 + 1', err('int_overflow')],
  ['integer_math/int64_math/int64_overflow_negative', '-9223372036854775808 - 1', err('int_overflow')],
  ['integer_math/int64_math/int64_overflow_add_negative', '-9223372036854775808 + -1', err('int_overflow')],
  ['integer_math/int64_math/int64_overflow_mul', '9223372036854775807 * 2', err('int_overflow')],
  ['integer_math/int64_math/int64_overflow_negation', '-(-9223372036854775808)', err('int_overflow')],
  ['integer_math/int64_math/int64_overflow_div', '-9223372036854775808 / -1', err('int_overflow')],
  ['integer_math/int64_math/int64_overflow_mod', '-9223372036854775808 % -1', err('int_overflow')],
  ['integer_math/int64_math/int64_max_ok', '9223372036854775806 + 1', v(9223372036854775807n)],
  ['integer_math/int64_math/int64_overflow_from_activation', 'i * i', err('int_overflow'), { i: 2n ** 40n }],
  ['integer_math/int64_math/divide_by_zero', '1 / 0', err('division_by_zero')],
  ['integer_math/int64_math/mod_by_zero', '34 % 0', err('modulus_by_zero')],
  ['integer_math/int64_math/int_literal_out_of_range', '9223372036854775808', cerr('EXPR_SYNTAX', 'int_literal_range')],
  ['integer_math/int64_math/mixed_int_double_add', '1 + 1.0', cerr('EXPR_TYPE', 'no_overload')],
  ['integer_math/int64_math/int_plus_string', '1 + "a"', cerr('EXPR_TYPE', 'no_overload')],
  ['integer_math/int64_math/dyn_int_plus_string', 'x + "a"', err('no_matching_overload'), { x: 1 }],
]);

suite('fp_math', [
  ['fp_math/fp_math/add_positive_positive', '4.25 + 15.25', v(19.5)],
  ['fp_math/fp_math/sub_positive_negative', '42.0 - -5.5', v(47.5)],
  ['fp_math/fp_math/multiply', '2.5 * 2.0', v(5)],
  ['fp_math/fp_math/divide', '7.0 / 2.0', v(3.5)],
  ['fp_math/fp_math/divide_zero_positive', '1.0 / 0.0', v(Infinity)],
  ['fp_math/fp_math/divide_zero_negative', '-1.0 / 0.0', v(-Infinity)],
  ['fp_math/fp_math/divide_zero_zero', '0.0 / 0.0', v(NaN)],
  ['fp_math/fp_math/negative', '-(4.5)', v(-4.5)],
  ['fp_math/fp_math/mod_not_support', '5.0 % 2.0', cerr('EXPR_TYPE', 'no_overload')],
  ['fp_math/fp_math/double_variable', 'f * 2.0', v(3), { f: 1.5 }],
  ['fp_math/fp_math/double_from_integral_host_number', 'f / 2.0', v(1), { f: 2 }],
]);

const long = 'x'.repeat(600);
suite('string', [
  ['string/size/one_ascii', "size('A')", v(1n)],
  ['string/size/one_unicode', "size('ÿ')", v(1n)],
  ['string/size/astral', "size('😀a')", v(2n)],
  ['string/size/receiver', "'hello'.size()", v(5n)],
  ['string/size/empty', "size('')", v(0n)],
  ['string/starts_with/basic_true', "'foobar'.startsWith('foo')", v(true)],
  ['string/starts_with/basic_false', "'foobar'.startsWith('bar')", v(false)],
  ['string/starts_with/empty', "'foobar'.startsWith('')", v(true)],
  ['string/ends_with/basic_true', "'foobar'.endsWith('bar')", v(true)],
  ['string/ends_with/basic_false', "'foobar'.endsWith('foo')", v(false)],
  ['string/contains/basic_true', "'hello'.contains('ell')", v(true)],
  ['string/contains/basic_false', "'hello'.contains('elk')", v(false)],
  ['string/contains/empty', "'hello'.contains('')", v(true)],
  ['string/contains/global_form_rejected', "contains('hello', 'h')", cerr('EXPR_TYPE', 'no_overload')],
  ['string/concat/concat_true', "'he' + 'llo' == 'hello'", v(true)],
  ['string/concat/concat_variable', "s + '!'", v('hi!'), { s: 'hi' }],
  ['string/matches/basic', "'hubba'.matches('ub')", v(true)],
  ['string/matches/global', "matches('abc', '^a.c$')", v(true)],
  ['string/matches/anchored_false', "'xabc'.matches('^abc')", v(false)],
  ['string/matches/alternation', "'b'.matches('a|b')", v(true)],
  ['string/matches/alternation_false', "'c'.matches('^(a|b)$')", v(false)],
  ['string/matches/plus_group', "'foo'.matches('^f(o)+$')", v(true)],
  ['string/matches/bounded_repeat', "'2026-10-01'.matches('^\\\\d{4}-\\\\d{2}-\\\\d{2}$')", v(true)],
  ['string/matches/bounded_repeat_false', "'2026-1-01'.matches('^\\\\d{4}-\\\\d{2}-\\\\d{2}$')", v(false)],
  ['string/matches/repeat_range', "'aaa'.matches('^a{2,3}$') && !'aaaa'.matches('^a{2,3}$')", v(true)],
  ['string/matches/class_negated', "'abc'.matches('^[^0-9]+$')", v(true)],
  ['string/matches/class_range', "'Q'.matches('[A-Z]') && !'q'.matches('[A-Z]')", v(true)],
  ['string/matches/case_insensitive', "'ABC'.matches('(?i)^abc$')", v(true)],
  ['string/matches/dot_no_newline', "'a\\nb'.matches('a.b')", v(false)],
  ['string/matches/unicode', "'café'.matches('^caf.$')", v(true)],
  ['string/matches/empty_pattern', "'x'.matches('')", v(true)],
  ['string/matches/word_class', "'a_1'.matches('^\\\\w+$') && !'a-1'.matches('^\\\\w+$')", v(true)],
  ['string/matches/escaped_dot', "'a.b'.matches('^a\\\\.b$') && !'axb'.matches('^a\\\\.b$')", v(true)],
  ['string/matches/catastrophic_pattern_is_linear', `'${'a'.repeat(200)}b'.matches('^(a+)+$')`, v(false)],
  ['profile/matches/non_literal_pattern', 's.matches(s)', cerr('EXPR_SYNTAX', 'regex')],
  ['profile/matches/pattern_too_long', `'a'.matches('${'a'.repeat(129)}')`, cerr('EXPR_SYNTAX', 'regex')],
  ['profile/matches/pattern_at_limit', `'a'.matches('${'a?'.repeat(64)}')`, v(true)],
  ['profile/matches/backreference_rejected', "'aa'.matches('(a)\\\\1')", cerr('EXPR_SYNTAX', 'regex')],
  ['profile/matches/lookahead_rejected', "'a'.matches('(?=a)')", cerr('EXPR_SYNTAX', 'regex')],
  ['profile/matches/invalid_pattern', "'a'.matches('(a')", cerr('EXPR_SYNTAX', 'regex')],
  ['string/in/string_in_string_not_supported', "'a' in 'abc'", cerr('EXPR_TYPE', 'no_overload')],
  ['profile/limits/produced_string_over_1kib', 's + s', budget('string_size'), { s: long }],
  ['profile/limits/produced_string_at_1kib', 'size(s + s)', v(1024n), { s: 'y'.repeat(512) }],
]);

suite('comparisons', [
  ['comparisons/eq_literal/eq_int', '1 == 1', v(true)],
  ['comparisons/eq_literal/not_eq_int', '-1 == 1', v(false)],
  ['comparisons/eq_literal/eq_string', "'' == \"\"", v(true)],
  ['comparisons/eq_literal/not_eq_string_case', "'abc' == 'ABC'", v(false)],
  ['comparisons/eq_literal/eq_double', '1.0 == 1.0e+0', v(true)],
  ['comparisons/eq_literal/eq_null', 'null == null', v(true)],
  ['comparisons/eq_literal/eq_bool', 'true == true', v(true)],
  ['comparisons/eq_literal/eq_list_numbers', '[1, 2, 3] == [1, 2, 3]', v(true)],
  ['comparisons/eq_literal/not_eq_list_length', '[1, 2] == [1, 2, 3]', v(false)],
  ['comparisons/eq_literal/eq_map_order_independent', "{'a': 1, 'b': 2} == {'b': 2, 'a': 1}", v(true)],
  ['comparisons/eq_literal/not_eq_map_value', "{'a': 1} == {'a': 2}", v(false)],
  ['comparisons/eq_literal/eq_list_from_activation', '[1, 2] == xs', v(true), { xs: [1, 2] }],
  ['comparisons/eq_literal/eq_mixed_types_error', "1 == 'a'", cerr('EXPR_TYPE', 'no_overload')],
  ['comparisons/eq_literal/eq_dyn_mixed_types_false', "x == 'a'", v(false), { x: 1 }],
  ['comparisons/eq_literal/not_eq_nan', '0.0/0.0 == 0.0/0.0', v(false)],
  ['comparisons/eq_literal/ne_int', '24 != 42', v(true)],
  ['comparisons/eq_literal/ne_list', '[1] != [2]', v(true)],
  ['comparisons/eq_cross_numeric/eq_int_double', '1 == 1.0', v(true)],
  ['comparisons/eq_cross_numeric/not_eq_int_double_fraction', '1 == 1.5', v(false)],
  ['comparisons/lt_literal/lt_int', '-1 < 0', v(true)],
  ['comparisons/lt_literal/not_lt_int', '0 < 0', v(false)],
  ['comparisons/lt_literal/lt_double', '-1.1 < -1.0', v(true)],
  ['comparisons/lt_literal/lt_string', "'a' < 'b'", v(true)],
  ['comparisons/lt_literal/lt_string_prefix', "'abc' < 'abcd'", v(true)],
  ['comparisons/lt_literal/lt_string_empty', "'' < 'a'", v(true)],
  ['comparisons/lt_literal/lt_string_code_points', "'\\uffff' < '\\U0001F600'", v(true)],
  ['comparisons/lt_literal/lt_bool_false_first', 'false < true', v(true)],
  ['comparisons/lt_literal/lt_mixed_types_error', "'a' < 1", cerr('EXPR_TYPE', 'no_overload')],
  ['comparisons/lt_literal/lt_list_unsupported', '[0] < [1]', cerr('EXPR_TYPE', 'no_overload')],
  ['comparisons/lt_cross_numeric/lt_int_double', '1 < 1.5', v(true)],
  ['comparisons/lt_cross_numeric/gt_int_double', '2 > 1.5', v(true)],
  ['comparisons/lte_cross_numeric/lte_double_int', '1.0 <= 1', v(true)],
  ['comparisons/gte_literal/gte_int', '1 >= 1', v(true)],
  ['comparisons/gt_literal/gt_string', "'b' > 'a'", v(true)],
  ['comparisons/lt_nan/lt_nan_false', '0.0/0.0 < 1.0', v(false)],
  ['comparisons/timestamp/lt', "timestamp('2009-02-13T23:31:30Z') < timestamp('2009-02-13T23:31:31Z')", v(true)],
  ['comparisons/duration/gt', "duration('1h') > duration('59m')", v(true)],
  ['profile/null/eq_null_variable', 'n == null', v(true), { n: null }],
  ['profile/null/compare_null_field_false', "obj.s == 'x'", v(false), { obj: { a: 1, s: null, inner: null, tags: [] } }],
  ['profile/null/compare_null_field_ne_true', "obj.s != 'x'", v(true), { obj: { a: 1, s: null, inner: null, tags: [] } }],
  ['profile/null/order_with_null_false', 'n < 5', v(false), { n: null }],
  ['profile/null/order_with_null_ge_false', 'n >= 5', v(false), { n: null }],
  ['profile/null/order_with_value', 'n < 5', v(true), { n: 3 }],
]);

const DYN_ERR = { x: 32 };
suite('logic', [
  ['logic/AND/all_true', 'true && true', v(true)],
  ['logic/AND/all_false', 'false && false', v(false)],
  ['logic/AND/false_left', 'false && true', v(false)],
  ['logic/AND/false_right', 'true && false', v(false)],
  ['logic/AND/short_circuit_type_left', 'false && x', v(false), DYN_ERR],
  ['logic/AND/short_circuit_type_right', 'x && false', v(false), DYN_ERR],
  ['logic/AND/short_circuit_error_left', '1 / 0 == 0 && false', v(false)],
  ['logic/AND/short_circuit_error_right', 'false && 1 / 0 == 0', v(false)],
  ['logic/AND/error_right', 'true && 1 / 0 == 0', err('division_by_zero')],
  ['logic/AND/error_left', '1 / 0 == 0 && true', err('division_by_zero')],
  ['logic/AND/no_overload', 'true && x', err('no_matching_overload'), DYN_ERR],
  ['logic/AND/static_type_error', 'true && 32', cerr('EXPR_TYPE', 'no_overload')],
  ['logic/OR/all_true', 'true || true', v(true)],
  ['logic/OR/all_false', 'false || false', v(false)],
  ['logic/OR/false_left', 'false || true', v(true)],
  ['logic/OR/short_circuit_type_left', 'true || x', v(true), DYN_ERR],
  ['logic/OR/short_circuit_type_right', 'x || true', v(true), DYN_ERR],
  ['logic/OR/short_circuit_error_left', '1 / 0 == 0 || true', v(true)],
  ['logic/OR/short_circuit_error_right', 'true || 1 / 0 == 0', v(true)],
  ['logic/OR/error_right', 'false || 1 / 0 == 0', err('division_by_zero')],
  ['logic/OR/no_overload', 'false || x', err('no_matching_overload'), DYN_ERR],
  ['logic/AND/long_chain', Array.from({ length: 30 }, () => 'true').join(' && '), v(true)],
  ['logic/AND/mixed_chain', 'true && 1 / 0 == 0 && false && true', v(false)],
  ['logic/NOT/not_true', '!true', v(false)],
  ['logic/NOT/not_not', '!!true', v(true)],
  ['logic/NOT/not_dyn_error', '!x', err('no_matching_overload'), DYN_ERR],
  ['logic/conditional/true_case', 'true ? 1 : 2', v(1n)],
  ['logic/conditional/false_case', 'false ? 1 : 2', v(2n)],
  ['logic/conditional/error_case', '1 / 0 == 0 ? 1 : 2', err('division_by_zero')],
  ['logic/conditional/lazy_branch', 'true ? 1 : 1 / 0', v(1n)],
  ['logic/conditional/mixed_branch_types', "true ? 1 : 'a'", cerr('EXPR_TYPE', 'type_mismatch')],
  ['logic/conditional/null_branch', 'false ? null : 1', v(1n)],
  ['logic/conditional/nested', 'i > 5 ? (i > 10 ? 3 : 2) : 1', v(2n), { i: 7 }],
  ['logic/conditional/nested_without_parens', 'i > 5 ? i > 10 ? 3 : 2 : 1', cerr('EXPR_SYNTAX', 'syntax')],
  ['logic/conditional/non_bool_condition', "1 ? 'a' : 'b'", cerr('EXPR_TYPE', 'no_overload')],
]);

const OBJ = { a: 1, s: 'v', inner: { b: 2 }, tags: ['hot'] };
suite('fields_and_has', [
  ['fields/qualified_identifier_resolution/select_field', 'obj.a', v(1n), { obj: OBJ }],
  ['fields/qualified_identifier_resolution/nested_select', 'obj.inner.b', v(2n), { obj: OBJ }],
  ['fields/qualified_identifier_resolution/unknown_field', 'obj.nope', cerr('EXPR_TYPE', 'unknown_field')],
  ['fields/map_fields/map_key_select', 'd.k', v('v'), { d: { k: 'v' } }],
  ['fields/map_fields/map_key_select_missing', 'd.zz', err('no_such_key'), { d: { k: 'v' } }],
  ['fields/map_fields/typed_map_select', 'm.a + 1', v(2n), { m: { a: 1 } }],
  ['fields/has/has_field_set', 'has(obj.a)', v(true), { obj: OBJ }],
  ['fields/has/has_field_null', 'has(obj.s)', v(false), { obj: { ...OBJ, s: null } }],
  ['fields/has/has_map_key', 'has(d.k)', v(true), { d: { k: 1 } }],
  ['fields/has/has_map_key_missing', 'has(d.zz)', v(false), { d: { k: 1 } }],
  ['fields/has/has_map_key_null_value', 'has(d.k)', v(true), { d: { k: null } }],
  ['fields/has/has_unknown_field', 'has(obj.nope)', cerr('EXPR_TYPE', 'unknown_field')],
  ['fields/has/has_non_select', 'has(xs)', cerr('EXPR_SYNTAX', 'syntax')],
  ['fields/has/has_on_null_operand', 'has(obj.inner.b)', err('null_select'), { obj: { ...OBJ, inner: null } }],
  ['profile/null/select_of_null_is_error', 'obj.inner.b == 2', err('null_select'), { obj: { ...OBJ, inner: null } }],
  ['profile/null/guarded_select', 'obj.inner != null && obj.inner.b == 2', v(false), { obj: { ...OBJ, inner: null } }],
  ['profile/null/error_absorbed_by_and', 'obj.inner.b == 2 && obj.a == 0', v(false), { obj: { ...OBJ, a: 5, inner: null } }],
  ['profile/null/error_not_absorbed_when_undecided', 'obj.inner.b == 2 && obj.a == 5', err('null_select'), { obj: { ...OBJ, a: 5, inner: null } }],
  ['profile/runtime/unbound_activation_variable', 'i + 1', err('unbound_variable')],
  ['profile/runtime/missing_declared_field', 'obj.a', err('no_such_field'), { obj: {} }],
  ['profile/runtime/host_non_integer_for_int', 'i + 1', err('invalid_argument'), { i: 1.5 }],
]);

suite('lists_and_maps', [
  ['lists/index/zero_based', '[7, 8, 9][0]', v(7n)],
  ['lists/index/one', '[7, 8, 9][1]', v(8n)],
  ['lists/index/out_of_bounds', '[1][5]', err('index_out_of_range')],
  ['lists/index/negative', '[1][-1]', err('index_out_of_range')],
  ['lists/index/activation', 'xs[2]', v(3n), { xs: [1, 2, 3] }],
  ['lists/index/non_int_index', "[1]['a']", cerr('EXPR_TYPE', 'no_overload')],
  ['lists/concatenation/list_append', '[0, 1] + [2]', v([0n, 1n, 2n])],
  ['lists/concatenation/list_type_mismatch', "[1] + ['a']", cerr('EXPR_TYPE', 'no_overload')],
  ['lists/in/elem_in_list', '2 in [1, 2, 3]', v(true)],
  ['lists/in/elem_not_in_list', '4 in [1, 2, 3]', v(false)],
  ['lists/in/elem_in_empty', '1 in []', v(false)],
  ['lists/in/int_in_double_list', '1 in [1.0]', v(true)],
  ['lists/in/string_in_activation', "'b' in ss", v(true), { ss: ['a', 'b'] }],
  ['lists/in/null_in_list', 'n in xs', v(false), { n: null, xs: [1] }],
  ['lists/size/list', 'size([1, 2, 3])', v(3n)],
  ['lists/size/receiver', 'xs.size()', v(2n), { xs: [1, 2] }],
  ['lists/literal/heterogeneous', "[1, 'a']", cerr('EXPR_TYPE', 'type_mismatch')],
  ['lists/literal/trailing_comma', '[1, 2,]', v([1n, 2n])],
  ['maps/index/string_key', "{'a': 1}['a']", v(1n)],
  ['maps/index/missing_key', "{'a': 1}['b']", err('no_such_key')],
  ['maps/index/int_key', "{1: 'one', 2: 'two'}[2]", v('two')],
  ['maps/index/bool_key', "{true: 1, false: 0}[false]", v(0n)],
  ['maps/index/int_key_by_dyn', '{1: 2}[x]', v(2n), { x: 1 }],
  ['maps/index/activation', "m['b']", v(2n), { m: { a: 1, b: 2 } }],
  ['maps/index/wrong_key_type', '{"a": 1}[1]', cerr('EXPR_TYPE', 'no_overload')],
  ['maps/in/key_in_map', "'a' in {'a': 1}", v(true)],
  ['maps/in/key_not_in_map', "'b' in m", v(false), { m: { a: 1 } }],
  ['maps/size/map', "size({'a': 1, 'b': 2})", v(2n)],
  ['maps/literal/duplicate_key', "{'a': 1, 'a': 2}", cerr('EXPR_TYPE', 'type_mismatch')],
  ['maps/literal/double_key', '{1.5: 1}', cerr('EXPR_TYPE', 'type_mismatch')],
  ['maps/literal/heterogeneous_values', "{'a': 1, 'b': 'x'}", cerr('EXPR_TYPE', 'type_mismatch')],
  ['profile/limits/produced_list_over_256', 'xs + xs', budget('list_size'), { xs: Array.from({ length: 200 }, (_, i) => i) }],
]);

const XS = { xs: [1, 2, 3] };
suite('macros', [
  ['macros/exists/list_elem_all_true', 'xs.exists(e, e > 0)', v(true), XS],
  ['macros/exists/list_elem_none', 'xs.exists(e, e > 5)', v(false), XS],
  ['macros/exists/list_empty', 'xs.exists(e, e > 0)', v(false), { xs: [] }],
  ['macros/exists/list_elem_error_shortcircuit', 'xs.exists(e, 1 / e == 1)', v(true), { xs: [0, 1] }],
  ['macros/exists/list_elem_error', 'xs.exists(e, 1 / e == 5)', err('division_by_zero'), { xs: [0, 1] }],
  ['macros/all/list_elem_all_true', 'xs.all(e, e > 0)', v(true), XS],
  ['macros/all/list_elem_some_false', 'xs.all(e, e > 1)', v(false), XS],
  ['macros/all/list_empty', 'xs.all(e, e > 0)', v(true), { xs: [] }],
  ['macros/all/list_elem_error_shortcircuit', 'xs.all(e, 1 / e > 5)', v(false), { xs: [0, 1] }],
  ['macros/all/list_elem_error', 'xs.all(e, 1 / e > 0)', err('division_by_zero'), { xs: [0, 1] }],
  ['macros/exists_one/list_one', 'xs.exists_one(e, e == 2)', v(true), XS],
  ['macros/exists_one/list_many', 'xs.exists_one(e, e > 1)', v(false), XS],
  ['macros/exists_one/list_none', 'xs.exists_one(e, e > 5)', v(false), XS],
  ['macros/exists_one/list_error', 'xs.exists_one(e, 1 / e == 1)', err('division_by_zero'), { xs: [1, 0] }],
  ['macros/filter/list_filter', 'xs.filter(e, e % 2 == 1)', v([1n, 3n]), XS],
  ['macros/filter/list_filter_empty', 'xs.filter(e, e > 9)', v([]), XS],
  ['macros/filter/strings', "ss.filter(e, e.startsWith('h'))", v(['hot']), { ss: ['hot', 'cold'] }],
  ['macros/map/list_map', 'xs.map(e, e * 2)', v([2n, 4n, 6n]), XS],
  ['macros/map/list_map_filter', 'xs.map(e, e > 1, e * 10)', v([20n, 30n]), XS],
  ['macros/map/to_strings', "ss.map(e, e + '!')", v(['a!']), { ss: ['a'] }],
  ['macros/nested/in_inside_all', 'obj.tags.all(t, t in ss)', v(true), { obj: OBJ, ss: ['hot', 'x'] }],
  ['macros/nested/regex_inside_exists', "ss.exists(t, t.matches('^h[a-z]+$'))", v(true), { ss: ['x', 'hot'] }],
  ['macros/size_of_filter', 'size(xs.filter(e, e > 1)) == 2', v(true), XS],
  ['macros/shadowing/iter_var_shadows_variable', 'xs.all(i, i > 0)', v(true), XS],
  ['macros/scope/iter_var_not_visible_after', 'xs.all(e, e > 0) && e > 0', cerr('EXPR_UNKNOWN_VAR', 'unknown_variable')],
  ['macros/syntax/iter_var_must_be_ident', 'xs.all(1, true)', cerr('EXPR_SYNTAX', 'syntax')],
  ['macros/syntax/wrong_arity', 'xs.all(e)', cerr('EXPR_SYNTAX', 'syntax')],
  ['macros/syntax/global_form', 'all(xs, e, true)', cerr('EXPR_SYNTAX', 'syntax')],
  ['macros/type/predicate_not_bool', 'xs.all(e, e + 1)', cerr('EXPR_TYPE', 'no_overload')],
  ['profile/macros/literal_range_rejected', '[1, 2].all(e, e > 0)', cerr('EXPR_TYPE', 'macro_range')],
  ['profile/macros/computed_range_rejected', 'xs.filter(e, e > 0).all(e, e > 0)', cerr('EXPR_TYPE', 'macro_range')],
  ['profile/macros/map_range_rejected', "m.all(k, k == 'a')", cerr('EXPR_TYPE', 'macro_range')],
  ['profile/macros/dyn_range', 'd.xs.exists(e, e == 2)', v(true), { d: { xs: [1, 2] } }],
  ['profile/macros/dyn_range_not_a_list', 'd.xs.exists(e, e == 2)', err('no_matching_overload'), { d: { xs: 'nope' } }],
  ['profile/limits/nested_comprehension_static_cost', 'xs.all(a, xs.all(e, a <= e || true))', cerr('EXPR_COST', 'static_cost')],
  ['profile/limits/comprehension_input_over_256', 'xs.all(e, e >= 0)', budget('comprehension_input'), { xs: Array.from({ length: 257 }, (_, i) => i) }],
  ['profile/limits/comprehension_input_at_256', 'xs.all(e, e >= 0)', v(true), { xs: Array.from({ length: 256 }, (_, i) => i) }],
  ['profile/limits/budget_not_absorbed_by_or', 'xs.all(e, e >= 0) || true', budget('comprehension_input'), { xs: Array.from({ length: 300 }, (_, i) => i) }],
]);

suite('timestamps', [
  ['timestamps/timestamp_conversions/toTimestamp', "timestamp('2009-02-13T23:31:30Z')", v(ts('2009-02-13T23:31:30Z'))],
  ['timestamps/timestamp_conversions/toTimestamp_offset', "timestamp('2009-02-13T18:31:30-05:00') == timestamp('2009-02-13T23:31:30Z')", v(true)],
  ['timestamps/timestamp_conversions/toTimestamp_fraction', "timestamp('2009-02-13T23:31:30.5Z') > timestamp('2009-02-13T23:31:30Z')", v(true)],
  ['timestamps/timestamp_conversions/toTimestamp_min', "timestamp('0001-01-01T00:00:00Z') < timestamp('1970-01-01T00:00:00Z')", v(true)],
  ['timestamps/timestamp_conversions/toTimestamp_leap_day', "timestamp('2024-02-29T00:00:00Z') < timestamp('2024-03-01T00:00:00Z')", v(true)],
  ['timestamps/timestamp_conversions/invalid_day_literal', "timestamp('2023-02-29T00:00:00Z')", cerr('EXPR_TYPE', 'invalid_literal')],
  ['timestamps/timestamp_conversions/invalid_format_literal', "timestamp('2023-02-01')", cerr('EXPR_TYPE', 'invalid_literal')],
  ['timestamps/timestamp_conversions/invalid_runtime', 'timestamp(s)', err('invalid_argument'), { s: 'nope' }],
  ['timestamps/timestamp_conversions/identity', 'timestamp(t) == t', v(true), { t: '2026-01-01T00:00:00Z' }],
  ['timestamps/duration_conversions/toDuration', "duration('1h30m') == duration('5400s')", v(true)],
  ['timestamps/duration_conversions/toDuration_fraction', "duration('1.5s') == duration('1500ms')", v(true)],
  ['timestamps/duration_conversions/toDuration_units', "duration('1ms') + duration('1us') + duration('1ns') == duration('1001001ns')", v(true)],
  ['timestamps/duration_conversions/toDuration_negative', "duration('-1.5s') < duration('0')", v(true)],
  ['timestamps/duration_conversions/invalid_unit', "duration('1d')", cerr('EXPR_TYPE', 'invalid_literal')],
  ['timestamps/duration_conversions/invalid_runtime', 'duration(s)', err('invalid_argument'), { s: '5' }],
  ['timestamps/timestamp_arithmetic/add_duration_to_time', "timestamp('2009-02-13T23:31:30Z') + duration('1h') == timestamp('2009-02-14T00:31:30Z')", v(true)],
  ['timestamps/timestamp_arithmetic/add_time_to_duration', "duration('1h') + timestamp('2009-02-13T23:31:30Z') == timestamp('2009-02-14T00:31:30Z')", v(true)],
  ['timestamps/timestamp_arithmetic/subtract_duration_from_time', "timestamp('2009-02-13T23:31:30Z') - duration('30s') == timestamp('2009-02-13T23:31:00Z')", v(true)],
  ['timestamps/timestamp_arithmetic/subtract_time_from_time', "timestamp('2009-02-13T23:31:30Z') - timestamp('2009-02-13T23:31:00Z')", v(dur('30s'))],
  ['timestamps/timestamp_arithmetic/add_duration_to_duration', "duration('1h') + duration('30m') == duration('90m')", v(true)],
  ['timestamps/timestamp_arithmetic/subtract_duration_from_duration', "duration('1h') - duration('90m') == duration('-30m')", v(true)],
  ['timestamps/timestamp_arithmetic/negate_duration', "-duration('1h') == duration('-1h')", v(true)],
  ['timestamps/timestamp_arithmetic/add_time_to_time', "timestamp('2009-02-13T23:31:30Z') + timestamp('2009-02-13T23:31:30Z')", cerr('EXPR_TYPE', 'no_overload')],
  ['timestamps/timestamp_arithmetic/multiply_duration', "duration('1h') * 2", cerr('EXPR_TYPE', 'no_overload')],
  ['timestamps/timestamp_range/add_overflow', "timestamp('9999-12-31T23:59:59Z') + duration('1s')", err('timestamp_range')],
  ['timestamps/timestamp_range/sub_underflow', "timestamp('0001-01-01T00:00:00Z') - duration('1s')", err('timestamp_range')],
  ['timestamps/duration_range/add_overflow', "duration('315576000000s') + duration('1s')", err('duration_range')],
  ['timestamps/timestamp_activation/date_object', 't < now', v(true), { t: new Date('2026-01-01T00:00:00Z') }],
  ['timestamps/timestamp_activation/iso_string', "t == timestamp('2026-01-01T00:00:00Z')", v(true), { t: '2026-01-01T00:00:00Z' }],
  ['timestamps/timestamp_activation/now_bound', "now == timestamp('2026-10-24T10:00:00Z')", v(true)],
]);

const RES = {
  id: 'r1',
  key: null,
  type: 'teacher',
  kind: 'person',
  tags: ['senior'],
  roles: ['teacher'],
  skills: ['hot', 'vinyasa'],
  attributes: {},
  location_keys: ['dumbo'],
  skill_expires_at: { hot: '2026-10-01T00:00:00Z' },
};
suite('profile_functions', [
  ['profile/functions/localDate_zone', "localDate(timestamp('2026-11-01T03:30:00Z'), 'America/New_York')", v('2026-10-31')],
  ['profile/functions/localTime_zone', "localTime(timestamp('2026-11-01T03:30:00Z'), 'America/New_York')", v('23:30')],
  ['profile/functions/weekday_zone', "weekday(timestamp('2026-11-01T03:30:00Z'), 'America/New_York')", v('sat')],
  ['profile/functions/weekday_utc', "weekday(timestamp('2026-11-01T03:30:00Z'), 'UTC')", v('sun')],
  ['profile/functions/localTime_after_dst_end', "localTime(timestamp('2026-11-01T06:30:00Z'), 'America/New_York')", v('01:30')],
  ['profile/functions/localTime_before_dst_end', "localTime(timestamp('2026-11-01T05:30:00Z'), 'America/New_York')", v('01:30')],
  ['profile/functions/localTime_midnight', "localTime(timestamp('2026-10-24T04:00:00Z'), 'America/New_York')", v('00:00')],
  ['profile/functions/localDate_invalid_zone_literal', "localDate(now, 'Mars/Olympus')", cerr('EXPR_TYPE', 'invalid_literal')],
  ['profile/functions/localDate_invalid_zone_runtime', 'localDate(now, s)', err('invalid_argument'), { s: 'Mars/Olympus' }],
  ['profile/functions/localDate_receiver_rejected', "now.localDate('UTC')", cerr('EXPR_TYPE', 'no_overload')],
  ['profile/functions/today', "today('Asia/Tokyo')", v('2026-10-24')],
  ['profile/functions/today_crosses_midnight', "today('Pacific/Kiritimati')", v('2026-10-25')],
  ['profile/functions/hoursUntil', "hoursUntil(timestamp('2026-10-24T13:30:00Z'))", v(3.5)],
  ['profile/functions/hoursUntil_past', "hoursUntil(timestamp('2026-10-24T09:00:00Z')) < 0", v(true)],
  ['profile/functions/hoursUntil_compare_int', "hoursUntil(timestamp('2026-10-25T10:00:00Z')) >= 24", v(true)],
  ['profile/functions/minutesBetween', "minutesBetween(timestamp('2026-10-24T10:00:00Z'), timestamp('2026-10-24T11:30:00Z'))", v(90n)],
  ['profile/functions/minutesBetween_reversed', "minutesBetween(timestamp('2026-10-24T11:30:00Z'), timestamp('2026-10-24T10:00:00Z'))", v(-90n)],
  ['profile/functions/minutesBetween_truncates', "minutesBetween(timestamp('2026-10-24T10:00:00Z'), timestamp('2026-10-24T10:01:59Z'))", v(1n)],
  ['profile/functions/hasTag_object', "hasTag(obj, 'hot')", v(true), { obj: OBJ }],
  ['profile/functions/hasTag_missing', "hasTag(obj, 'cold')", v(false), { obj: OBJ }],
  ['profile/functions/hasTag_without_tags', "hasTag(xs, 'a')", cerr('EXPR_TYPE', 'no_overload')],
  ['profile/functions/size_map', 'size(m)', v(2n), { m: { a: 1, b: 2 } }],
  ['profile/functions/size_int_rejected', 'size(1)', cerr('EXPR_TYPE', 'no_overload')],
  ['profile/functions/min_int', 'min(3, 1, 2)', v(1n)],
  ['profile/functions/max_double', 'max(1.5, 0.5)', v(1.5)],
  ['profile/functions/min_mixed_rejected', 'min(1, 2.0)', cerr('EXPR_TYPE', 'no_overload')],
  ['profile/functions/min_one_arg_rejected', 'min(1)', cerr('EXPR_TYPE', 'no_overload')],
  ['profile/functions/round_half_up', 'round(2.5)', v(3)],
  ['profile/functions/round_half_away_negative', 'round(-2.5)', v(-3)],
  ['profile/functions/round_int_identity', 'round(3)', v(3n)],
  ['profile/functions/floor', 'floor(-1.5)', v(-2)],
  ['profile/functions/ceil', 'ceil(1.2)', v(2)],
  ['profile/functions/int_conversion_not_in_profile', "int('1')", cerr('EXPR_TYPE', 'unknown_function')],
  ['profile/functions/dyn_not_in_profile', 'dyn(1)', cerr('EXPR_TYPE', 'unknown_function')],
  ['profile/functions/type_not_in_profile', 'type(1)', cerr('EXPR_TYPE', 'unknown_function')],
]);

describe('profile/functions/hasSkill', () => {
  it('true for a current skill, false for an expired one, via resource or candidate', () => {
    const act = { now: NOW, candidate: { resource: RES, requirement_key: 'teacher', load: {} }, session: {}, template: {} };
    expect(run("hasSkill(candidate.resource, 'vinyasa')", act, 'candidate')).toMatchObject(v(true));
    expect(run("hasSkill(candidate.resource, 'hot')", act, 'candidate')).toMatchObject(v(false));
    expect(run("hasSkill(candidate, 'vinyasa')", act, 'candidate')).toMatchObject(v(true));
    expect(run("hasSkill(candidate.resource, 'yin')", act, 'candidate')).toMatchObject(v(false));
    expect(run("hasSkill(session, 'yin')", act, 'candidate')).toMatchObject(cerr('EXPR_TYPE', 'no_overload'));
  });
});

describe('profile/syntax/forbidden_constructs', () => {
  it.each([
    ['message_construction', "Foo{a: 1}"],
    ['qualified_message_construction', "a.b.Foo{a: 1}"],
    ['leading_dot', '.obj'],
    ['optional_select', 'obj.?a'],
    ['optional_index', 'xs[?0]'],
    ['bytes_literal', "b'abc'"],
    ['uint_literal', '1u'],
    ['hex_uint_literal', '0x1u'],
  ])('%s', (_n, src) => {
    expect(run(src)).toMatchObject(cerr('EXPR_SYNTAX', 'forbidden_construct'));
  });
});

describe('profile/runtime/budget', () => {
  it('a small step budget is EXPR_BUDGET and is not absorbed by ||', () => {
    expect(run('1 + 1 + 1 + 1 + 1 == 5 || true', { now: NOW }, undefined, undefined, { budget: 5 })).toMatchObject(budget('steps'));
  });
  it('runtime steps stay within the static estimate', () => {
    const out = run("xs.exists(e, e == 3) && ss.all(t, t.startsWith('a'))", { xs: [1, 2, 3], ss: ['ab', 'ac'] });
    expect(out).toMatchObject(v(true));
    expect(out.steps!).toBeLessThanOrEqual(out.cost!);
  });
});
