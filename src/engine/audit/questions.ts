/**
 * The question set that drives an audit (OGE-2429).
 *
 * A pull-request review is driven by a diff and a checklist. An audit has
 * neither, so the question set is what decides where the run looks — it is the
 * contract for what the report answers, and anything outside it is out of scope
 * by agreement rather than by omission.
 *
 * ── Why these live in a file rather than a prompt ────────────────────────────
 *
 * A question set is reviewable, diffable, and reusable across engagements. A
 * question buried in a prompt string is none of those, and nobody can tell
 * afterwards which questions were actually asked.
 *
 * ── The rule about what may be committed ────────────────────────────────────
 *
 * `questions/` is in a PUBLIC repository. The baseline taxonomy is generic and
 * belongs here; a per-engagement set names a client's product surface and does
 * not. `loadQuestionSet` takes a path so an engagement can keep its own set
 * beside its working tree, and `assertGeneric` refuses to let one be committed
 * here by accident.
 */

import { readFileSync } from "node:fs";
import { parse } from "yaml";

export interface Question {
  /** Stable, kebab-case. Appears in every claim and every dropped-claim log line. */
  id: string;
  /** The question, phrased so a wrong answer is falsifiable. */
  ask: string;
  /** Why it earns its place. Read by a human, not by the model. */
  why?: string;
  /** Identifiers to rank files by. Hints that boost, never filters that exclude. */
  seeds: string[];
  /**
   * True when "there is none" is a possible answer.
   *
   * Absence is the easiest claim to get wrong and the most damaging to retract,
   * so the verification stage (OGE-2430) re-tests these against several
   * vocabularies before "no" may stand.
   */
  absenceClaim: boolean;
}

export interface QuestionSet {
  version: number;
  name: string;
  description?: string;
  questions: Question[];
}

export class QuestionSetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuestionSetError";
  }
}

function asStringArray(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "");
}

/**
 * Parse and validate a question set.
 *
 * Total in the sense that matters: it either returns a usable set or throws
 * with the reason. A half-parsed set would run an audit that silently skipped
 * questions, and the report would look complete.
 */
export function parseQuestionSet(raw: string): QuestionSet {
  let data: unknown;
  try {
    data = parse(raw);
  } catch (error) {
    throw new QuestionSetError(`not valid YAML: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof data !== "object" || data === null) {
    throw new QuestionSetError("expected a mapping at the top level");
  }

  const doc = data as Record<string, unknown>;
  const rawQuestions = doc.questions;
  if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) {
    throw new QuestionSetError("`questions` must be a non-empty list");
  }

  const seen = new Set<string>();
  const questions = rawQuestions.map((entry, index): Question => {
    if (typeof entry !== "object" || entry === null) {
      throw new QuestionSetError(`question ${index} is not a mapping`);
    }
    const q = entry as Record<string, unknown>;
    const id = typeof q.id === "string" ? q.id.trim() : "";
    const ask = typeof q.ask === "string" ? q.ask.trim() : "";

    if (!id) throw new QuestionSetError(`question ${index} has no id`);
    if (!ask) throw new QuestionSetError(`question "${id}" has no ask`);
    // A duplicate id would merge two questions' claims into one, and the report
    // would show a question answered that was never asked.
    if (seen.has(id)) throw new QuestionSetError(`duplicate question id "${id}"`);
    seen.add(id);

    return {
      id,
      ask,
      ...(typeof q.why === "string" ? { why: q.why.trim() } : {}),
      seeds: asStringArray(q.seeds),
      absenceClaim: q.absence_claim === true,
    };
  });

  return {
    version: typeof doc.version === "number" ? doc.version : 1,
    name: typeof doc.name === "string" ? doc.name : "unnamed",
    ...(typeof doc.description === "string" ? { description: doc.description.trim() } : {}),
    questions,
  };
}

export function loadQuestionSet(path: string): QuestionSet {
  return parseQuestionSet(readFileSync(path, "utf8"));
}

/**
 * The text a repo map is seeded from for one question.
 *
 * The ranker extracts identifiers from arbitrary text and does not care where
 * the text came from — that is the whole point of `seedTexts` (OGE-2424). The
 * question and its seeds go in together, so a question that names a concept in
 * prose still ranks the files that implement it.
 */
export function seedTextsFor(question: Question): string[] {
  return [question.ask, ...question.seeds];
}
