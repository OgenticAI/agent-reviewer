/**
 * C# def/ref extraction for the repo map.
 *
 * The subjects this engine is built for are a .NET API with a TypeScript
 * client. With TS/JS the only language the extractor understood, the map was
 * empty for the half of the tree that holds the controllers, the services and
 * the DI wiring, which is most of the code and most of what the questions are
 * about. This module is the regex backend for `.cs`, behind the same
 * `extractTags` seam as TS/JS, so a tree-sitter backend can still replace both
 * later without touching rank or render.
 *
 * ── What is different from the TS/JS extractor ──────────────────────────────
 *
 * Three things a naive port would get wrong on C#:
 *
 * 1. Comments and strings are masked before any pattern runs. C# code carries
 *    XML doc comments on nearly every public member, and those comments name
 *    types constantly ("Returns an OrderDto"). A class name in a comment is
 *    not a definition, and counting it as one puts a phantom def in the map.
 * 2. Definitions are gated on brace depth. Allman braces, nested types and
 *    local functions all look identical to a line regex; tracking which type
 *    body a line sits in is what keeps a local function inside a method body
 *    from showing up as a member of the class.
 * 3. The reference filter carries a BCL noise list. `rankFiles` only links a
 *    ref to a name that has a def, so `Task` and `List` would never form an
 *    edge anyway. The list exists for `filesMatchingIdentifiers`, which seeds
 *    the personalization vector from a question's words against EVERY tag: a
 *    question that mentions "exception" must not seed every file that catches
 *    one, or the seed set becomes the whole tree and the ranking goes flat.
 */

import type { Tag } from "./tags.js";

/** Reserved and contextual keywords. None of these is ever a symbol. */
const CS_KEYWORDS = new Set([
  "abstract", "add", "alias", "and", "args", "ascending", "async", "await", "base", "bool",
  "break", "byte", "case", "catch", "char", "checked", "class", "const", "continue",
  "decimal", "default", "delegate", "descending", "double", "dynamic", "else", "enum",
  "equals", "event", "explicit", "extern", "false", "file", "finally", "fixed", "float",
  "for", "foreach", "from", "get", "global", "goto", "group", "implicit", "init", "int",
  "interface", "internal", "into", "join", "let", "lock", "long", "managed", "nameof",
  "namespace", "new", "nint", "not", "notnull", "nuint", "null", "object", "operator",
  "orderby", "out", "override", "params", "partial", "private", "protected", "public",
  "readonly", "record", "ref", "remove", "required", "return", "sbyte", "scoped", "sealed",
  "select", "set", "short", "sizeof", "stackalloc", "static", "string", "struct", "switch",
  "this", "throw", "true", "try", "typeof", "uint", "ulong", "unchecked", "unmanaged",
  "unsafe", "ushort", "using", "value", "var", "virtual", "void", "volatile", "when",
  "where", "while", "with", "yield",
]);

/**
 * Keywords that are legal as a return or property type. A method regex that
 * accepts `public` as a return type turns every constructor into a method
 * named after the class, so the type slot is checked against this list.
 */
const CS_BUILTIN_TYPES = new Set([
  "bool", "byte", "char", "decimal", "double", "dynamic", "float", "int", "long", "nint",
  "nuint", "object", "sbyte", "short", "string", "uint", "ulong", "ushort", "void",
]);

/**
 * BCL and framework names that appear in nearly every file and are defined in
 * none of them. See the header for why a name that never forms an edge still
 * has to be filtered. The list is deliberately short: it holds the names a
 * question is likely to contain as an ordinary English word, plus the
 * namespace segments every `using` block repeats.
 */
const CS_BCL_NOISE = new Set([
  "Action", "AspNetCore", "Collections", "Console", "DateTime", "DateTimeOffset",
  "DependencyInjection", "Dictionary", "Enumerable", "EntityFrameworkCore", "Exception",
  "Extensions", "Func", "Generic", "Guid", "Hosting", "Http", "IEnumerable", "ILogger",
  "IList", "Json", "Linq", "List", "Logging", "Math", "Microsoft", "Mvc", "Nullable",
  "String", "System", "Task", "Tasks", "Text", "Threading", "TimeSpan", "ValueTask",
]);

