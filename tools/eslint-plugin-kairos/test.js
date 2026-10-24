import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import plugin from './index.js';

const tester = new RuleTester({ languageOptions: { parser: tseslint.parser, ecmaVersion: 2022, sourceType: 'module' } });

tester.run('no-async-in-tx', plugin.rules['no-async-in-tx'], {
  valid: [
    'db.tx((tx) => tx.run("x"))',
    'db.tx((tx) => { const f = async () => { await g(); }; return 1; })',
    'await fetch(u); db.tx((tx) => tx.run("x"));',
  ],
  invalid: [
    { code: 'db.tx(async (tx) => { tx.run("x"); })', errors: 1 },
    { code: 'this.db.tx((tx) => { fetch(u); })', errors: 1 },
    { code: 'db.tx((tx) => { p.then(() => 1); })', errors: 1 },
    { code: 'db.tx(function (tx) { env.GATEWAY.fetch(r); })', errors: 1 },
  ],
});

tester.run('no-kind-branch', plugin.rules['no-kind-branch'], {
  valid: ["if (offer.kind === 'place') {}", 'const k = requirement.key;'],
  invalid: [
    { code: "if (t.kind === 'class') {}", errors: 1 },
    { code: "switch (x) { case 'shift': break; }", errors: 1 },
    { code: 'const k = template.kind;', errors: 1 },
    { code: 'const k = def.templateDef.kind;', errors: 1 },
  ],
});
