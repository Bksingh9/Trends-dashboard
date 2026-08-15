/**
 * The shape of a connection test's answer.
 *
 * It lives on its own so the declarative SaaS catalogue and the hand-written
 * tests can both produce one without importing each other — the two directions
 * would otherwise be a cycle.
 */
export interface TestResult {
  ok: boolean;
  /** One line, in the words the UI will show. */
  summary: string;
  /** Each hop attempted, in order, so a failure is located rather than guessed. */
  steps: Array<{ label: string; ok: boolean; detail: string }>;
  /** Anything worth knowing that is not a pass/fail — discovered names, counts. */
  findings?: string[];
}
