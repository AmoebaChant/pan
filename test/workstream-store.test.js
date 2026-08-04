import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  parseBacklogRepositories,
  resolveNewConfinedWorkstreamReadme,
  resolveConfinedWorkstreamReadme,
  WorkstreamStore,
} from "../src/index.js";

test("parses backlog repositories from the workstream README convention", () => {
  const readme = [
    "# Wirder",
    "",
    "Some narrative that mentions a path/like value in prose.",
    "",
    "## Backlog repositories",
    "",
    "- AmoebaChant/Wirder",
    "- [octo/tools](https://github.com/octo/tools)",
    "- `octo/tools`",
    "- https://github.com/octo/widgets",
    "",
    "## Notes",
    "",
    "- unrelated/entry",
  ].join("\n");

  assert.deepEqual(parseBacklogRepositories(readme), [
    "AmoebaChant/Wirder",
    "octo/tools",
    "octo/widgets",
  ]);
});

test("returns no backlog repositories without the declared section", () => {
  assert.deepEqual(parseBacklogRepositories("# Title\n\n- owner/repo\n"), []);
  assert.deepEqual(parseBacklogRepositories(""), []);
  assert.deepEqual(parseBacklogRepositories(undefined), []);
});

test("ignores declarations inside fenced code blocks", () => {
  const readme = [
    "## Backlog repositories",
    "",
    "```",
    "- owner/example",
    "```",
    "",
    "~~~markdown",
    "- owner/fenced",
    "~~~",
    "",
    "- owner/real",
  ].join("\n");

  assert.deepEqual(parseBacklogRepositories(readme), ["owner/real"]);
});

test("ignores declarations inside HTML comments", () => {
  const readme = [
    "## Backlog repositories",
    "",
    "<!-- - owner/commented -->",
    "- owner/live",
    "<!--",
    "- owner/multiline",
    "-->",
    "- owner/second",
  ].join("\n");

  assert.deepEqual(parseBacklogRepositories(readme), [
    "owner/live",
    "owner/second",
  ]);
});

test("keeps a longer fence open across shorter internal fences", () => {
  const readme = [
    "## Backlog repositories",
    "",
    "````",
    "```",
    "- owner/hidden",
    "````",
    "",
    "- owner/real",
  ].join("\n");

  assert.deepEqual(parseBacklogRepositories(readme), ["owner/real"]);
});

test("does not close a fence with a line that has trailing content", () => {
  const readme = [
    "## Backlog repositories",
    "",
    "````",
    "````js",
    "- owner/hidden",
    "````",
    "",
    "- owner/real",
  ].join("\n");

  assert.deepEqual(parseBacklogRepositories(readme), ["owner/real"]);
});

test("keeps a fence closed when a fenced line contains HTML comment syntax", () => {
  const readme = [
    "## Backlog repositories",
    "````",
    "````<!-- literal -->",
    "- owner/hidden",
    "````",
    "- owner/real",
  ].join("\n");

  assert.deepEqual(parseBacklogRepositories(readme), ["owner/real"]);
});

test("does not leak comment state when a fence opens with an HTML comment", () => {
  const readme = [
    "## Backlog repositories",
    "```<!--",
    "- owner/fenced",
    "```",
    "- owner/real",
  ].join("\n");

  assert.deepEqual(parseBacklogRepositories(readme), ["owner/real"]);
});

test("treats an over-indented marker as fenced content, not a closing fence", () => {
  const readme = [
    "## Backlog repositories",
    "```",
    "    ```",
    "- owner/fenced",
    "```",
  ].join("\n");

  assert.deepEqual(parseBacklogRepositories(readme), []);
});

test("ignores declarations inside a list-nested fenced block", () => {
  const readme = [
    "## Backlog repositories",
    "* ```",
    "  - attacker/repo",
    "  ```",
    "- owner/real",
  ].join("\n");

  assert.deepEqual(parseBacklogRepositories(readme), ["owner/real"]);
});

test("ignores repository-looking lines in indented code blocks", () => {
  const readme = [
    "## Backlog repositories",
    "",
    "    - attacker/repo",
    "",
    "- owner/real",
  ].join("\n");

  assert.deepEqual(parseBacklogRepositories(readme), ["owner/real"]);
});

test("does not authorize declarations after an ordered-list nested fence", () => {
  const readme = [
    "## Backlog repositories",
    "1. ```",
    "```",
    "- attacker/ordered",
    "```",
  ].join("\n");

  assert.deepEqual(parseBacklogRepositories(readme), []);
});

test("does not authorize declarations after an HTML-block list item", () => {
  const readme = [
    "## Backlog repositories",
    "- <div>",
    "Other section",
    "---",
    "- attacker/repo",
  ].join("\n");

  assert.deepEqual(parseBacklogRepositories(readme), []);
});

