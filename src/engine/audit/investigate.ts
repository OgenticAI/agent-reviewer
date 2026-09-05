/**
 * The investigate stage (OGE-2429).
 *
 * One run per question. Each gets the repo map seeded from its own text, the
 * deterministic findings as established facts, and a read-only tool loop over
 * the acquired tree. What comes back is claims — not findings, and not
 * confidence. Confidence is computed later by the verification stage
 * (OGE-2430), from what independent verifiers could and could not refute.
 *
 * ── This is a first draft, and treating it as one is the point ──────────────
 *
 * The WS3 review changed five of nine answers under adversarial challenge. A
 * pipeline that stopped here would have shipped a report wrong on more than
 * half its headline questions, reading exactly as confident as the corrected
 * one. Nothing in this file may present its output as settled.
 *
 * ── Evidence, or it did not happen ──────────────────────────────────────────
 *
 * A claim with no file-and-line evidence is dropped, and the drop is logged
 * against the question id. This mirrors `dropUnsourcedCitations` on the
 * pull-request path, which filters external references down to those a search
 * actually returned and prints every one it removes. An unsourced claim is not
 * a weaker finding; it is a sentence the model wrote.
 */

import type { EvidenceRef } from "./finding.js";
import type { Question } from "./questions.js";
import { seedTextsFor } from "./questions.js";
import { sanitizeUntrusted } from "../tools/sanitize.js";
import { extractsTagsFrom } from "../repomap/tags.js";
import type { FindingSeverity, JobFindings } from "../findings/schema.js";

/** What one question run produced, before anything has been verified. */
export interface Claim {
  questionId: string;
  /** What the run asserts. One statement, not a paragraph. */
  statement: string;
  evidence: EvidenceRef[];
  /** True when the claim asserts something does NOT exist. */
  absence: boolean;
}

export interface QuestionRunResult {
  questionId: string;
  claims: Claim[];
  /** Claims discarded for having no evidence, kept so the count is reportable. */
  dropped: DroppedClaim[];
  /** Repo-relative paths this run opened, for the coverage log (OGE-2426). */
  openedFiles: string[];
}

export interface DroppedClaim {
  questionId: string;
  statement: string;
  reason: "no-evidence" | "unreadable";
}

/* ── The model seam ───────────────────────────────────────────────────────── */

export interface InvestigateRequest {
  question: Question;
  systemPrompt: string;
  userPrompt: string;
}

export interface InvestigateResponse {
  /** Raw model text. Parsed by `parseClaims`, which never throws. */
  text: string;
  /** Paths the tool loop opened during this run. */
  openedFiles?: string[];
  /**
   * Why the tool loop stopped early, when it did.
   *
   * Carried so that an answer which never arrived is reported as an answer
   * that never arrived. Without it a truncated question is indistinguishable
   * from a malformed one, and the two lead an investigation to opposite places.
   */
  truncated?: string;
}

/**
 * The model dependency, injected exactly as `VerdictModel` is on the
 * pull-request path. The real implementation drives the Anthropic SDK and the
 * tool loop; tests pass a stub returning canned JSON, so every rule in this
 * file is testable without a model.
 */
export interface InvestigateModel {
  investigate(request: InvestigateRequest): Promise<InvestigateResponse>;
}

/* ── Prompt assembly ──────────────────────────────────────────────────────── */

const SYSTEM_PROMPT = [
  "You are auditing a codebase you did not write and cannot run.",
  "",
  "Answer the question with claims grounded in files you have actually read.",
  "Every claim carries at least one evidence reference: a repo-relative path,",
  "and a line number where you have one. A claim you cannot cite is a claim you",
  "must not make — say you could not establish it instead.",
  "",
  "You are producing a FIRST DRAFT. Independent verifiers will try to refute",
  "every claim from its cited evidence. Write what you can defend, not what",
  "sounds strongest.",
  "",
  "If the answer is that something does not exist, say so explicitly and set",
  '"absence": true. Absence is re-tested separately before it is reported.',
  "",
  "Reply with JSON only:",
  '{"claims":[{"statement":"...","absence":false,',
  '"evidence":[{"path":"src/x.ts","line":42,"quote":"..."}]}]}',
].join("\n");

