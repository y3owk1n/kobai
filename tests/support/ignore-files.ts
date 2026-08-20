/**
 * Reading an ignore file the way a check has to read one.
 *
 * Two gates hold a mechanism to what `.gitignore` says, because ADR-0068 makes that file the
 * one statement of what a checkout generates: the `.dockerignore` anchoring rule of
 * `tests/nothing-git-ignores-reaches-the-build-context.test.ts` (#203), and the template
 * walk's skip list in `tests/the-template-walk-is-held-to-what-git-ignores.test.ts` (#279).
 * Both start from the same question — what does this file actually name, and where — so there
 * is one answer to it rather than two, for the same reason `tests/support/records.ts` is one
 * answer to what a Markdown section is. Two would drift the day one of them learned about a
 * shape the other did not, and the copy that drifted would go on passing.
 *
 * **This is deliberately not a `.gitignore` engine.** It answers what a pattern *names* and at
 * what depths, which is all either gate asks of it. Character classes, a `**` in the middle of
 * a pattern, and the ordering rules that let a later negation win are none of its business, and
 * no ignore file in this repository has one — the day one does, that is a change here rather
 * than in two places, which is the whole reason this module exists.
 */

/** Patterns, with comments and blank lines dropped. Neither file format has any other syntax. */
export function patternsIn(contents: string): string[] {
  return contents
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

/**
 * Whether a pattern **un**-ignores rather than ignores.
 *
 * One question with one answer, because every caller here asks it and `subject` strips the
 * marker: a reader that judged `!.env.example` as a claim that something is generated would
 * have the file exactly backwards. Neither gate resolves ordering — a later negation winning
 * over an earlier pattern is a `.gitignore` engine's business, not a reader's — so a negation
 * is dropped rather than applied, and no ignore file in this repository has one that would
 * make the difference.
 */
export function negates(pattern: string): boolean {
  return pattern.startsWith("!");
}

/** What a pattern names, with its negation and its `**` and directory markers taken off. */
export function subject(pattern: string): string {
  return pattern
    .replace(/^!/, "")
    .replace(/^\*\*\//, "")
    .replace(/\/$/, "");
}

/**
 * Whether a `.gitignore` pattern matches at any depth, which is **not** all of them.
 *
 * A pattern holding a slash anywhere but at its end is anchored to the directory its ignore
 * file sits in — `.claude/worktrees/` matches the repository root's and nothing below it.
 * Demanding `**\/` in front of a `.dockerignore` twin of one of those would be demanding the
 * wrong thing, and so would demanding that the template walk skip it. Every other entry in
 * both ignore files is slashless and so matches everywhere, which is the case both gates
 * exist for.
 */
export function gitignoreMatchesAtEveryDepth(pattern: string): boolean {
  return !pattern.replace(/^!/, "").replace(/\/$/, "").includes("/");
}

/**
 * Whether a `.gitignore` pattern can only ever name a directory, which its trailing slash is
 * how git says so.
 *
 * The rest cannot be judged as directories at all, and that is a property of the format rather
 * than a gap here: `.DS_Store`, `Thumbs.db`, `*.swp` and `.env` name a file or a directory
 * indifferently, and nothing in the file says which was meant.
 */
export function namesADirectory(pattern: string): boolean {
  return pattern.replace(/^!/, "").endsWith("/");
}
