// Kairos lint rules (§14.1, §19.2).
//  - no-async-in-tx: a transaction body passed to `.tx(...)` must be synchronous: not async, no await, no fetch,
//    no promise chains. Awaits belong between transactions (§19.2).
//  - no-kind-branch: engines never branch on session kind (principle 4, §14.1, D-56). Engine and workflow code
//    may not read `<template>.kind` or compare anything to 'class' or 'shift'.

const isFn = (n) => n && (n.type === 'ArrowFunctionExpression' || n.type === 'FunctionExpression');

function walk(node, visit, inNested = false) {
  if (!node || typeof node.type !== 'string') return;
  visit(node, inNested);
  for (const key of Object.keys(node)) {
    if (key === 'parent') continue;
    const v = node[key];
    const nested = inNested || isFn(node);
    if (Array.isArray(v)) v.forEach((c) => c && typeof c.type === 'string' && walk(c, visit, nested));
    else if (v && typeof v.type === 'string') walk(v, visit, nested);
  }
}

const noAsyncInTx = {
  meta: { type: 'problem', docs: { description: 'Transaction bodies must be synchronous (§19.2)' }, schema: [] },
  create(context) {
    return {
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type !== 'MemberExpression' || callee.property.type !== 'Identifier' || callee.property.name !== 'tx') return;
        const body = node.arguments[0];
        if (!isFn(body)) return;
        if (body.async) {
          context.report({ node: body, message: 'Transaction body is async. A transaction never spans an await (§19.2).' });
          return;
        }
        walk(body.body, (n, nested) => {
          if (nested) return;   // functions defined inside the body may be async helpers that are not called here
          if (n.type === 'AwaitExpression') context.report({ node: n, message: 'await inside a transaction body (§19.2).' });
          if (n.type === 'CallExpression') {
            const c = n.callee;
            if (c.type === 'Identifier' && c.name === 'fetch') context.report({ node: n, message: 'fetch inside a transaction body (§19.2).' });
            if (c.type === 'MemberExpression' && c.property.type === 'Identifier' && ['then', 'fetch'].includes(c.property.name)) {
              context.report({ node: n, message: `.${c.property.name}() inside a transaction body (§19.2).` });
            }
          }
        });
      },
    };
  },
};

const KIND_VALUES = new Set(['class', 'shift']);
const isKindLiteral = (n) => n && n.type === 'Literal' && KIND_VALUES.has(n.value);

const noKindBranch = {
  meta: { type: 'problem', docs: { description: 'Engines never branch on session kind (§1.2 principle 4)' }, schema: [] },
  create(context) {
    return {
      BinaryExpression(node) {
        if (['===', '==', '!==', '!='].includes(node.operator) && (isKindLiteral(node.left) || isKindLiteral(node.right))) {
          context.report({ node, message: "Comparison with 'class' or 'shift'. Behaviour comes from requirements, capacity and policies, not kind." });
        }
      },
      SwitchCase(node) {
        if (isKindLiteral(node.test)) context.report({ node, message: "case 'class' / 'shift'. Engines never branch on kind." });
      },
      MemberExpression(node) {
        if (node.property.type !== 'Identifier' || node.property.name !== 'kind') return;
        const obj = node.object;
        const name = obj.type === 'Identifier' ? obj.name : obj.type === 'MemberExpression' && obj.property.type === 'Identifier' ? obj.property.name : '';
        if (/template|tpl/i.test(name)) context.report({ node, message: 'Reading template.kind. Only packages/export may (D-56).' });
      },
    };
  },
};

export default { rules: { 'no-async-in-tx': noAsyncInTx, 'no-kind-branch': noKindBranch } };