/**
 * Established facts from the deterministic pass, handed over so the model
 * annotates rather than re-derives.
 *
 * `parsed: false` is stated as loudly as a finding. A model that reads silence
 * as "clean" will report a clean bill of health the run never earned, which is
 * the exact failure `JobFindings.parsed` exists to prevent.
 *
 * An empty result is a positive fact only for the files the tool read, so the
 * count comes with it. A semgrep run whose rule pack failed to load reported
 * nothing across zero files, and the first version of this told the model
 * that was a positive fact about the whole tree. Zero files read is stated as
 * unknown, and a job that did not record what it read is stated as unmeasured.
 */
export function renderAnalyzerFacts(jobs: JobFindings[]): string {
  if (jobs.length === 0) return "No deterministic analysis was run.";

  const lines = [
    "Established by deterministic analysis — do NOT re-derive these:",
  ];
  for (const job of jobs) {
    if (!job.parsed) {
      lines.push(
        `- ${job.job}: DID NOT RUN (${job.reason ?? "no reason recorded"}).`,
      );
      lines.push(`  Treat this as unknown, never as clean.`);
      continue;
    }
    const read = Array.isArray(job.scannedPaths) ? job.scannedPaths.length : null;
    if (job.findings.length === 0) {
      if (read === null) {
        lines.push(
          `- ${job.job}: ran and reported nothing, but did not record which files it read.`,
        );
        lines.push(`  Treat its reach as unknown; this is not a clean bill for any file.`);
      } else if (read === 0) {
        lines.push(`- ${job.job}: ran and reported nothing, but scanned 0 files.`);
        lines.push(`  Treat this as unknown, never as clean.`);
      } else {
        lines.push(
          `- ${job.job}: scanned ${read} files and reported nothing. This is a positive fact for those files only.`,
        );
      }
      continue;
    }
    lines.push(
      `- ${job.job}: ${job.findings.length} finding(s)${read === null ? "" : ` across ${read} scanned files`}, including:`,
    );
    for (const finding of job.findings.slice(0, 20)) {
      lines.push(
        `    ${finding.path} [${finding.severity}] ${finding.message}`,
      );
    }
    if (job.findings.length > 20) {
      lines.push(`    … and ${job.findings.length - 20} more`);
    }
  }
  return lines.join("\n");
}

/* ── What the map covers ──────────────────────────────────────────────────── */

/** A tree file as the prompt needs it: where it is and what language it is. */
export interface TreeFileLike {
  path: string;
  language: string;
}

/**
 * The map as the prompt receives it: the text, and the files the text names.
 *
 * `files` is what lets the prompt say what the map covers. A caller that has
 * only text (a test stub, an older map renderer) may pass a bare string, and
 * the prompt then says the map's coverage was not computed rather than
 * inventing a figure.
 */
export interface PromptMap {
  text: string;
  files?: string[];
}

/** One language's share of the tree, and how much of it the map names. */
export interface LanguageScope {
  language: string;
  /** Files of this language in the tree. */
  files: number;
  /** Files of this language the map names. */
  mapped: number;
  /** Whether the tag extractor reads this language at all. */
  extracted: boolean;
}

export interface MapScope {
  /** Files the map names, out of the tree's in-scope files. */
  mapped: number;
  total: number;
  /** Largest language first, then by name, so the model reads the bulk of the tree first. */
  languages: LanguageScope[];
}

/**
 * How much of the tree the map covers, honestly, by language.
 *
 * A language counts as extracted when the extractor reads its files, decided
 * per file by the extractor's own predicate rather than by a list copied
 * here. C# was added to the extractor this week; a copied list would already
 * have been wrong once.
 */
export function describeMapScope(
  files: ReadonlyArray<TreeFileLike>,
  mappedPaths: ReadonlyArray<string>,
): MapScope {
  const mapped = new Set(mappedPaths);
  const byLanguage = new Map<string, LanguageScope>();
  for (const file of files) {
    const entry = byLanguage.get(file.language) ?? {
      language: file.language,
      files: 0,
      mapped: 0,
      extracted: false,
    };
    entry.files += 1;
    if (mapped.has(file.path)) entry.mapped += 1;
    if (extractsTagsFrom(file.path)) entry.extracted = true;
    byLanguage.set(file.language, entry);
  }
  return {
    mapped: files.filter((file) => mapped.has(file.path)).length,
    total: files.length,
    languages: [...byLanguage.values()].sort(
      (a, b) => b.files - a.files || a.language.localeCompare(b.language),
    ),
  };
}