/** Member modifiers, in any order and any number. */
const MODS = "(?:(?:public|private|protected|internal|static|abstract|sealed|partial|virtual|override|async|unsafe|extern|new|readonly|ref|required|volatile|file)\\s+)*";
/** Constructor modifiers. `new` is left out: `new Order(1)` on its own line is a call. */
const CTOR_MODS = "(?:(?:public|private|protected|internal|static|extern|unsafe)\\s+)+";
/**
 * A type expression: `Task<List<Order?>>`, `int[]`, `Order?`, `IFoo.Bar` (explicit impl).
 * The generic span stops at `=` and `;` as well as at a paren. On
 * `DbSet<Order> Orders => Set<Order>();` nothing but `=>` separates the
 * member's `<` from the body's, and a span that crossed it made the property a
 * method named after the body's call.
 */
const TYPE = "([A-Za-z_][\\w.]*(?:<[^()=;]*>)?(?:\\[\\])*\\??)";
const NAME = "([A-Za-z_]\\w*)";
/** An optionally qualified member name, capturing only the last segment. */
const QUALIFIED_NAME = "(?:[A-Za-z_]\\w*\\.)*([A-Za-z_]\\w*)";

type DefKind = "type" | "member";

interface DefPattern {
  regex: RegExp;
  /** Which capture group holds the symbol name. */
  nameGroup: number;
  /** Which capture group holds a return/property type to validate, if any. */
  typeGroup?: number;
  /** Types can sit at any depth; members only directly inside a type body. */
  kind: DefKind;
}

/**
 * Definition patterns, tried in order, first match wins. Type declarations go
 * first so `public class Order {` is a class and not a property named Order
 * with the type `class`.
 */
const CS_DEF_PATTERNS: DefPattern[] = [
  { regex: /^\s*namespace\s+([A-Za-z_][\w.]*)/, nameGroup: 1, kind: "type" },
  {
    regex: new RegExp(`^\\s*${MODS}(?:class|interface|struct|enum|record(?:\\s+(?:class|struct))?)\\s+${NAME}`),
    nameGroup: 1,
    kind: "type",
  },
  { regex: new RegExp(`^\\s*${MODS}delegate\\s+${TYPE}\\s+${NAME}\\s*(?:<[^>]*>)?\\s*\\(`), nameGroup: 2, typeGroup: 1, kind: "member" },
  { regex: new RegExp(`^\\s*${MODS}event\\s+${TYPE}\\s+${NAME}\\s*[;={]`), nameGroup: 2, typeGroup: 1, kind: "member" },
  { regex: new RegExp(`^\\s*${CTOR_MODS}${NAME}\\s*\\(`), nameGroup: 1, kind: "member" },
  { regex: new RegExp(`^\\s*${MODS}${TYPE}\\s+${QUALIFIED_NAME}\\s*(?:<[^>]*>)?\\s*\\(`), nameGroup: 2, typeGroup: 1, kind: "member" },
  // A property line may end after the name: Allman style puts the accessor
  // block's `{` on the next line, and at member depth nothing else is `Type Name`.
  { regex: new RegExp(`^\\s*${MODS}${TYPE}\\s+${QUALIFIED_NAME}\\s*(?:\\{|=>|$)`), nameGroup: 2, typeGroup: 1, kind: "member" },
];

