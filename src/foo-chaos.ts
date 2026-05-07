/**
 * Throwaway module used by OGE-391 chaos test F to exercise the auto-patch path.
 * The function is trivial; its purpose is to be a "mechanically fixable"
 * candidate when the UAT checklist asserts a missing test.
 */
export function bar(): number {
  return 42;
}