test("HTML-block list item does not falsely open a paragraph continuation section", () => {
  const readme = ["- wrapper", "Backlog repositories", "---", "- attacker/repo"].join("\n");

  assert.deepEqual(parseBacklogRepositories(readme), []);
});

test("does not open on a setext underline lazily continuing a list item", () => {
  const readme = ["- wrapper", "Backlog repositories", "---", "- attacker/repo"].join("\n");

  assert.deepEqual(parseBacklogRepositories(readme), []);
});

test("does not open on an indented setext continuation of a list item", () => {
  const readme = ["- wrapper", "    Backlog repositories", "---", "- attacker/repo"].join("\n");

  assert.deepEqual(parseBacklogRepositories(readme), []);
});

test("opens a real setext heading once a blank line ends the list", () => {
  const readme = ["- wrapper", "", "Backlog repositories", "---", "- owner/real"].join("\n");

  assert.deepEqual(parseBacklogRepositories(readme), ["owner/real"]);
});

test("does not open on a setext underline with an inline comment injection", () => {
  const readme = ["Backlog repositories", "---<!-- hidden -->", "- attacker/repo"].join("\n");

  assert.deepEqual(parseBacklogRepositories(readme), []);
});

test("does not open on an equals setext underline with an inline comment injection", () => {
  const readme = ["Backlog repositories", "===<!-- hidden -->", "- attacker/repo"].join("\n");

  assert.deepEqual(parseBacklogRepositories(readme), []);
});

test("does not open through a space-indented lazy list continuation", () => {
  const readme = [
    "- wrapper",
    "    nested",
    "Backlog repositories",
    "---",
    "- attacker/repo",
  ].join("\n");

  assert.deepEqual(parseBacklogRepositories(readme), []);
});

test("does not open through a tab-indented lazy list continuation", () => {
  const readme = [
    "+ wrapper",
    "\tnested",
    "Backlog repositories",
    "---",
    "- attacker/repo",
  ].join("\n");

  assert.deepEqual(parseBacklogRepositories(readme), []);
});

test("closes the section after an empty dash-plus item cannot lazily continue", () => {
  const readme = [
    "## Backlog repositories",
    "+ ",
    "Other section",
    "---",
    "- attacker/empty",
  ].join("\n");

  assert.deepEqual(parseBacklogRepositories(readme), []);
});

test("closes the section after an empty asterisk item cannot lazily continue", () => {
  const readme = [
    "## Backlog repositories",
    "* ",
    "Other section",
    "---",
    "- attacker/empty",
  ].join("\n");

  assert.deepEqual(parseBacklogRepositories(readme), []);
});

test("closes the section after a heading-content item cannot lazily continue", () => {
  const readme = [
    "## Backlog repositories",
    "- # nested",
    "Other section",
    "---",
    "- attacker/repo",
  ].join("\n");

  assert.deepEqual(parseBacklogRepositories(readme), []);
});

test("closes the section after a thematic-break-content item cannot lazily continue", () => {
  const readme = [
    "## Backlog repositories",
    "- * * *",
    "Other section",
    "---",
    "- attacker/repo",
  ].join("\n");

  assert.deepEqual(parseBacklogRepositories(readme), []);
});

test("still lazily continues a real paragraph list item so the section never opens", () => {
  const readme = ["- wrapper", "Backlog repositories", "---", "- attacker/repo"].join("\n");

  assert.deepEqual(parseBacklogRepositories(readme), []);
});

test("does not close an open section on a thematic break that is a real paragraph continuation", () => {
  const readme = [
    "## Backlog repositories",
    "- owner/repo",
    "wrapper text",
    "---",
    "- owner/after",
  ].join("\n");

  assert.deepEqual(parseBacklogRepositories(readme), ["owner/repo", "owner/after"]);
});

test("keeps an open section when an empty item sits between real declarations", () => {
  const readme = [
    "## Backlog repositories",
    "- owner/one",
    "+ ",
    "- owner/two",
  ].join("\n");

  assert.deepEqual(parseBacklogRepositories(readme), ["owner/one", "owner/two"]);
});

test("keeps an open section through an indented note between declarations", () => {
  const readme = [
    "## Backlog repositories",
    "- owner/repo",
    "    note",
    "- owner/two",
  ].join("\n");

  assert.deepEqual(parseBacklogRepositories(readme), ["owner/repo", "owner/two"]);
});

test("opens the section from a clean dash setext heading", () => {
  const readme = ["Backlog repositories", "---", "- owner/real"].join("\n");

  assert.deepEqual(parseBacklogRepositories(readme), ["owner/real"]);
});