const CS_IDENTIFIER = /\b([A-Za-z_]\w{2,})\b/g;
/** `using Acme.Orders.Services;` names a namespace, which is a def elsewhere. */
const CS_USING = /^\s*(?:global\s+)?using\s+(?:static\s+)?([A-Za-z_][\w.]+)\s*;/;
/** An attribute list opens with `[`, optionally targeted (`[return: NotNull]`). */
const CS_ATTRIBUTE_OPEN = /\[\s*(?:(?:assembly|module|return|field|method|param|property|type|event)\s*:\s*)?([A-Z]\w*)/g;
/**
 * Attribute lists in front of a member on the same line. `[Key] public int Id`
 * is the usual style in entity and DTO files, which are the files whose
 * property names the map keeps, and every member pattern is anchored at the
 * modifiers, so the lists are stripped before a pattern runs. String arguments
 * are already masked, so a `]` in a route template cannot end a list early.
 */
const CS_LEADING_ATTRIBUTES = /^\s*(?:\[[^\]]*\]\s*)+/;
/**
 * A top-level statement that shapes the host: `builder.Services.AddX(...)`,
 * `app.UseX(...)`, `app.MapX(...)`. A minimal-hosting Program.cs is nothing
 * but these. With no type or member on any line it had no defs, and render
 * keeps only files with defs, so the one file a review of an ASP.NET Core API
 * starts from was dropped: the auth scheme, the middleware order, the CORS
 * policy and every endpoint. Each such line is a def named by the method, so a
 * question that says "authorization" seeds the file and the map shows the
 * line. Only outside any type body: the same calls inside a classic
 * Startup.ConfigureServices already sit under a method def.
 */
const CS_TOP_LEVEL_CALL = /^\s*(?:app|builder(?:\.Services)?|services)\.((?:Map|Use|Add|Configure)\w*)\b/;

/**
 * Blank out comments, string and char literals, and preprocessor lines,
 * keeping every line break so line numbers survive.
 *
 * A masked character becomes a space rather than being removed, so nothing
 * downstream has to map columns. The masking is what lets a class name in an
 * XML doc comment, or in a log message, stay out of the map.
 */
export function maskCSharp(source: string): string {
  const out: string[] = [];
  const n = source.length;
  let i = 0;
  let atLineStart = true;

  const blank = (from: number, to: number): void => {
    for (let k = from; k < to; k += 1) {
      const c = source[k]!;
      out.push(c === "\n" || c === "\r" ? c : " ");
    }
  };

  while (i < n) {
    const c = source[i]!;
    const next = source[i + 1];

    if (c === "\n") {
      out.push(c);
      i += 1;
      atLineStart = true;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") {
      out.push(c);
      i += 1;
      continue;
    }

    // A directive owns its whole line. `#region Order handling` would
    // otherwise contribute three refs that mean nothing.
    if (c === "#" && atLineStart) {
      const end = indexOfOr(source, "\n", i);
      blank(i, end);
      i = end;
      continue;
    }
    atLineStart = false;

    if (c === "/" && next === "/") {
      const end = indexOfOr(source, "\n", i);
      blank(i, end);
      i = end;
      continue;
    }
    if (c === "/" && next === "*") {
      const close = source.indexOf("*/", i + 2);
      const end = close === -1 ? n : close + 2;
      blank(i, end);
      i = end;
      continue;
    }

    // Raw string literal: three or more quotes, closed by the same count, with
    // any number of `$` in front for interpolation. The prefix is checked here,
    // before the regular-string branch, because `$"""` begins with `$"` and
    // that branch would take it: `$""` masked as an empty string, the third
    // quote opening a literal that ran to the end of the line, and the closing
    // `"""` then read as an opener that blanked the rest of the file.
    let dollars = 0;
    while (source[i + dollars] === "$") dollars += 1;
    const rawAt = i + dollars;
    if (source[rawAt] === '"' && source[rawAt + 1] === '"' && source[rawAt + 2] === '"') {
      let quotes = 0;
      while (source[rawAt + quotes] === '"') quotes += 1;
      const closer = '"'.repeat(quotes);
      const close = source.indexOf(closer, rawAt + quotes);
      const end = close === -1 ? n : close + quotes;
      blank(i, end);
      i = end;
      continue;
    }

    // Verbatim string, with or without interpolation: `@"..."`, `$@"..."`, `@$"..."`.
    // Only `""` escapes a quote; a backslash is literal.
    const verbatim =
      (c === "@" && next === '"') ||
      (c === "$" && next === "@" && source[i + 2] === '"') ||
      (c === "@" && next === "$" && source[i + 2] === '"');
    if (verbatim) {
      let k = source.indexOf('"', i) + 1;
      while (k < n) {
        if (source[k] === '"') {
          if (source[k + 1] === '"') {
            k += 2;
            continue;
          }
          k += 1;
          break;
        }
        k += 1;
      }
      blank(i, k);
      i = k;
      continue;
    }

    // Regular or interpolated string. Interpolation holes are masked with the
    // rest of the literal: what they reference is rarely a symbol worth an edge.
    if (c === '"' || (c === "$" && next === '"')) {
      let k = source.indexOf('"', i) + 1;
      while (k < n && source[k] !== '"' && source[k] !== "\n") {
        k += source[k] === "\\" ? 2 : 1;
      }
      const end = Math.min(n, k + 1);
      blank(i, end);
      i = end;
      continue;
    }

    // Char literal. Bounded, so a stray apostrophe cannot eat the file.
    if (c === "'") {
      let k = i + 1;
      if (source[k] === "\\") k += 2;
      else k += 1;
      // Unicode escapes run longer than one character; scan to the closing quote.
      while (k < n && k - i < 12 && source[k] !== "'" && source[k] !== "\n") k += 1;
      if (source[k] === "'") {
        blank(i, k + 1);
        i = k + 1;
        continue;
      }
      out.push(c);
      i += 1;
      continue;
    }

    out.push(c);
    i += 1;
  }
  return out.join("");
}