/**
 * The sentence above the map that says what the map is.
 *
 * Without it, a thin map and an empty area read the same: the model saw no
 * symbols under `src/payments/` and concluded there were none, when the map
 * had simply run out of budget before it got there, or the language was one
 * the extractor does not read. Absence claims were being drawn from silence.
 * Stated whether or not the scope is known, because the instruction that an
 * unmapped area is not an empty one is the part the model has to carry.
 */
export function renderMapScope(scope: MapScope | undefined): string {
  const lines = ["MAP SCOPE"];
  if (scope === undefined) {
    lines.push("The map's coverage of the tree was not computed for this run.");
  } else {
    const shares = scope.languages
      .map((l) => `${l.language} ${l.mapped} of ${l.files}${l.extracted ? "" : " (not read by the map)"}`)
      .join("; ");
    lines.push(`This map names ${scope.mapped} of ${scope.total} files in the tree. By language: ${shares || "none"}.`);
    const unread = scope.languages.filter((l) => !l.extracted).map((l) => l.language);
    lines.push(
      unread.length > 0
        ? `The map extractor does not read ${unread.join(", ")}, so those files contribute nothing here whatever they contain.`
        : "The map extractor reads every language in this tree.",
    );
  }
  lines.push(
    "An area absent from the map is UNMAPPED, not empty. Use search_repo and list_files " +
      "to look there before concluding that anything is missing.",
  );
  return lines.join("\n");
}

/* ── What the sweep found ─────────────────────────────────────────────────── */

/**
 * A sweep signal as this stage needs it. Structural, and `kind` is a plain
 * string: the sweep's kind names are data here, because they are being renamed
 * and added to in another build and a type would refuse a sweep.json written
 * after this file was.
 */
export interface SweepSignalLike {
  path: string;
  line: number;
  kind: string;
  signalClass: "surface" | "defect";
  excerpt: string;
}

/**
 * Defect candidates per question, at most.
 *
 * Twelve is about a screen of lines: enough to hand the model every candidate
 * a question usually has, few enough that it opens each one rather than
 * skimming the list. The rest are still folded into findings.json by the merge
 * at closure, so a candidate past the cap is not lost, only not seeded.
 */
export const SWEEP_SEED_LIMIT = 12;

export interface SweepSeeds {
  /** Defect-class signals of the question's kinds, ranked, capped at the limit. */
  defects: SweepSignalLike[];
  /** How many defect-class signals of those kinds there were before the cap. */
  defectTotal: number;
  /** Surface-class kinds the question named, counted rather than listed. */
  surface: Array<{ kind: string; count: number; files: number }>;
  /** Kinds the question named that the sweep does not know. Warned about by the caller. */
  unknownKinds: string[];
}

/**
 * Where a kind ranks, by consequence. Unknown kinds never get here: they are
 * dropped before selection. Ties fall to path then line so two runs over an
 * unchanged tree seed the same lines in the same order.
 */
const SEVERITY_RANK: Record<FindingSeverity, number> = { error: 0, warning: 1, info: 2, unknown: 3 };

/**
 * Pick what the sweep found that this question should open first.
 *
 * `severityOf` is the sweep's own ranking of a kind, or undefined for a name
 * it does not know. Passed in rather than imported so this file does not
 * depend on the table that owns the kinds, which another build is editing.
 */
export function selectSweepSeeds(
  question: Question,
  signals: ReadonlyArray<SweepSignalLike>,
  severityOf: (kind: string) => FindingSeverity | undefined,
): SweepSeeds {
  const named = question.signals ?? [];
  const unknownKinds = named.filter((kind) => severityOf(kind) === undefined);
  const wanted = new Set(named.filter((kind) => severityOf(kind) !== undefined));

  const defects = signals
    .filter((signal) => signal.signalClass === "defect" && wanted.has(signal.kind))
    .sort(
      (a, b) =>
        SEVERITY_RANK[severityOf(a.kind)!] - SEVERITY_RANK[severityOf(b.kind)!] ||
        a.path.localeCompare(b.path) ||
        a.line - b.line,
    );

  const surfaceByKind = new Map<string, { count: number; files: Set<string> }>();
  for (const signal of signals) {
    if (signal.signalClass !== "surface" || !wanted.has(signal.kind)) continue;
    const bucket = surfaceByKind.get(signal.kind) ?? { count: 0, files: new Set<string>() };
    bucket.count += 1;
    bucket.files.add(signal.path);
    surfaceByKind.set(signal.kind, bucket);
  }

  return {
    defects: defects.slice(0, SWEEP_SEED_LIMIT),
    defectTotal: defects.length,
    surface: [...surfaceByKind]
      .map(([kind, b]) => ({ kind, count: b.count, files: b.files.size }))
      .sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind)),
    unknownKinds,
  };
}