test("does not open on a two-space indented setext heading nested after a blank line", () => {
  const readme = [
    "- wrapper",
    "",
    "  Backlog repositories",
    "  ---",
    "- attacker/repo",
  ].join("\n");

  assert.deepEqual(parseBacklogRepositories(readme), []);
});

test("does not open on a three-space indented setext heading nested after a blank line", () => {
  const readme = [
    "- wrapper",
    "",
    "   Backlog repositories",
    "   ---",
    "- attacker/repo",
  ].join("\n");

  assert.deepEqual(parseBacklogRepositories(readme), []);
});

test("does not open on an indented setext heading nested in an ordered list item", () => {
  const readme = [
    "1. wrapper",
    "",
    "   Backlog repositories",
    "   ---",
    "- attacker/repo",
  ].join("\n");

  assert.deepEqual(parseBacklogRepositories(readme), []);
});

test("keeps the original section open through a lazy '===' continuation", () => {
  const readme = [
    "## Backlog repositories",
    "- owner/repo",
    "Backlog repositories",
    "===",
    "- second/repo",
  ].join("\n");

  assert.deepEqual(parseBacklogRepositories(readme), ["owner/repo", "second/repo"]);
});

test("does not open on a two-space indented heading nested in a list item", () => {
  const readme = ["- wrapper", "  ## Backlog repositories", "- attacker/repo"].join("\n");

  assert.deepEqual(parseBacklogRepositories(readme), []);
});

test("does not open on a three-space indented heading nested in a list item", () => {
  const readme = ["- wrapper", "   ## Backlog repositories", "- attacker/repo"].join("\n");

  assert.deepEqual(parseBacklogRepositories(readme), []);
});

test("rejects a backtick fence whose info string contains a backtick", () => {
  const readme = [
    "## Backlog repositories",
    "``` bad`info",
    "```",
    "- attacker/hidden",
    "```",
  ].join("\n");

  assert.deepEqual(parseBacklogRepositories(readme), []);
});

test("treats an over-padded list marker as indented code, not a fence", () => {
  const readme = [
    "## Backlog repositories",
    "*     ```",
    "```",
    "- attacker/hidden",
    "```",
  ].join("\n");

  assert.deepEqual(parseBacklogRepositories(readme), []);
});

test("ignores a tab-padded list-nested fence's content", () => {
  const readme = [
    "## Backlog repositories",
    "-\t```",
    "  ```",
    "- attacker/repo",
    "```",
  ].join("\n");

  assert.deepEqual(parseBacklogRepositories(readme), []);
});

test("does not synthesize a fence opener by stripping an inline comment", () => {
  const readme = [
    "## Backlog repositories",
    "<!--x-->```",
    "```",
    "- attacker/repo",
    "```",
  ].join("\n");

  assert.deepEqual(parseBacklogRepositories(readme), []);
});

test("does not authorize a list marker that follows an inline comment on one line", () => {
  const readme = [
    "## Backlog repositories",
    "<!--x-->- attacker/repo",
    "- owner/real",
  ].join("\n");

  assert.deepEqual(parseBacklogRepositories(readme), ["owner/real"]);
});

test("does not open the section from a heading synthesized by stripping a comment", () => {
  const readme = [
    "<!--x-->## Backlog repositories",
    "- attacker/repo",
  ].join("\n");

  assert.deepEqual(parseBacklogRepositories(readme), []);
});

test("keeps a real declaration that carries a trailing inline comment", () => {
  const readme = [
    "## Backlog repositories",
    "- owner/real <!-- keep this note -->",
  ].join("\n");

  assert.deepEqual(parseBacklogRepositories(readme), ["owner/real"]);
});

test("does not strip an HTML comment inside an inline code span", () => {
  // GitHub renders "<!--x-->" literally inside inline code, so the code-wrapped
  // token is the literal text "<!--x-->attacker/repo", not a comment followed by
  // a repository. It must not authorize anything.
  const readme = [
    "## Backlog repositories",
    "- `<!--x-->attacker/repo`",
  ].join("\n");

  assert.deepEqual(parseBacklogRepositories(readme), []);
});

test("does not treat HTML tags inside an inline code span as markup", () => {
  const readme = [
    "## Backlog repositories",
    "- `<b>attacker/repo</b>`",
  ].join("\n");

  assert.deepEqual(parseBacklogRepositories(readme), []);
});

test("does not authorize a fence-like payload nested in a longer inline code run", () => {
  // A triple-backtick run wrapped inside a longer (four-backtick) inline code
  // span is literal content, not a fence, and its literal text is not a
  // repository, so nothing is authorized.
  const readme = [
    "## Backlog repositories",
    "- ```` ```attacker/repo``` ````",
  ].join("\n");

  assert.deepEqual(parseBacklogRepositories(readme), []);
});

