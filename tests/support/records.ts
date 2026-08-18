/**
 * Reading a written record the way a check has to read one.
 *
 * Two gates hold a document to its content rather than to its wording — the migration
 * acknowledgements of `tests/migrations-are-safe-against-populated-tables.test.ts` (#161) and
 * the list of what the first publish owes in `tests/publish-guard.test.ts` (ADR-0061) — and
 * both ask the same question: does the section headed *this* name *that* file? One answer to
 * "what is a section" rather than two, because two would drift the day one of them learned
 * about `setext` headings or fenced code and the other did not.
 *
 * **It reads `#` at the start of a line and nothing else**, so a fenced code block containing
 * one would end a section early — no record either gate reads has one, and the fix if that ever
 * changes is here rather than in two places, which is the whole reason this module exists.
 */

/**
 * One section of a Markdown record, from its heading to the next one at the same level or above
 * — or `null` if the record has no such heading. Nested subsections are part of it, which is
 * what makes a section the unit rather than a paragraph.
 */
export function sectionOf(record: string, heading: string): string | null {
  const lines = record.split("\n");
  const depth = (line: string) =>
    /^#{1,6} /.test(line) ? (line.match(/^#+/)?.[0].length ?? 0) : 0;

  const opens = lines.findIndex(
    (line) => depth(line) > 0 && line.replace(/^#+\s*/, "").trim() === heading,
  );
  if (opens === -1) return null;

  const body = lines.slice(opens + 1);
  const closes = body.findIndex((line) => {
    const level = depth(line);
    return level > 0 && level <= depth(lines[opens] ?? "");
  });

  return (closes === -1 ? body : body.slice(0, closes)).join("\n");
}