/**
 * The block that hands the candidates over.
 *
 * The excerpt is shown so the model knows what it is looking for, and the
 * instruction says not to cite it. The verifier re-reads every cited line, and
 * a citation copied from this block would pass that check while the model had
 * read nothing: exactly the answered-from-memory failure the tools exist to
 * end. Empty when there is nothing to hand over, so a question with no
 * candidates gets no block rather than an empty heading that reads as "the
 * sweep found nothing here".
 */
export function renderSweepSeeds(seeds: SweepSeeds | undefined): string {
  if (seeds === undefined || (seeds.defects.length === 0 && seeds.surface.length === 0)) return "";

  const lines = ["THE SWEEP FOUND"];
  if (seeds.defects.length > 0) {
    lines.push(
      "A deterministic pass over every file matched these lines. They are candidates, not " +
        "findings. Open each file FIRST with read_file and cite what you read there, at the line " +
        "numbers the tool shows you. Never cite an excerpt from this list as evidence.",
    );
    for (const signal of seeds.defects) {
      lines.push(`- ${signal.path}:${signal.line} [${signal.kind}] ${signal.excerpt}`);
    }
    if (seeds.defectTotal > seeds.defects.length) {
      lines.push(`(${seeds.defectTotal - seeds.defects.length} more of these kinds were matched and are not listed.)`);
    }
  }
  if (seeds.surface.length > 0) {
    const counts = seeds.surface
      .map((row) => `${row.kind} ${row.count} line(s) across ${row.files} file(s)`)
      .join("; ");
    lines.push(`The sweep also counted, as surface rather than defects: ${counts}.`);
  }
  return lines.join("\n");
}

export interface PromptInput {
  question: Question;
  repoMap: string;
  /** What the map covers. Undefined is stated as unknown, never as complete. */
  mapScope?: MapScope;
  analyzerFacts: string;
  /** What the sweep matched for this question, if a sweep ran and the question names kinds. */
  sweepSeeds?: SweepSeeds;
}

/**
 * Build the user prompt.
 *
 * Every piece of text that came from the tree under audit is sanitised first.
 * A codebase can carry an instruction addressed to the reviewer — in an HTML
 * comment, in zero-width characters, in a hidden attribute — and those are
 * dangerous precisely because a human reading the file sees nothing. The
 * sweep's excerpts and paths are lines from that tree and get the same
 * treatment.
 */
export function buildUserPrompt(input: PromptInput): string {
  return [
    `QUESTION (${input.question.id})`,
    input.question.ask,
    "",
    renderMapScope(input.mapScope),
    "",
    "REPOSITORY MAP",
    sanitizeUntrusted(input.repoMap),
    "",
    sanitizeUntrusted(input.analyzerFacts),
    "",
    sanitizeUntrusted(renderSweepSeeds(input.sweepSeeds)),
    "",
    input.question.absenceClaim
      ? 'This question may legitimately answer "there is none". If so, say which vocabularies you searched.'
      : "",
  ]
    .filter((section) => section !== "")
    .join("\n");
}

/* ── Parsing what came back ───────────────────────────────────────────────── */

function coerceEvidence(
  raw: unknown,
  subjectRev: string | null,
): EvidenceRef[] {
  if (!Array.isArray(raw)) return [];

  return raw.flatMap((entry): EvidenceRef[] => {
    if (typeof entry !== "object" || entry === null) return [];
    const ref = entry as Record<string, unknown>;
    const path = typeof ref.path === "string" ? ref.path.trim() : "";
    if (!path) return [];

    const line =
      typeof ref.line === "number" && Number.isFinite(ref.line)
        ? ref.line
        : undefined;
    // The quote came out of the tree under audit; it is untrusted text like any
    // other, and it ends up in a report.
    const quote =
      typeof ref.quote === "string" ? sanitizeUntrusted(ref.quote) : undefined;

    return [
      {
        path,
        rev: subjectRev,
        ...(line === undefined ? {} : { line }),
        ...(quote === undefined || quote === "" ? {} : { quote }),
      },
    ];
  });
}