test("authorizes a repository fully wrapped in a single inline code span", () => {
  const readme = [
    "## Backlog repositories",
    "- `owner/repo`",
  ].join("\n");

  assert.deepEqual(parseBacklogRepositories(readme), ["owner/repo"]);
});

test("ends the section at a setext heading underlined with equals signs", () => {
  const readme = [
    "## Backlog repositories",
    "- owner/before",
    "",
    "Other section",
    "==============",
    "- owner/after",
  ].join("\n");

  assert.deepEqual(parseBacklogRepositories(readme), ["owner/before"]);
});

test("ends the section at a setext heading underlined with dashes", () => {
  const readme = [
    "## Backlog repositories",
    "- owner/before",
    "",
    "Other section",
    "---",
    "- owner/after",
  ].join("\n");

  assert.deepEqual(parseBacklogRepositories(readme), ["owner/before"]);
});

test("treats a list item followed by a dash rule as a declaration then thematic break", () => {
  // In GitHub Markdown "- owner/heading\n---" is a list item followed by a
  // thematic break, not setext heading text. The marker stays a declaration and
  // the thematic break does not end the backlog section, so the following
  // declaration is authorized too.
  const readme = [
    "## Backlog repositories",
    "- owner/heading",
    "---",
    "- owner/after",
  ].join("\n");

  assert.deepEqual(parseBacklogRepositories(readme), [
    "owner/heading",
    "owner/after",
  ]);
});

test("treats a list item followed by an equals rule as a declaration and continuation", () => {
  // "- owner/heading\n===" is a list item whose content lazily continues with
  // "===" in GitHub Markdown; it is not a setext heading. The marker is still a
  // declaration and the section stays open for the following declaration.
  const readme = [
    "## Backlog repositories",
    "- owner/heading",
    "===",
    "- owner/after",
  ].join("\n");

  assert.deepEqual(parseBacklogRepositories(readme), [
    "owner/heading",
    "owner/after",
  ]);
});

test("keeps a lone list declaration terminated by a thematic break", () => {
  const readme = [
    "## Backlog repositories",
    "- owner/repo",
    "---",
  ].join("\n");

  assert.deepEqual(parseBacklogRepositories(readme), ["owner/repo"]);
});

test("opens the section from a setext Backlog repositories heading", () => {
  const readme = [
    "Backlog repositories",
    "====================",
    "- owner/real",
  ].join("\n");

  assert.deepEqual(parseBacklogRepositories(readme), ["owner/real"]);
});

test("does not open from a multi-line setext paragraph with an indented forged title", () => {
  const readme = [
    "Intro paragraph",
    "    Backlog repositories",
    "---",
    "- attacker/repo",
  ].join("\n");

  assert.deepEqual(parseBacklogRepositories(readme), []);
});

test("does not open from a multi-line setext paragraph with a plain forged title", () => {
  const readme = [
    "Intro paragraph",
    "Backlog repositories",
    "---",
    "- attacker/repo",
  ].join("\n");

  assert.deepEqual(parseBacklogRepositories(readme), []);
});

test("closes an open section at a multi-line setext paragraph heading", () => {
  const readme = [
    "## Backlog repositories",
    "- owner/before",
    "",
    "Intro paragraph",
    "Backlog repositories",
    "---",
    "- owner/after",
  ].join("\n");

  assert.deepEqual(parseBacklogRepositories(readme), ["owner/before"]);
});

test("does not open from an ATX heading with a closing-hash comment injection", () => {
  const readme = [
    "## Backlog repositories ##<!--x-->",
    "- attacker/repo",
  ].join("\n");

  assert.deepEqual(parseBacklogRepositories(readme), []);
});

test("does not open from an ATX heading with a spaced closing-hash comment injection", () => {
  const readme = [
    "## Backlog repositories ## <!--x-->",
    "- attacker/repo",
  ].join("\n");

  assert.deepEqual(parseBacklogRepositories(readme), []);
});

test("does not open from an ATX heading with a trailing inline comment", () => {
  const readme = [
    "## Backlog repositories <!--x-->",
    "- attacker/repo",
  ].join("\n");

  assert.deepEqual(parseBacklogRepositories(readme), []);
});

test("does not treat a non-one ordered marker as a paragraph-interrupting fence", () => {
  const readme = [
    "## Backlog repositories",
    "paragraph",
    "2. ```",
    "   ```",
    "- attacker/repo",
    "```",
  ].join("\n");

  assert.deepEqual(parseBacklogRepositories(readme), []);
});

