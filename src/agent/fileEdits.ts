/**
 * Targeted find/replace edits, so the model can change a few lines of a large file without
 * re-sending the whole file through the chat (whole-file writes of big files blow past web-chat
 * message limits and are easy to truncate).
 *
 * Text outside a match is never rewritten — line endings, indentation and encoding of untouched
 * lines survive exactly, which keeps diffs (and the undo hash) limited to the real change.
 *
 * Pure (no vscode import) so it is unit-testable.
 */

export interface TextEdit {
  /** Exact text to find (include enough surrounding lines to make it unique). */
  readonly find: string;
  /** Replacement text. */
  readonly replace: string;
  /** Replace every occurrence instead of requiring exactly one. */
  readonly all?: boolean;
}

export type TextEditResult =
  | { readonly ok: true; readonly content: string; readonly replacements: number }
  | { readonly ok: false; readonly error: string };

const PREVIEW_CHARS = 120;

/**
 * Apply edits in order. Either every edit applies or none does (the caller writes nothing on
 * error). A `find` matches regardless of whether the file uses LF or CRLF, and the replacement is
 * written with the file's dominant line ending. If an exact match fails, a match that ignores
 * trailing whitespace on each line is tried, because chat UIs commonly strip or add trailing spaces
 * when rendering code.
 */
export function applyTextEdits(original: string, edits: readonly TextEdit[]): TextEditResult {
  if (edits.length === 0) {
    return { ok: false, error: "No edits given." };
  }

  const eol = dominantEol(original);
  let text = original;
  let replacements = 0;

  for (const [index, edit] of edits.entries()) {
    const label = `edit ${index + 1}`;
    const find = toLf(edit.find);
    const replace = toLf(edit.replace).replace(/\n/g, eol);

    if (find.length === 0) {
      return { ok: false, error: `${label}: "find" is empty. Use a write action to create or replace a whole file.` };
    }

    for (const loose of [false, true]) {
      const pattern = buildPattern(find, loose);
      const matches = [...text.matchAll(pattern)];

      if (matches.length === 0) {
        if (loose) {
          return {
            ok: false,
            error: `${label}: "find" text was not found in the current file (it may have changed — read_file it again). find=${preview(find)}`
          };
        }
        continue; // try the whitespace-tolerant pass
      }
      if (matches.length > 1 && !edit.all) {
        return {
          ok: false,
          error: `${label}: "find" matches ${matches.length} places. Include more surrounding lines so it is unique, or set "all": true. find=${preview(find)}`
        };
      }

      // Replace from the end so earlier offsets stay valid.
      const applied = edit.all ? matches : matches.slice(0, 1);
      for (const match of [...applied].reverse()) {
        const at = match.index ?? 0;
        text = text.slice(0, at) + replace + text.slice(at + match[0].length);
      }
      replacements += applied.length;
      break;
    }
  }

  return { ok: true, content: text, replacements };
}

function toLf(value: string): string {
  return value.replace(/\r\n/g, "\n");
}

/** The line ending to write replacements with: CRLF only when the file mostly uses it. */
function dominantEol(text: string): string {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  if (crlf === 0) {
    return "\n";
  }
  const total = (text.match(/\n/g) ?? []).length; // includes the CRLF ones
  return crlf * 2 >= total ? "\r\n" : "\n";
}

/**
 * A matcher for `find` that accepts either line ending. In loose mode each line is compared with
 * trailing whitespace ignored (on both sides).
 */
function buildPattern(find: string, loose: boolean): RegExp {
  const lines = find.split("\n");
  const source = lines
    .map((line) => (loose ? `${escapeRegExp(line.trimEnd())}[ \\t]*` : escapeRegExp(line)))
    .join("\\r?\\n");
  return new RegExp(source, "g");
}

function preview(value: string): string {
  return JSON.stringify(value.length > PREVIEW_CHARS ? `${value.slice(0, PREVIEW_CHARS)}…` : value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