/** Pull the JSON object out of a reply that may be fenced or prefaced. */
/**
 * How much of an unrecognised reply to keep.
 *
 * Enough to see WHAT came back — prose, an apology, an error, an empty string —
 * without pasting a model's essay into a log line.
 */
export const REPLY_EXCERPT_CHARS = 200;

/**
 * Say what the model actually returned, rather than only that it was wrong.
 *
 * `(unparseable reply)` on its own is the same shape as reporting a Python
 * crash as "Traceback (most recent call last):" — accurate, well-formed, and
 * carrying nothing anyone can act on. A run where all ten questions came back
 * unparseable left no way to tell an empty response from an apology from a
 * rate-limit notice rendered as prose.
 *
 * Whitespace is collapsed because a reply full of newlines would otherwise take
 * ten lines of the run log to say nothing.
 */
export function replyExcerpt(text: string): string {
  const flat = (text ?? "").replace(/\s+/g, " ").trim();
  if (flat === "") return "empty response";
  return flat.length <= REPLY_EXCERPT_CHARS
    ? flat
    : `${flat.slice(0, REPLY_EXCERPT_CHARS - 1)}\u2026`;
}

/**
 * The last balanced JSON object in a string.
 *
 * Slicing from the FIRST "{" to the LAST "}" fails the moment any prose before
 * the answer contains a brace — and on a TypeScript codebase the model quotes
 * code constantly, so it always does. That produced ten unparseable replies on
 * a real run where every answer was in fact well-formed.
 *
 * Scanning backwards for a balanced object finds the answer regardless of what
 * was said before it. Strings are tracked so a brace inside a quoted code
 * fragment cannot unbalance the count.
 */
function lastJsonObject(text: string): string | null {
  for (let end = text.lastIndexOf("}"); end !== -1; end = text.lastIndexOf("}", end - 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = end; i >= 0; i--) {
      const ch = text[i] as string;

      if (inString) {
        // Walking backwards, a quote ends the string unless it is escaped —
        // and that is decided by the run of backslashes before it.
        if (ch === '"') {
          let slashes = 0;
          for (let j = i - 1; j >= 0 && text[j] === "\\"; j--) slashes++;
          if (slashes % 2 === 0) inString = false;
        }
        continue;
      }

      if (ch === '"') { inString = true; escaped = false; continue; }
      if (ch === "}") depth++;
      else if (ch === "{") {
        depth--;
        if (depth === 0) return text.slice(i, end + 1);
      }
    }
    void escaped;
  }
  return null;
}

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced?.[1] ?? text).trim();
  const object = lastJsonObject(candidate);
  if (object === null) return null;
  try {
    return JSON.parse(object);
  } catch {
    return null;
  }
}

/**
 * Parse a reply into claims, dropping every one that cites nothing.
 *
 * Never throws. A malformed reply for one question must not take down the
 * other eight, and it is recorded rather than silently producing zero claims.
 */
export function parseClaims(
  text: string,
  question: Question,
  subjectRev: string | null,
  context?: { truncated?: string },
): { claims: Claim[]; dropped: DroppedClaim[] } {
  const data = extractJson(text);
  if (typeof data !== "object" || data === null) {
    // Say which of the two happened. "Unparseable" names the parser, and when
    // the real cause was a question that ran out of tool-loop budget before it
    // answered, that sends whoever reads it to the wrong file. A whole run of
    // ten truncated questions was investigated as a parser fault (OGE-2511).
    const statement = context?.truncated
      ? `(no answer — ${context.truncated}; last words: ${replyExcerpt(text)})`
      : `(unparseable reply: ${replyExcerpt(text)})`;
    return {
      claims: [],
      dropped: [{ questionId: question.id, statement, reason: "unreadable" }],
    };
  }

  const rawClaims = (data as { claims?: unknown }).claims;
  if (!Array.isArray(rawClaims)) {
    return {
      claims: [],
      dropped: [
        {
          questionId: question.id,
          statement: "(reply had no claims array)",
          reason: "unreadable",
        },
      ],
    };
  }

  const claims: Claim[] = [];
  const dropped: DroppedClaim[] = [];

  for (const entry of rawClaims) {
    if (typeof entry !== "object" || entry === null) continue;
    const raw = entry as Record<string, unknown>;
    const statement =
      typeof raw.statement === "string" ? raw.statement.trim() : "";
    if (!statement) continue;

    const evidence = coerceEvidence(raw.evidence, subjectRev);
    if (evidence.length === 0) {
      // The line that keeps the stage honest.
      dropped.push({
        questionId: question.id,
        statement,
        reason: "no-evidence",
      });
      continue;
    }

    claims.push({
      questionId: question.id,
      statement,
      evidence,
      absence: raw.absence === true,
    });
  }

  return { claims, dropped };
}