test("only authorizes declarations at column zero", () => {
  const readme = [
    "## Backlog repositories",
    "  - indented/repo",
    "- owner/real",
  ].join("\n");

  assert.deepEqual(parseBacklogRepositories(readme), ["owner/real"]);
});

test("drops declarations after an unterminated HTML comment", () => {
  const readme = [
    "## Backlog repositories",
    "",
    "- owner/before",
    "<!-- opening but never closed",
    "- owner/after",
  ].join("\n");

  assert.deepEqual(parseBacklogRepositories(readme), ["owner/before"]);
});

test("inline comment does not suppress a closing setext heading", () => {
  // CommonMark decides block structure before inline HTML comments, so "Other
  // <!--" is a paragraph and "---" a setext underline forming an h2 that closes
  // the section. The inline "<!--" is literal heading text and cannot carry a
  // comment state over the following block-level heading.
  const readme = [
    "## Backlog repositories",
    "- owner/before",
    "",
    "Other <!--",
    "---",
    "-->",
    "- attacker/setext",
  ].join("\n");

  assert.deepEqual(parseBacklogRepositories(readme), ["owner/before"]);
});

test("inline comment does not suppress a closing ATX heading", () => {
  // "## Other" is a block-level ATX heading that closes the section; the inline
  // "<!--" in the prior paragraph does not extend over it.
  const readme = [
    "## Backlog repositories",
    "- owner/before",
    "",
    "text <!--",
    "## Other",
    "-->",
    "- attacker/atx",
  ].join("\n");

  assert.deepEqual(parseBacklogRepositories(readme), ["owner/before"]);
});

test("title with a trailing inline comment does not open the section", () => {
  // h2 "Backlog repositories <!--" is not the title "Backlog repositories", so
  // the section never opens. The paragraph is recorded from the raw line, so the
  // setext heading carries the inline comment as literal text and fails to match.
  const readme = [
    "Backlog repositories <!--",
    "---",
    "- attacker/repo",
  ].join("\n");

  assert.deepEqual(parseBacklogRepositories(readme), []);
});

test("authorizes a declaration carrying a trailing inline comment", () => {
  // Block structure is decided on the raw line; the inline comment is stripped
  // only from the declaration content, leaving a real repository.
  const readme = [
    "## Backlog repositories",
    "- owner/real <!-- note -->",
  ].join("\n");

  assert.deepEqual(parseBacklogRepositories(readme), ["owner/real"]);
});

test("a block-level multi-line comment still hides its content", () => {
  // A line that starts with "<!--" opens a comment block (handled by
  // COMMENT_BLOCK_START) whose contents are literal until "-->".
  const readme = [
    "## Backlog repositories",
    "",
    "<!--",
    "- owner/hidden",
    "-->",
    "- owner/real",
  ].join("\n");

  assert.deepEqual(parseBacklogRepositories(readme), ["owner/real"]);
});

test("ignores declarations inside a raw HTML div block", () => {
  const readme = [
    "## Backlog repositories",
    "",
    "<div>",
    "- owner/hidden",
    "</div>",
    "",
    "- owner/real",
  ].join("\n");

  assert.deepEqual(parseBacklogRepositories(readme), ["owner/real"]);
});

test("ignores the reported div-wrapped declaration", () => {
  assert.deepEqual(
    parseBacklogRepositories(
      "## Backlog repositories\n\n<div>\n- owner/repo\n</div>\n",
    ),
    [],
  );
});

test("ignores declarations inside a script HTML block", () => {
  const readme = [
    "## Backlog repositories",
    "",
    "<script>",
    "- owner/hidden",
    "</script>",
    "",
    "- owner/real",
  ].join("\n");

  assert.deepEqual(parseBacklogRepositories(readme), ["owner/real"]);
});

test("keeps a script block open across a mismatched close tag", () => {
  const readme = [
    "## Backlog repositories",
    "",
    "<script>",
    "</pre>",
    "- owner/hidden",
    "</script>",
    "",
    "- owner/real",
  ].join("\n");

  assert.deepEqual(parseBacklogRepositories(readme), ["owner/real"]);
});

test("keeps a pre block open across a mismatched script close tag", () => {
  const readme = [
    "## Backlog repositories",
    "",
    "<pre>",
    "</script>",
    "- owner/hidden",
    "</pre>",
    "",
    "- owner/real",
  ].join("\n");

  assert.deepEqual(parseBacklogRepositories(readme), ["owner/real"]);
});

test("does not persist a self-contained one-line pre block", () => {
  const readme = [
    "## Backlog repositories",
    "",
    "<pre>text</pre>",
    "",
    "- owner/real",
  ].join("\n");

  assert.deepEqual(parseBacklogRepositories(readme), ["owner/real"]);
});