function indexOfOr(source: string, needle: string, from: number): number {
  const at = source.indexOf(needle, from);
  return at === -1 ? source.length : at;
}

/**
 * Attribute names in a line, plus each with the `Attribute` suffix.
 *
 * `[Authorize]` refers to `AuthorizeAttribute`; a subject that defines
 * `RequireTenantAttribute` and decorates controllers with `[RequireTenant]`
 * only links the two if the suffixed form is a ref. The bare name is emitted
 * as well because the plain identifier scan already sees it, and both are
 * cheap.
 */
function attributeNames(maskedLine: string): string[] {
  const names: string[] = [];
  for (const open of maskedLine.matchAll(CS_ATTRIBUTE_OPEN)) {
    let at = (open.index ?? 0) + open[0].length;
    names.push(open[1]!);
    // `[Authorize(Roles = Admin), ApiController]`: skip the argument list,
    // then keep reading names across commas until the list closes.
    for (;;) {
      at = skipParens(maskedLine, skipSpaces(maskedLine, at));
      at = skipSpaces(maskedLine, at);
      if (maskedLine[at] !== ",") break;
      at = skipSpaces(maskedLine, at + 1);
      const m = /^[A-Z]\w*/.exec(maskedLine.slice(at));
      if (!m) break;
      names.push(m[0]);
      at += m[0].length;
    }
  }
  return names;
}

function skipSpaces(line: string, at: number): number {
  let k = at;
  while (line[k] === " " || line[k] === "\t") k += 1;
  return k;
}

function skipParens(line: string, at: number): number {
  if (line[at] !== "(") return at;
  let depth = 0;
  let k = at;
  while (k < line.length) {
    if (line[k] === "(") depth += 1;
    else if (line[k] === ")") {
      depth -= 1;
      if (depth === 0) return k + 1;
    }
    k += 1;
  }
  return k;
}

/** The type body a line sits in: the depth its declaration was seen at, and whether its `{` has been passed. */
interface TypeFrame {
  depth: number;
  opened: boolean;
}

/**
 * Extract def/ref tags from one C# file.
 *
 * Line numbers count `\n` only, so a CRLF file cites the same lines an editor
 * shows. A leading BOM is dropped: Visual Studio writes one by default, and a
 * regex anchored at `^` would otherwise miss the first line of every file.
 */