/* ── Running the stage ────────────────────────────────────────────────────── */

export interface InvestigateOptions {
  questions: Question[];
  model: InvestigateModel;
  /**
   * Ranked repo map for one question, seeded from that question's own text.
   *
   * A `PromptMap` says which files it names, and the prompt then states what
   * the map covers per language. A bare string is accepted for callers that
   * have nothing more, and the prompt says the coverage was not computed.
   */
  repoMapFor(seedTexts: string[]): string | PromptMap;
  /**
   * Every in-scope file with its language: the inventory. Needed for the map
   * scope statement; without it the prompt says the scope is unknown.
   */
  treeFiles?: ReadonlyArray<TreeFileLike>;
  /**
   * What the sweep found, when it ran. `severityOf` is the sweep's own rank
   * for a kind, undefined for a kind it does not know; see `selectSweepSeeds`.
   */
  sweep?: {
    signals: ReadonlyArray<SweepSignalLike>;
    severityOf(kind: string): FindingSeverity | undefined;
  };
  analyzerJobs: JobFindings[];
  subjectRev: string | null;
  /** Where dropped claims are announced. Defaults to stderr. */
  log?: (message: string) => void;
  /**
   * Called as each question finishes, in completion order.
   *
   * Questions run concurrently, so this is the only honest source of progress
   * — a caller counting its own loop would report work that has been started
   * rather than work that is done.
   */
  onProgress?: (done: number, total: number) => void;
}

/**
 * Investigate every question.
 *
 * One question failing is not the run failing: its result comes back with no
 * claims and a recorded drop, and the other questions are unaffected. An audit
 * that fell over on question three and reported nothing would be worse than one
 * that says which question it could not answer.
 */