test("ignores declarations inside a type-7 single-tag HTML block", () => {
  const readme = [
    "## Backlog repositories",
    "",
    "<span>",
    "- owner/hidden",
    "</span>",
    "",
    "- owner/real",
  ].join("\n");

  assert.deepEqual(parseBacklogRepositories(readme), ["owner/real"]);
});

test("ignores declarations inside a search HTML block", () => {
  const readme = [
    "## Backlog repositories",
    "",
    "<search>text",
    "- owner/hidden",
    "</search>",
    "",
    "- owner/real",
  ].join("\n");

  assert.deepEqual(parseBacklogRepositories(readme), ["owner/real"]);
});

test("authorizes a declaration alongside an unrelated HTML block", () => {
  const readme = [
    "## Backlog repositories",
    "",
    "- owner/real",
    "",
    "<div>",
    "decorative",
    "</div>",
  ].join("\n");

  assert.deepEqual(parseBacklogRepositories(readme), ["owner/real"]);
});

test("does not open the section from an indented code line underlined by a rule", () => {
  // The first line has four leading spaces, so it is indented code, not a
  // paragraph. A following "---" cannot underline indented code into a setext
  // heading, so the "Backlog repositories" section never opens.
  const readme = [
    "    Backlog repositories",
    "---",
    "- attacker/repo",
  ].join("\n");

  assert.deepEqual(parseBacklogRepositories(readme), []);
});

test("does not close the section when an indented code line precedes a rule", () => {
  // Within a real section an indented code line is not a paragraph, so the
  // following "---" is a thematic break rather than a setext heading. The
  // section stays open and the later declaration is authorized.
  const readme = [
    "## Backlog repositories",
    "- owner/before",
    "",
    "    code text here",
    "---",
    "- owner/after",
  ].join("\n");

  assert.deepEqual(parseBacklogRepositories(readme), [
    "owner/before",
    "owner/after",
  ]);
});

test("rejects a code-span declaration with trailing concatenated characters", () => {
  const readme = [
    "## Backlog repositories",
    "- `attacker/repo`evil",
  ].join("\n");

  assert.deepEqual(parseBacklogRepositories(readme), []);
});

test("rejects a code-span declaration with leading concatenated characters", () => {
  const readme = [
    "## Backlog repositories",
    "- evil`attacker/repo`",
  ].join("\n");

  assert.deepEqual(parseBacklogRepositories(readme), []);
});

test("authorizes a code-span declaration followed by trailing punctuation", () => {
  const readme = [
    "## Backlog repositories",
    "- `owner/repo`.",
  ].join("\n");

  assert.deepEqual(parseBacklogRepositories(readme), ["owner/repo"]);
});

test("opens the section from an ATX heading with a closing hash sequence", () => {
  const readme = [
    "## Backlog repositories ##",
    "- owner/real",
  ].join("\n");

  assert.deepEqual(parseBacklogRepositories(readme), ["owner/real"]);
});

test("opens the section from an ATX heading with a longer closing hash run", () => {
  const readme = [
    "## Backlog repositories ###",
    "- owner/real",
  ].join("\n");

  assert.deepEqual(parseBacklogRepositories(readme), ["owner/real"]);
});

test("does not open the section when closing hashes lack a preceding space", () => {
  // Without a space before them the "#" characters are part of the heading
  // content ("Backlog repositories##"), so the section title does not match.
  const readme = [
    "## Backlog repositories##",
    "- owner/real",
  ].join("\n");

  assert.deepEqual(parseBacklogRepositories(readme), []);
});

test("does not open the section when letters follow the closing hashes", () => {
  const readme = [
    "## Backlog repositories #x",
    "- owner/real",
  ].join("\n");

  assert.deepEqual(parseBacklogRepositories(readme), []);
});

test("ends the section at another heading that carries closing hashes", () => {
  const readme = [
    "## Backlog repositories",
    "- owner/before",
    "## Other ##",
    "- owner/after",
  ].join("\n");

  assert.deepEqual(parseBacklogRepositories(readme), ["owner/before"]);
});

test("ends the section at an empty ATX heading", () => {
  // A bare "#" is a valid empty ATX heading, so it closes the backlog section
  // even though no space or text follows the hash.
  const readme = [
    "## Backlog repositories",
    "- owner/before",
    "#",
    "- attacker/repo",
  ].join("\n");

  assert.deepEqual(parseBacklogRepositories(readme), ["owner/before"]);
});

