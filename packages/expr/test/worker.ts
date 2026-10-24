// Test-only worker. The tests import @kairos/expr directly; this only gives them a workerd isolate.
export default {
  fetch: () => new Response('test worker'),
};