export async function investigate(
  options: InvestigateOptions,
): Promise<QuestionRunResult[]> {
  const log = options.log ?? ((message: string) => console.error(message));
  const analyzerFacts = renderAnalyzerFacts(options.analyzerJobs);

  let done = 0;
  const total = options.questions.length;
  const advance = () => options.onProgress?.(++done, total);

  const runs = options.questions.map((question) =>
    // `finally`, so a question that failed still counts as finished. Advancing
    // only on the success path would leave a progress bar permanently short of
    // its denominator on any run with a failed question.
    (async (): Promise<QuestionRunResult> => {
      const rawMap = options.repoMapFor(seedTextsFor(question));
      const map: PromptMap = typeof rawMap === "string" ? { text: rawMap } : rawMap;
      const mapScope =
        options.treeFiles !== undefined && map.files !== undefined
          ? describeMapScope(options.treeFiles, map.files)
          : undefined;

      let sweepSeeds: SweepSeeds | undefined;
      if (options.sweep !== undefined && question.signals !== undefined) {
        sweepSeeds = selectSweepSeeds(question, options.sweep.signals, options.sweep.severityOf);
        // Warned, not refused. The sweep's kinds are being renamed in another
        // build, and a taxonomy naming a kind this sweep does not know yet
        // should still run; the log says which names did nothing.
        if (sweepSeeds.unknownKinds.length > 0) {
          log(
            `[investigate] ${question.id}: sweep signal kind(s) not known to this sweep, ignored: ` +
              sweepSeeds.unknownKinds.join(", "),
          );
        }
      }

      const userPrompt = buildUserPrompt({
        question,
        repoMap: map.text,
        mapScope,
        analyzerFacts,
        sweepSeeds,
      });

      let response: InvestigateResponse;
      try {
        response = await options.model.investigate({
          question,
          systemPrompt: SYSTEM_PROMPT,
          userPrompt,
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        log(`[investigate] ${question.id} failed: ${detail}`);
        return {
          questionId: question.id,
          claims: [],
          dropped: [
            {
              questionId: question.id,
              statement: `(run failed: ${detail})`,
              reason: "unreadable",
            },
          ],
          openedFiles: [],
        };
      }

      const { claims, dropped } = parseClaims(
        response.text,
        question,
        options.subjectRev,
        { truncated: response.truncated },
      );
      for (const drop of dropped) {
        log(
          `[investigate] dropped claim on ${drop.questionId} (${drop.reason}): ${drop.statement}`,
        );
      }

      return {
        questionId: question.id,
        claims,
        dropped,
        openedFiles: response.openedFiles ?? [],
      };
    })().finally(advance),
  );

  return Promise.all(runs);
}

/**
 * Ten failures with one cause are one fact, not ten.
 *
 * Measured on the box: an invalid API key produced ten identical
 * `401 authentication_error` lines, the stage completed, and the operator was
 * left to infer from a wall of repetition that the credential was the problem.
 * The worker then retried the whole audit twice more — re-cloning and
 * re-analysing a repository — for a key that could not become valid.
 *
 * A question that fails for its own reasons is still dropped and still counted;
 * that is the honest denominator this file exists to keep. But when EVERY
 * question failed and none produced a claim, the investigation did not happen,
 * and saying so once is worth more than saying nothing ten times.
 */
export function modelUnusableFrom(results: QuestionRunResult[]): string | null {
  if (results.length === 0) return null;

  const failures = results.filter(
    (result) =>
      result.claims.length === 0 &&
      result.dropped.length > 0 &&
      result.dropped.every((drop) => drop.statement.startsWith("(run failed:")),
  );
  if (failures.length !== results.length) return null;

  // The shared detail, if there is one. Different errors across every question
  // is a different problem and should not be described as a single cause.
  const details = new Set(
    failures.flatMap((result) => result.dropped.map((drop) => drop.statement)),
  );
  const shared = details.size === 1 ? [...details][0] ?? "" : "";
  const detail = shared.replace(/^\(run failed: /, "").replace(/\)$/, "");

  return (
    `every one of the ${results.length} questions failed and none produced a claim, ` +
    `so no investigation took place. ` +
    (detail
      ? `They all failed the same way: ${detail}`
      : `They failed in different ways; the run log has each one.`)
  );
}

/**
 * A claim still standing, at whatever point the question is asked.
 *
 * Structural on purpose: before verify the standing claims are the results'
 * own `claims`; after verify they are the ones verify let through, which the
 * verify module carries wrapped. Both have a question id, and that is all
 * coverage needs.
 */
export interface StandingClaim {
  questionId: string;
}

/**
 * The questions that came out with nothing (OGE-2711).
 *
 * A question whose every claim was dropped, and one whose run failed, and one
 * the model answered with an empty list, all look the same from here: no
 * standing claim. That is the right thing to count. The claims total already
 * says how much the stage produced; this says how much of the question set it
 * produced it FROM, because ten claims on one question and none on the other
 * nine is a report about one question wearing the cover of ten.
 *
 * `standing` defaults to every claim the parser kept, which is what this stage
 * knows. It is asked again after verify with the claims verify let through,
 * because a question that hit its budget and answered from memory keeps every
 * recalled citation here (each has a path, so the parser keeps it) and loses
 * every one of them at verify's anchor check. Counted here alone, a run that
 * answered every question from memory would report full coverage and pass
 * the release gate with no findings behind it.
 *
 * Named, not just counted, so the run record can say which ones.
 */
export function questionsWithoutFindings(
  results: QuestionRunResult[],
  standing: ReadonlyArray<StandingClaim> = results.flatMap((result) => result.claims),
): string[] {
  const answered = new Set(standing.map((claim) => claim.questionId));
  return results
    .filter((result) => !answered.has(result.questionId))
    .map((result) => result.questionId);
}

/** Totals for the run record and the report's method section. */
export function summariseInvestigation(results: QuestionRunResult[]): {
  questions: number;
  /** Distinct question ids with at least one kept claim. */
  questionsWithFindings: number;
  claims: number;
  dropped: number;
  filesOpened: number;
} {
  const opened = new Set(results.flatMap((result) => result.openedFiles));
  return {
    questions: results.length,
    questionsWithFindings: results.length - questionsWithoutFindings(results).length,
    claims: results.reduce((total, result) => total + result.claims.length, 0),
    dropped: results.reduce(
      (total, result) => total + result.dropped.length,
      0,
    ),
    filesOpened: opened.size,
  };
}