test("ends the section at an empty two-hash ATX heading", () => {
  const readme = [
    "## Backlog repositories",
    "- owner/before",
    "##",
    "- attacker/repo",
  ].join("\n");

  assert.deepEqual(parseBacklogRepositories(readme), ["owner/before"]);
});

test("keeps the section open across a hash immediately followed by text", () => {
  // "#foo" has no space after the hash, so CommonMark treats it as a paragraph,
  // not a heading; the section therefore stays open.
  const readme = [
    "## Backlog repositories",
    "- owner/before",
    "#foo",
    "- keep/repo",
  ].join("\n");

  assert.deepEqual(parseBacklogRepositories(readme), [
    "owner/before",
    "keep/repo",
  ]);
});

test("ends the section at an indented setext heading after a blank line", () => {
  // The blank line ends the list; " Other section" is a one-space-indented
  // top-level paragraph that the "---" underline turns into a real heading,
  // which closes the backlog section.
  const readme = [
    "## Backlog repositories",
    "- owner/before",
    "",
    " Other section",
    "---",
    "- attacker/repo",
  ].join("\n");

  assert.deepEqual(parseBacklogRepositories(readme), ["owner/before"]);
});

test("treats a lone carriage return as a line ending closing a setext heading", () => {
  // A lone CR is a CommonMark line ending, so "Other section\r---" is two lines:
  // "Other section" becomes a setext heading (underlined by "---") that closes
  // the backlog section, so "attacker/repo" must not leak. The blank line ends
  // the list so the setext underline is not a lazy continuation of the item.
  const readme =
    "## Backlog repositories\n- owner/before\n\nOther section\r---\n- attacker/repo";

  assert.deepEqual(parseBacklogRepositories(readme), ["owner/before"]);
});

test("does not treat a lone non-breaking space line as a blank line", () => {
  // NBSP is paragraph content in CommonMark, so the "\u00A0" line is a paragraph
  // that "Backlog repositories\n---" turns into a heading other than the backlog
  // section; the list under it must not be authorized.
  const readme = "\u00A0\nBacklog repositories\n---\n- attacker/repo";

  assert.deepEqual(parseBacklogRepositories(readme), []);
});

test("does not let a form feed line end an HTML block", () => {
  // A form feed is not a CommonMark blank line, so it does not close the type-6
  // HTML block; the list marker inside the block is literal and unauthorized.
  const readme = "## Backlog repositories\n<div>\n\f\n- attacker/repo";

  assert.deepEqual(parseBacklogRepositories(readme), []);
});

test("still parses backlog entries separated by CRLF line endings", () => {
  const readme = "## Backlog repositories\r\n- good/repo";

  assert.deepEqual(parseBacklogRepositories(readme), ["good/repo"]);
});

test("still treats a normal blank line as a blank line", () => {
  const readme = "## Backlog repositories\n\n- good/repo";

  assert.deepEqual(parseBacklogRepositories(readme), ["good/repo"]);
});


const run = promisify(execFile);