export function extractCSharpTags(path: string, source: string): Tag[] {
  const text = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  const rawLines = text.split("\n").map((line) => line.replace(/\r$/, ""));
  const maskedLines = maskCSharp(text)
    .split("\n")
    .map((line) => line.replace(/\r$/, ""));

  const tags: Tag[] = [];
  const frames: TypeFrame[] = [];
  let depth = 0;

  maskedLines.forEach((masked, i) => {
    const depthAtStart = depth;
    const def = matchDef(masked);
    if (def) {
      // A brace-less declaration (`record Order(int Id);`) never opens, and
      // must not shadow the type that encloses the next member at this depth.
      while (frames.length > 0 && !frames[frames.length - 1]!.opened && depthAtStart <= frames[frames.length - 1]!.depth) {
        frames.pop();
      }
      const top = frames[frames.length - 1];
      const isMemberDepth = top === undefined || depthAtStart === top.depth + 1;
      if (def.kind === "type" || isMemberDepth) {
        tags.push({
          path,
          name: def.name,
          kind: "def",
          line: i + 1,
          signature: rawLines[i]!.trim().slice(0, 200),
        });
      }
      if (def.kind === "type" && def.isBody) frames.push({ depth: depthAtStart, opened: false });
    } else if (frames.length === 0 && depthAtStart === 0) {
      const call = CS_TOP_LEVEL_CALL.exec(masked);
      if (call) {
        tags.push({
          path,
          name: call[1]!,
          kind: "def",
          line: i + 1,
          signature: rawLines[i]!.trim().slice(0, 200),
        });
      }
    }

    for (const ch of masked) {
      if (ch === "{") depth += 1;
      else if (ch === "}") depth -= 1;
    }
    let top = frames[frames.length - 1];
    while (top !== undefined) {
      if (!top.opened && depth > top.depth) top.opened = true;
      if (top.opened && depth <= top.depth) {
        frames.pop();
        top = frames[frames.length - 1];
        continue;
      }
      break;
    }
  });

  maskedLines.forEach((masked, i) => {
    const push = (name: string) => tags.push({ path, name, kind: "ref", line: i + 1, signature: "" });
    // The noise filter applies to the namespace root as well: `using System;`
    // sits at the top of every file, and a question that says "system" must
    // not seed all of them.
    const using = CS_USING.exec(masked);
    if (using && !CS_BCL_NOISE.has(using[1]!.split(".", 1)[0]!)) push(using[1]!);
    for (const m of masked.matchAll(CS_IDENTIFIER)) {
      const name = m[1]!;
      if (CS_KEYWORDS.has(name) || CS_BCL_NOISE.has(name)) continue;
      push(name);
    }
    for (const name of attributeNames(masked)) push(`${name}Attribute`);
  });

  return tags;
}

interface MatchedDef {
  name: string;
  kind: DefKind;
  /** A type declaration that will have (or has) a brace body, as opposed to a namespace. */
  isBody: boolean;
}

function matchDef(masked: string): MatchedDef | undefined {
  const line = masked.replace(CS_LEADING_ATTRIBUTES, "");
  for (const pattern of CS_DEF_PATTERNS) {
    const m = pattern.regex.exec(line);
    if (!m) continue;
    const name = m[pattern.nameGroup]!;
    if (CS_KEYWORDS.has(name)) return undefined;
    if (pattern.typeGroup !== undefined) {
      const type = m[pattern.typeGroup]!;
      const head = type.split(/[<.[?]/, 1)[0]!;
      if (CS_KEYWORDS.has(head) && !CS_BUILTIN_TYPES.has(head)) return undefined;
    }
    // A namespace is not a body for depth purposes: block-scoped `namespace X {`
    // holds types, not members, and file-scoped `namespace X;` holds nothing.
    const isBody = pattern.kind === "type" && !/^\s*namespace\b/.test(line);
    return { name, kind: pattern.kind, isBody };
  }
  return undefined;
}