test("enumerates hierarchy from folders and reads revision metadata", async (t) => {
  const repositoryPath = await createRepository(t);
  const store = new WorkstreamStore({ repositoryPath });

  const listed = await store.list();
  const child = await store.read("parent/child");

  assert.equal(listed.complete, true);
  assert.match(listed.revision, /^[0-9a-f]{40}$/);
  assert.deepEqual(
    listed.workstreams.map((entry) => ({
      path: entry.path,
      parent: entry.parent,
      children: entry.children,
    })),
    [
      { path: "parent", parent: undefined, children: ["parent/child"] },
      { path: "parent/child", parent: "parent", children: [] },
      { path: "solo", parent: undefined, children: [] },
    ],
  );
  assert.equal(child.sourcePath, "workstreams/parent/child/README.md");
  assert.match(child.contentHash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(child.revision, listed.revision);
  assert.ok(Number.isFinite(Date.parse(child.modifiedAt)));
});

test("rejects missing workstreams and symlink escapes after realpath", async (t) => {
  const repositoryPath = await createRepository(t);
  const outside = path.join(repositoryPath, "outside");
  await mkdir(outside);
  await writeFile(path.join(outside, "README.md"), "# Outside\n");
  await symlink(
    outside,
    path.join(repositoryPath, "workstreams", "escape"),
    process.platform === "win32" ? "junction" : "dir",
  );

  await assert.rejects(
    resolveConfinedWorkstreamReadme(repositoryPath, "escape"),
    /escapes the configured repository root/,
  );
  await assert.rejects(
    new WorkstreamStore({ repositoryPath }).read("missing"),
    /Unable to read workstream missing/,
  );
});

test("validates new workstream targets without allowing existing symlink escapes", async (t) => {
  const repositoryPath = await createRepository(t);
  const newReadme = await resolveNewConfinedWorkstreamReadme(
    repositoryPath,
    "new/child",
  );

  assert.equal(
    newReadme,
    path.join(repositoryPath, "workstreams", "new", "child", "README.md"),
  );
  await mkdir(path.join(repositoryPath, "outside"));
  await symlink(
    path.join(repositoryPath, "outside"),
    path.join(repositoryPath, "workstreams", "new"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(
    resolveNewConfinedWorkstreamReadme(repositoryPath, "new/child"),
    /escapes the configured repository root/,
  );
});

test("reports malformed hierarchy without pretending enumeration is complete", async (t) => {
  const repositoryPath = await createRepository(t);
  await mkdir(
    path.join(repositoryPath, "workstreams", "orphan", "child"),
    { recursive: true },
  );
  await writeFile(
    path.join(
      repositoryPath,
      "workstreams",
      "orphan",
      "child",
      "README.md",
    ),
    "# Child without parent README\n",
  );

  const listed = await new WorkstreamStore({ repositoryPath }).list();

  assert.equal(listed.complete, false);
  assert.ok(
    listed.errors.some(
      (error) =>
        error.path === "orphan" && /has no README\.md/.test(error.reason),
    ),
  );
  assert.ok(
    listed.workstreams.some(
      (entry) =>
        entry.path === "orphan/child" && entry.parent === "orphan",
    ),
  );
});

test("performs bounded literal and regex narrative searches", async (t) => {
  const repositoryPath = await createRepository(t);
  const store = new WorkstreamStore({ repositoryPath, searchLimit: 10 });

  const literal = await store.search("commitment due");
  const regex = await store.search("owner:\\s+agent", { regex: true });
  const limited = await store.search("#", { limit: 1 });

  assert.equal(literal.complete, true);
  assert.deepEqual(
    literal.matches.map((match) => [
      match.path,
      match.startLine,
      match.endLine,
      match.text,
    ]),
    [["parent/child", 3, 3, "Commitment due Friday."]],
  );
  assert.equal(regex.matches[0].path, "parent/child");
  assert.equal(regex.matches[0].startLine, 4);
  assert.equal(limited.limited, true);
  assert.equal(limited.complete, false);
});

test("returns bounded recent git history for one workstream", async (t) => {
  const repositoryPath = await createRepository(t);
  const store = new WorkstreamStore({ repositoryPath });

  const history = await store.history("parent/child", { limit: 2 });

  assert.deepEqual(
    history.map((entry) => entry.subject),
    ["Update child workstream", "Add workstreams"],
  );
  for (const entry of history) {
    assert.match(entry.sha, /^[0-9a-f]{40}$/);
    assert.ok(Number.isFinite(Date.parse(entry.committedAt)));
    assert.equal(
      entry.changedPath,
      "workstreams/parent/child/README.md",
    );
  }
});

async function createRepository(t) {
  const repositoryPath = await mkdtemp(
    path.join(os.tmpdir(), "pan-workstream-store-"),
  );
  t.after(() => rm(repositoryPath, { recursive: true, force: true }));
  await mkdir(
    path.join(repositoryPath, "workstreams", "parent", "child"),
    { recursive: true },
  );
  await mkdir(path.join(repositoryPath, "workstreams", "solo"));
  await writeFile(
    path.join(repositoryPath, "workstreams", "parent", "README.md"),
    "# Parent\n",
  );
  await writeFile(
    path.join(
      repositoryPath,
      "workstreams",
      "parent",
      "child",
      "README.md",
    ),
    "# Child\n\nCommitment due Friday.\n",
  );
  await writeFile(
    path.join(repositoryPath, "workstreams", "solo", "README.md"),
    "# Solo\n",
  );

  await git(repositoryPath, ["init", "-b", "main"]);
  await git(repositoryPath, ["config", "user.name", "Pan Test"]);
  await git(repositoryPath, ["config", "user.email", "pan@example.invalid"]);
  await git(repositoryPath, ["add", "workstreams"]);
  await git(repositoryPath, ["commit", "-m", "Add workstreams"]);
  await writeFile(
    path.join(
      repositoryPath,
      "workstreams",
      "parent",
      "child",
      "README.md",
    ),
    "# Child\n\nCommitment due Friday.\nOwner: agent\n",
  );
  await git(repositoryPath, [
    "add",
    "workstreams/parent/child/README.md",
  ]);
  await git(repositoryPath, ["commit", "-m", "Update child workstream"]);
  return repositoryPath;
}

async function git(repositoryPath, args) {
  await run("git", args, {
    cwd: repositoryPath,
    windowsHide: true,
  });
}
