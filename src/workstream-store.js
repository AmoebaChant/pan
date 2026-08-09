import { createHash } from "node:crypto";
import {
  lstat,
  readFile,
  readdir,
  realpath,
  stat,
} from "node:fs/promises";
import path from "node:path";

import { ProcessClient } from "./process-client.js";

const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;
const DEFAULT_SEARCH_LIMIT = 100;
const DEFAULT_HISTORY_LIMIT = 50;

export class WorkstreamStore {
  constructor({
    repositoryPath,
    commands = new ProcessClient(),
    commandTimeout = 10_000,
    maxFileBytes = DEFAULT_MAX_FILE_BYTES,
    searchLimit = DEFAULT_SEARCH_LIMIT,
    historyLimit = DEFAULT_HISTORY_LIMIT,
  }) {
    if (!path.isAbsolute(repositoryPath ?? "")) {
      throw new TypeError("repositoryPath must be an absolute path");
    }
    for (const [name, value] of Object.entries({
      commandTimeout,
      maxFileBytes,
      searchLimit,
      historyLimit,
    })) {
      if (!Number.isInteger(value) || value < 1) {
        throw new TypeError(`${name} must be a positive integer`);
      }
    }
    this.repositoryPath = path.resolve(repositoryPath);
    this.commands = commands;
    this.commandTimeout = commandTimeout;
    this.maxFileBytes = maxFileBytes;
    this.searchLimit = searchLimit;
    this.historyLimit = historyLimit;
  }

  async list() {
    const [repositoryRoot, root] = await Promise.all([
      realpath(this.repositoryPath),
      realpath(path.join(this.repositoryPath, "workstreams")),
    ]);
    assertWithinRoot(repositoryRoot, root);
    const workstreams = [];
    const errors = [];
    await enumerateDirectories(root, [], workstreams, errors);
    workstreams.sort((left, right) => left.path.localeCompare(right.path));

    const known = new Set(workstreams.map((entry) => entry.path));
    for (const entry of workstreams) {
      entry.children = workstreams
        .filter((candidate) => candidate.parent === entry.path)
        .map((candidate) => candidate.path);
      if (entry.parent && !known.has(entry.parent)) {
        errors.push({
          path: entry.parent,
          reason: `Parent workstream ${entry.parent} has no readable README.md`,
        });
      }
    }

    return {
      revision: await this.#revision(),
      complete: errors.length === 0,
      workstreams,
      errors: deduplicateErrors(errors),
    };
  }

  async read(workstream) {
    const sourcePath = await resolveConfinedWorkstreamReadme(
      this.repositoryPath,
      workstream,
    );
    const metadata = await stat(sourcePath);
    if (!metadata.isFile()) {
      throw new Error(`Workstream ${workstream} README.md is not a file`);
    }
    if (metadata.size > this.maxFileBytes) {
      throw new Error(
        `Workstream ${workstream} README.md exceeds the ${this.maxFileBytes}-byte read limit`,
      );
    }
    const content = await readFile(sourcePath, "utf8");
    return {
      path: workstream,
      sourcePath: `workstreams/${workstream}/README.md`,
      content,
      contentHash: `sha256:${createHash("sha256").update(content).digest("hex")}`,
      modifiedAt: metadata.mtime.toISOString(),
      revision: await this.#revision(),
    };
  }

  async search(pattern, options = {}) {
    const matcher = createMatcher(pattern, options);
    const limit = boundedLimit(
      options.limit ?? this.searchLimit,
      this.searchLimit,
      "search limit",
    );
    const listed = await this.list();
    const errors = [...listed.errors];
    const matches = [];

    for (const entry of listed.workstreams) {
      if (matches.length >= limit) {
        break;
      }
      let workstream;
      try {
        workstream = await this.read(entry.path);
      } catch (error) {
        errors.push({ path: entry.path, reason: error.message });
        continue;
      }
      for (const [index, line] of workstream.content.split(/\r?\n/).entries()) {
        if (line.length > this.maxFileBytes) {
          errors.push({
            path: entry.path,
            reason: `Line ${index + 1} exceeds the bounded search length`,
          });
          break;
        }
        if (matcher(line)) {
          matches.push({
            path: entry.path,
            sourcePath: workstream.sourcePath,
            startLine: index + 1,
            endLine: index + 1,
            text: line,
          });
          if (matches.length >= limit) {
            break;
          }
        }
      }
    }

    return {
      revision: listed.revision,
      complete: errors.length === 0 && matches.length < limit,
      matches,
      errors: deduplicateErrors(errors),
      limited: matches.length >= limit,
    };
  }

  async history(workstream, options = {}) {
    await resolveConfinedWorkstreamReadme(this.repositoryPath, workstream);
    const limit = boundedLimit(
      options.limit ?? this.historyLimit,
      this.historyLimit,
      "history limit",
    );
    const sourcePath = `workstreams/${workstream}/README.md`;
    const output = await this.commands.run(
      "git",
      [
        "-C",
        this.repositoryPath,
        "log",
        "-n",
        String(limit),
        "--date=iso-strict",
        "--format=%H%x1f%cI%x1f%s%x1f",
        "--name-only",
        "--",
        sourcePath,
      ],
      {
        timeout: this.commandTimeout,
        maxBuffer: this.maxFileBytes,
      },
    );
    return parseHistory(output, sourcePath);
  }

  async #revision() {
    return this.commands.run(
      "git",
      ["-C", this.repositoryPath, "rev-parse", "HEAD"],
      {
        timeout: this.commandTimeout,
        maxBuffer: 1024,
      },
    );
  }
}

export function resolveWorkstreamReadme(repositoryPath, workstream) {
  validateWorkstreamPath(workstream);
  const root = path.resolve(repositoryPath, "workstreams");
  const candidate = path.resolve(
    root,
    ...workstream.split("/"),
    "README.md",
  );
  assertWithinRoot(root, candidate);
  return candidate;
}

export async function resolveNewConfinedWorkstreamReadme(
  repositoryPath,
  workstream,
) {
  const candidate = resolveWorkstreamReadme(repositoryPath, workstream);
  const repository = path.resolve(repositoryPath);
  const root = path.join(repository, "workstreams");
  const [repositoryRealPath, nearestExistingAncestor] = await Promise.all([
    realpath(repository),
    nearestExistingPath(path.dirname(candidate)),
  ]);
  assertContainedBy(repositoryRealPath, nearestExistingAncestor);

  try {
    const rootRealPath = await realpath(root);
    assertContainedBy(repositoryRealPath, rootRealPath);
    assertContainedBy(rootRealPath, nearestExistingAncestor);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
  return candidate;
}

export async function resolveConfinedWorkstreamReadme(
  repositoryPath,
  workstream,
) {
  const candidate = resolveWorkstreamReadme(repositoryPath, workstream);
  let repositoryRealPath;
  let rootRealPath;
  let candidateRealPath;
  try {
    [repositoryRealPath, rootRealPath, candidateRealPath] = await Promise.all([
      realpath(path.resolve(repositoryPath)),
      realpath(path.resolve(repositoryPath, "workstreams")),
      realpath(candidate),
    ]);
  } catch (error) {
    throw new Error(
      `Unable to read workstream ${workstream}: ${error.message}`,
      { cause: error },
    );
  }
  assertWithinRoot(repositoryRealPath, rootRealPath);
  assertWithinRoot(rootRealPath, candidateRealPath);
  return candidateRealPath;
}

async function enumerateDirectories(root, segments, workstreams, errors) {
  const directory = path.join(root, ...segments);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    errors.push({
      path: segments.join("/"),
      reason: `Unable to enumerate workstream directory: ${error.message}`,
    });
    return;
  }

  if (segments.length > 0) {
    const workstream = segments.join("/");
    const readme = entries.find((entry) => entry.name === "README.md");
    if (!readme) {
      errors.push({
        path: workstream,
        reason: `Workstream ${workstream} has no README.md`,
      });
    } else {
      try {
        const metadata = await lstat(path.join(directory, readme.name));
        if (!metadata.isFile() && !metadata.isSymbolicLink()) {
          throw new Error("README.md is not a file");
        }
        await resolveConfinedWorkstreamReadme(
          path.dirname(root),
          workstream,
        );
        workstreams.push({
          path: workstream,
          parent:
            segments.length > 1 ? segments.slice(0, -1).join("/") : undefined,
          children: [],
          sourcePath: `workstreams/${workstream}/README.md`,
        });
      } catch (error) {
        errors.push({ path: workstream, reason: error.message });
      }
    }
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      await enumerateDirectories(
        root,
        [...segments, entry.name],
        workstreams,
        errors,
      );
    } else if (entry.isSymbolicLink() && entry.name !== "README.md") {
      errors.push({
        path: [...segments, entry.name].join("/"),
        reason: "Symbolic-link workstream directories are not enumerated",
      });
    }
  }
}

const BACKLOG_HEADING_PATTERN =
  /^#{1,6}[ \t]+backlog repositories(?:[ \t]+#+)?[ \t]*$/i;

// A code fence may be the child of a single list item, in which case a list
// marker precedes it (e.g. "* ```"). Recognizing that prefix keeps declarations
// nested inside fenced examples from being authorized. Markdown permits one to
// four spaces of padding after the marker; five or more makes the content
// indented code rather than a fence. Only an ordered marker starting with "1"
// may open such a list, matching CommonMark's paragraph-interruption rule.
const LIST_PREFIX = "(?:(?:[-*+]|1[.)])[ \\t]{1,4})?";
const OPENING_FENCE_PATTERN = new RegExp(
  `^ {0,3}${LIST_PREFIX}(\`{3,}|~{3,})(.*)$`,
);
const CLOSING_FENCE_PATTERN = /^( {0,3})(`{3,}|~{3,})[ \t]*$/;
// A hash run of 1-6 "#" that (per CommonMark) is followed by a space/tab or the
// end of the line. "#foo" (hash immediately followed by non-space) is a
// paragraph, not a heading, so it must not match; a bare "#"/"##" (empty
// heading) must match so it still closes an open section.
const HEADING_PATTERN = /^ {0,3}#{1,6}(?:[ \t].*)?$/;
// A setext heading underline is a line of only "=" (level 1) or only "-"
// (level 2), with up to three leading spaces and optional trailing spaces. When
// it follows a paragraph line it turns that paragraph into a heading, which ends
// the "## Backlog repositories" section just like an ATX heading. A run may not
// mix "=" and "-".
const SETEXT_UNDERLINE_PATTERN = /^ {0,3}(?:=+|-+)[ \t]*$/;
// A CommonMark thematic break: three or more matching "-", "*", or "_"
// characters (optionally separated by spaces/tabs), up to three leading spaces.
const THEMATIC_BREAK_PATTERN = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
// The section title compared against a setext heading's text (the ATX form is
// matched by BACKLOG_HEADING_PATTERN, which includes the leading "#" run).
const BACKLOG_TITLE_PATTERN = /^backlog repositories$/i;
// A CommonMark type-2 HTML block: a line whose first non-space content (up to
// three leading spaces) is an HTML comment opener. The whole line is literal
// block content, so a list marker that appears after the comment on the same
// line (e.g. "<!--x-->- owner/repo") is never a declaration. The block ends on
// the line containing the matching "-->".
const COMMENT_BLOCK_START = /^ {0,3}<!--/;
// A declaration must be a top-level list item at column zero. Any indentation
// places it inside a list container or indented code, where it must not be
// authorized.
const LIST_ITEM_PATTERN = /^[-*+][ \t]+(.*)$/;

// CommonMark raw HTML blocks (types 1 and 3-7) enclose literal content that a
// Markdown renderer never parses as list items, so a declaration nested inside
// one must not be authorized. Type 2 (HTML comments) is handled separately by
// stripLineComments. Each start pattern permits up to three leading spaces,
// matching CommonMark's block-start rule. Legitimate declarations begin with a
// list marker at column zero, so they can never begin with "<" and cannot
// collide with these HTML block starts.
//
// Type 1: <script>, <pre>, <style>, <textarea> (case-insensitive), followed by
// whitespace, ">", or end of line. Ends only on a line containing the closing
// tag that matches the opening tag; a mismatched closing tag (for example
// </pre> inside a <script> block) leaves the block open so its literal content
// is never authorized. The opening tag name is captured to build that
// tag-specific end pattern.
const HTML_BLOCK_TYPE_1_START = /^ {0,3}<(script|pre|style|textarea)(?:[ \t]|>|$)/i;
// Type 3: processing instruction. Ends on a line containing "?>".
const HTML_BLOCK_TYPE_3_START = /^ {0,3}<\?/;
const HTML_BLOCK_TYPE_3_END = /\?>/;
// Type 4: declaration beginning "<!" followed by an ASCII letter. Ends on a
// line containing ">".
const HTML_BLOCK_TYPE_4_START = /^ {0,3}<![A-Za-z]/;
const HTML_BLOCK_TYPE_4_END = />/;
// Type 5: CDATA section. Ends on a line containing "]]>".
const HTML_BLOCK_TYPE_5_START = /^ {0,3}<!\[CDATA\[/;
const HTML_BLOCK_TYPE_5_END = /\]\]>/;
// Type 6: a known block-level tag (open or closing) followed by whitespace,
// end of line, ">", or "/>". Ends on the first following blank line. This list
// follows the CommonMark 0.31.2 type-6 tag set (which added "search").
const HTML_BLOCK_TYPE_6_TAGS =
  "address|article|aside|base|basefont|blockquote|body|caption|center|col|" +
  "colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|" +
  "footer|form|frame|frameset|h1|h2|h3|h4|h5|h6|head|header|hr|html|iframe|" +
  "legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|" +
  "search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul";
const HTML_BLOCK_TYPE_6_START = new RegExp(
  `^ {0,3}</?(?:${HTML_BLOCK_TYPE_6_TAGS})(?:[ \\t]|/?>|$)`,
  "i",
);
// Type 7: a single complete open tag (with valid attributes) or closing tag on
// its own line, for any tag name other than the type-1 tags. Ends on the first
// following blank line.
const HTML_TAG_NAME = "[A-Za-z][A-Za-z0-9-]*";
const HTML_ATTRIBUTE =
  "(?:[ \\t]+[A-Za-z_:][A-Za-z0-9_.:-]*(?:[ \\t]*=[ \\t]*(?:[^ \"'=<>`]+|'[^']*'|\"[^\"]*\"))?)";
const HTML_BLOCK_TYPE_7_START = new RegExp(
  `^ {0,3}(?:<${HTML_TAG_NAME}${HTML_ATTRIBUTE}*[ \\t]*/?>|</${HTML_TAG_NAME}[ \\t]*>)[ \\t]*$`,
);

function visualColumn(text) {
  let column = 0;
  for (const character of text) {
    column += character === "\t" ? 4 - (column % 4) : 1;
  }
  return column;
}

function leadingIndentColumns(text) {
  const leading = /^[ \t]*/.exec(text)?.[0] ?? "";
  return visualColumn(leading);
}

function trimSpacesTabs(text) {
  return text.replace(/^[ \t]+|[ \t]+$/g, "");
}

// A list item enables lazy paragraph continuation on the following line only
// when its content is an ordinary, non-empty paragraph. An empty item, or one
// whose content is itself a block (an ATX heading, a thematic break, or a code
// fence), has no open paragraph to continue, so the next column-0 line is a
// fresh top-level block — not list content.
function isLazyContinuableParagraph(content) {
  if (!/[^ \t]/.test(content)) {
    return false;
  }
  if (HEADING_PATTERN.test(content)) {
    return false;
  }
  if (THEMATIC_BREAK_PATTERN.test(content)) {
    return false;
  }
  if (matchOpeningFence(content)) {
    return false;
  }
  if (matchHtmlBlockOpening(content)) {
    return false;
  }
  return true;
}

function matchOpeningFence(text) {
  const match = OPENING_FENCE_PATTERN.exec(text);
  if (!match) {
    return undefined;
  }
  const run = match[1];
  const info = match[2];
  // A backtick fence may not contain a backtick in its info string.
  if (run[0] === "`" && info.includes("`")) {
    return undefined;
  }
  const prefix = match[0].slice(0, match[0].length - run.length - info.length);
  const nested = /\S/.test(prefix);
  return {
    char: run[0],
    length: run.length,
    // A fence nested in a list item is only closed by a fence indented into
    // that container; a shallower marker leaves it open so nested content is
    // never authorized. Tabs are expanded to Markdown's four-column stops.
    minCloseIndent: nested ? visualColumn(prefix) : 0,
  };
}

// Detect the start of a raw HTML block, returning { type, tag } where type is
// its CommonMark type (1 or 3-7) and tag is the lower-cased opening tag name
// for type 1 (undefined otherwise), or undefined when the line does not open a
// block. Types are checked in the order CommonMark specifies so the more
// specific declarations (script/pre/style, CDATA) win before the broader ones.
function matchHtmlBlockOpening(rawLine) {
  const type1 = HTML_BLOCK_TYPE_1_START.exec(rawLine);
  if (type1) {
    return { type: 1, tag: type1[1].toLowerCase() };
  }
  if (HTML_BLOCK_TYPE_3_START.test(rawLine)) {
    return { type: 3 };
  }
  if (HTML_BLOCK_TYPE_5_START.test(rawLine)) {
    return { type: 5 };
  }
  if (HTML_BLOCK_TYPE_4_START.test(rawLine)) {
    return { type: 4 };
  }
  if (HTML_BLOCK_TYPE_6_START.test(rawLine)) {
    return { type: 6 };
  }
  if (HTML_BLOCK_TYPE_7_START.test(rawLine)) {
    return { type: 7 };
  }
  return undefined;
}

// A type-1 block closes only on its own matching closing tag, so build the end
// pattern from the captured opening tag name. The tag comes from a fixed set of
// letters, so it is safe to embed directly in the expression.
function htmlBlockType1EndPattern(tag) {
  return new RegExp(`</${tag}>`, "i");
}

// Types 1 and 3-5 close on the line that contains their end token (that line is
// part of the block). Types 6 and 7 instead close on the first following blank
// line, so they are never reported here. Type 1 requires its opening tag so it
// closes only on the matching closing tag.
function htmlBlockEndsOnLine(type, rawLine, tag) {
  switch (type) {
    case 1:
      return htmlBlockType1EndPattern(tag).test(rawLine);
    case 3:
      return HTML_BLOCK_TYPE_3_END.test(rawLine);
    case 4:
      return HTML_BLOCK_TYPE_4_END.test(rawLine);
    case 5:
      return HTML_BLOCK_TYPE_5_END.test(rawLine);
    default:
      return false;
  }
}

export function parseBacklogRepositories(content) {
  if (typeof content !== "string") {
    return [];
  }
  const repositories = [];
  const seen = new Set();
  // Split on CommonMark line endings: LF, CRLF, and a lone CR. A lone CR is a
  // line ending, so "text\r---" is two lines (a setext heading), not one.
  const lines = content.split(/\r\n|\r|\n/);
  let inSection = false;
  let inFence = false;
  let fenceChar = "";
  let fenceLength = 0;
  let fenceMinCloseIndent = 0;
  let inComment = false;
  let htmlBlockType = 0;
  let htmlBlockTag;
  // Text of the immediately preceding paragraph line, or undefined when the
  // previous line was blank or a block structure. A setext underline only forms
  // a heading when it follows such a paragraph line.
  let pendingParagraph;
  // True when pendingParagraph began as a lazy continuation of a list item (no
  // blank line separated them). In CommonMark such a paragraph is list content
  // and a following setext underline is a disallowed lazy continuation, so it
  // never forms a heading.
  let pendingParagraphIsListContinuation = false;
  // True when the pending paragraph's first line was indented (1-3 columns). A
  // setext underline only forms a TOP-LEVEL heading when its paragraph begins at
  // column 0; an indented first line means the paragraph is nested in a
  // preceding list item (or is an unusual indented top-level paragraph), so its
  // underline must not open the section. Failing closed on indentation mirrors
  // the ATX opening rule, which also requires a column-0 heading.
  let pendingParagraphIndented = false;
  // Whether the immediately preceding line was a top-level list item. Captured
  // and reset once per line at the top of the loop.
  let previousWasListItem = false;
  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    const afterListItem = previousWasListItem;
    previousWasListItem = false;
    if (inFence) {
      // HTML comment syntax is literal inside fenced code, so evaluate the
      // closing fence on the raw line without stripping comments.
      const closing = CLOSING_FENCE_PATTERN.exec(rawLine);
      if (
        closing &&
        closing[2][0] === fenceChar &&
        closing[2].length >= fenceLength &&
        closing[1].length >= fenceMinCloseIndent
      ) {
        inFence = false;
      }
      pendingParagraph = undefined;
      continue;
    }
    if (htmlBlockType) {
      // Inside a raw HTML block every line is literal, so a list marker here is
      // not a declaration and must never be authorized. Types 6 and 7 end at
      // the first following blank line; the other types end on the line that
      // carries their close token, which is consumed as part of the block.
      if (htmlBlockType === 6 || htmlBlockType === 7) {
        // A CommonMark blank line is only spaces and tabs; control characters
        // such as form feed do not terminate a type-6/7 HTML block.
        if (/^[ \t]*$/.test(rawLine)) {
          htmlBlockType = 0;
        }
      } else if (htmlBlockEndsOnLine(htmlBlockType, rawLine, htmlBlockTag)) {
        htmlBlockType = 0;
        htmlBlockTag = undefined;
      }
      pendingParagraph = undefined;
      continue;
    }
    if (inComment) {
      // Continuation of an HTML comment opened on a previous line. The block is
      // literal until "-->". The text after the closer is a lazy continuation
      // of the enclosing context, never a fresh block start, so once the comment
      // closes fail closed and authorize nothing on the remainder of this line.
      if (rawLine.includes("-->")) {
        inComment = false;
      }
      pendingParagraph = undefined;
      continue;
    }
    // Recognize a fence opening on the raw line only. Fences are determined by
    // the original line structure, so opening never leaks HTML-comment state
    // and a comment removed from a line cannot synthesize a fence opener.
    const rawOpening = matchOpeningFence(rawLine);
    if (rawOpening) {
      inFence = true;
      fenceChar = rawOpening.char;
      fenceLength = rawOpening.length;
      fenceMinCloseIndent = rawOpening.minCloseIndent;
      pendingParagraph = undefined;
      continue;
    }
    // Recognize a raw HTML block opening on the raw line, mirroring fences.
    const htmlOpening = matchHtmlBlockOpening(rawLine);
    if (htmlOpening) {
      // Types 1 and 3-5 may open and close on the same line; that whole line
      // is still a block whose contents are ignored, so skip it without
      // entering multi-line block state. Type 1 uses its matching close tag.
      if (
        htmlOpening.type !== 6 &&
        htmlOpening.type !== 7 &&
        htmlBlockEndsOnLine(htmlOpening.type, rawLine, htmlOpening.tag)
      ) {
        pendingParagraph = undefined;
        continue;
      }
      htmlBlockType = htmlOpening.type;
      htmlBlockTag = htmlOpening.tag;
      pendingParagraph = undefined;
      continue;
    }
    // A line that begins with an HTML comment opener is a CommonMark type-2 HTML
    // block: the entire line is literal, so any list marker or heading after the
    // comment on the same line (e.g. "<!--x-->- owner/repo") is not a
    // declaration. Evaluate this on the raw line before stripping so a stripped
    // comment can never synthesize a marker or heading from trailing text.
    if (COMMENT_BLOCK_START.test(rawLine)) {
      const openIndex = rawLine.indexOf("<!--");
      if (rawLine.indexOf("-->", openIndex + 4) === -1) {
        inComment = true;
      }
      pendingParagraph = undefined;
      continue;
    }
    // No block opener. Recognize block structure on the RAW line: CommonMark
    // determines block structure before inline HTML comments, so a mid-line
    // inline comment can never suppress a following block-level heading or setext
    // underline, and never carries "inComment" state across lines. Inline
    // comments are stripped only from a list item's declaration content below.
    // Multi-line comment BLOCKS (a line that starts with "<!--") are handled
    // earlier by COMMENT_BLOCK_START.
    // A CommonMark blank line contains only spaces and tabs. Do not use trim():
    // JS trims Unicode whitespace such as NBSP, which is paragraph content in
    // CommonMark, so a lone-NBSP line would be misread as a blank line.
    if (!/[^ \t]/.test(rawLine)) {
      pendingParagraph = undefined;
      continue;
    }
    if (HEADING_PATTERN.test(rawLine)) {
      // Decide the section state from the RAW line so trailing content after a
      // closing "#" run (for example an inline comment: "## Backlog
      // repositories ##<!--x-->") cannot be stripped away to forge the title.
      // BACKLOG_HEADING_PATTERN is fully anchored, so any trailing non-space,
      // non-closing-hash content prevents the section from opening. Detection
      // of the line as a heading (for section-closing) also uses the raw line.
      //
      // Match the RAW line with only trailing whitespace removed. Leading
      // indentation is preserved so BACKLOG_HEADING_PATTERN's "^#" anchor only
      // opens the section for a column-0 heading; an indented "  ## Backlog
      // repositories" is nested inside a preceding list item (or is otherwise
      // not a top-level declaration heading) and must not open the section. It
      // is still detected as a heading by HEADING_PATTERN above, so it still
      // closes an open section (the safe direction).
      inSection = BACKLOG_HEADING_PATTERN.test(rawLine.replace(/[ \t]+$/, ""));
      pendingParagraph = undefined;
      continue;
    }
    // Evaluate the setext underline on the RAW line (trailing whitespace only)
    // so trailing content after the run — e.g. an inline comment
    // "---<!-- hidden -->" that stripLineComments would remove — disqualifies
    // it, exactly as CommonMark requires a setext underline to be a line of
    // only "=" or "-".
    if (SETEXT_UNDERLINE_PATTERN.test(rawLine.replace(/[ \t]+$/, ""))) {
      // A line of only "=" or "-" runs. It becomes a setext heading underline
      // only when it follows genuine paragraph text (pendingParagraph is set),
      // turning that paragraph into a heading that ends the backlog section
      // unless the heading text is itself "Backlog repositories". When the
      // previous line was blank, a block, or a list item there is no paragraph
      // to underline: GitHub Markdown then treats "---" as a thematic break and
      // "===" as a lazy list continuation, so no heading forms and the section
      // is neither opened nor closed. Either way the underline itself is never a
      // declaration.
      if (pendingParagraph !== undefined && !pendingParagraphIsListContinuation) {
        // A genuine top-level setext heading (its paragraph is not list
        // content). It ENDS the backlog section unless it is itself a
        // single-line, column-0 "Backlog repositories" heading. An indented
        // first line cannot OPEN the section (mirrors the column-0 ATX rule),
        // but the underline is still a real heading, so it must still CLOSE an
        // open section — never leave inSection unchanged here, or an indented or
        // non-matching heading would fail to close (a false-open).
        inSection =
          !pendingParagraphIndented &&
          BACKLOG_TITLE_PATTERN.test(pendingParagraph);
      }
      pendingParagraph = undefined;
      continue;
    }
    const listMatch = LIST_ITEM_PATTERN.exec(rawLine);
    if (listMatch) {
      // A list item is never setext heading text: in GitHub Markdown a following
      // "---" is a thematic break and a following "===" is list continuation, so
      // the marker stays a declaration. Clear any pending paragraph so a later
      // underline cannot retroactively turn this list item into a heading.
      pendingParagraph = undefined;
      // The next line is a lazy continuation of this list item (list content)
      // only when the item's content is a continuable paragraph. An empty item
      // or one whose content is itself a block cannot be lazily continued, so
      // the next column-0 line is a fresh top-level block.
      previousWasListItem = isLazyContinuableParagraph(listMatch[1]);
      if (inSection) {
        // Strip inline comments from the declaration content only (e.g. a
        // trailing "<!-- note -->"), preserving code spans. Block structure was
        // already decided on the raw line above.
        const declaration = stripLineComments(listMatch[1], false).text;
        const repository = extractRepository(declaration);
        if (repository) {
          const key = repository.toLowerCase();
          if (!seen.has(key)) {
            seen.add(key);
            repositories.push(repository);
          }
        }
      }
      continue;
    }
    // An indented line (>= 4 columns) that does not continue an existing
    // paragraph AND does not immediately follow a list item begins a top-level
    // indented code block, not a paragraph, so no following setext underline can
    // turn it into a heading. When it DOES follow a list item it is a lazy
    // continuation of that list item (list content), so let it fall through to
    // be recorded as a list-continuation paragraph (which a setext underline can
    // never turn into a top-level heading).
    if (
      pendingParagraph === undefined &&
      !afterListItem &&
      leadingIndentColumns(rawLine) >= 4
    ) {
      continue;
    }
    if (pendingParagraph === undefined) {
      // A paragraph that starts immediately after a list item (no blank line) is
      // a lazy continuation of that list item, i.e. list content, so a following
      // setext underline must not turn it into a heading.
      pendingParagraphIsListContinuation = afterListItem;
      // Capture the first line's indentation; only column-0 paragraphs can form
      // a top-level setext heading. Continuation lines keep this value.
      pendingParagraphIndented = leadingIndentColumns(rawLine) > 0;
    }
    // Record the paragraph so a following setext underline can turn it into a
    // heading. A setext underline turns the ENTIRE preceding paragraph into the
    // heading, so accumulate every consecutive line (newline-joined). Because
    // BACKLOG_TITLE_PATTERN is anchored and single-line, a multi-line paragraph
    // can never equal the title, so a forged last line like "Backlog
    // repositories" under other text neither opens nor (as a heading) keeps the
    // section open.
    pendingParagraph =
      pendingParagraph === undefined
        ? trimSpacesTabs(rawLine)
        : `${pendingParagraph}\n${trimSpacesTabs(rawLine)}`;
  }
  return repositories;
}

function stripLineComments(rawLine, startInComment) {
  let rest = rawLine;
  let inComment = startInComment;
  if (inComment) {
    const end = rest.indexOf("-->");
    if (end === -1) {
      return { text: "", inComment: true };
    }
    rest = rest.slice(end + 3);
    inComment = false;
  }
  // Scan the line left to right so inline code spans are recognized before any
  // HTML comment inside them. GitHub-Flavored Markdown renders "<!--"/"-->"
  // literally inside inline code, so a comment must only be stripped when it
  // occurs OUTSIDE a code span. Blindly stripping "<!--...-->" would let a
  // payload like `<!--x-->attacker/repo` (which renders as the literal text
  // "<!--x-->attacker/repo") be mistaken for a comment plus a repository.
  let text = "";
  let i = 0;
  while (i < rest.length) {
    if (rest[i] === "`") {
      // A backtick run opens an inline code span. GFM closes it at the next run
      // of exactly the same length; a run with no matching closer is literal
      // text. A matched span (backticks and inner text) is preserved verbatim
      // and never comment-stripped.
      let runEnd = i;
      while (runEnd < rest.length && rest[runEnd] === "`") {
        runEnd += 1;
      }
      const runLength = runEnd - i;
      const closer = findMatchingBacktickRun(rest, runEnd, runLength);
      if (closer === -1) {
        text += rest.slice(i, runEnd);
        i = runEnd;
        continue;
      }
      text += rest.slice(i, closer + runLength);
      i = closer + runLength;
      continue;
    }
    if (rest.startsWith("<!--", i)) {
      const close = rest.indexOf("-->", i + 4);
      if (close === -1) {
        // An inline comment that opens but does not close carries the comment
        // state to the following lines and discards the remainder of this line.
        inComment = true;
        break;
      }
      i = close + 3;
      continue;
    }
    text += rest[i];
    i += 1;
  }
  return { text, inComment };
}

// Find the start index of the next backtick run of exactly `length` backticks in
// `line` at or after `from`. Runs of a different length are code-span content,
// not closers. Returns -1 when there is no matching closer on the line.
function findMatchingBacktickRun(line, from, length) {
  let i = from;
  while (i < line.length) {
    if (line[i] === "`") {
      let runEnd = i;
      while (runEnd < line.length && line[runEnd] === "`") {
        runEnd += 1;
      }
      if (runEnd - i === length) {
        return i;
      }
      i = runEnd;
      continue;
    }
    i += 1;
  }
  return -1;
}

function extractRepository(text) {
  const trimmed = text.trim();
  // A repository may be wrapped in a single inline code span. Unwrap exactly one
  // fully-formed span to its LITERAL inner content and validate that content
  // directly; never strip comment or HTML syntax from inside code, which GFM
  // renders literally. A payload like `<!--x-->attacker/repo` therefore keeps
  // its literal "<" and fails the strict repository patterns below.
  const codeSpan = /^(`+)([^`]*)\1(?!`)/.exec(trimmed);
  let candidate;
  if (codeSpan) {
    // A fully code-wrapped repository must be the ENTIRE declaration token: only
    // trailing whitespace or sentence punctuation may follow the closing
    // backticks. Concatenated characters (e.g. "`owner/repo`evil") mean the code
    // span is not the whole token, so the declaration is rejected. Leading
    // concatenation cannot reach here because the span regex is anchored at "^"
    // (a leading non-backtick leaves the token with a literal backtick, which the
    // "[`<>]" guard below rejects).
    const remainder = trimmed.slice(codeSpan[0].length);
    if (/[^\s.,;]/.test(remainder)) {
      return undefined;
    }
    candidate = codeSpan[2];
  } else {
    candidate = trimmed;
  }
  const cleaned = candidate.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").trim();
  const token = cleaned.split(/\s+/)[0]?.replace(/[.,;]+$/, "") ?? "";
  // Reject any residual code or comment syntax: a real repository token never
  // contains a backtick or angle bracket, so their presence means the value was
  // literal code-span content or malformed markup that must not authorize.
  if (/[`<>]/.test(token)) {
    return undefined;
  }
  const url =
    /^(?:https?:\/\/)?github\.com\/([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*?)(?:\.git)?\/?$/i.exec(
      token,
    );
  if (url) {
    return `${url[1]}/${url[2]}`;
  }
  const plain = /^([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(
    token,
  );
  return plain ? `${plain[1]}/${plain[2]}` : undefined;
}

export function validateWorkstreamPath(workstream) {
  if (
    typeof workstream !== "string" ||
    !workstream ||
    path.posix.isAbsolute(workstream) ||
    path.isAbsolute(workstream) ||
    workstream.includes("\\") ||
    path.posix.normalize(workstream) !== workstream
  ) {
    throw new Error(
      "Workstream must be a canonical relative path using / separators",
    );
  }
  const segments = workstream.split("/");
  if (
    segments.some(
      (segment) => !segment || segment === "." || segment === "..",
    )
  ) {
    throw new Error("Workstream path contains an invalid segment");
  }
}

async function nearestExistingPath(candidate) {
  let current = candidate;
  for (;;) {
    try {
      return await realpath(current);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
      const parent = path.dirname(current);
      if (parent === current) {
        throw error;
      }
      current = parent;
    }
  }
}

function assertWithinRoot(root, candidate) {
  const relative = path.relative(root, candidate);
  if (
    !relative ||
    relative.startsWith(`..${path.sep}`) ||
    relative === ".." ||
    path.isAbsolute(relative)
  ) {
    throw new Error("Workstream path escapes the configured repository root");
  }
}

function assertContainedBy(root, candidate) {
  const relative = path.relative(root, candidate);
  if (
    relative.startsWith(`..${path.sep}`) ||
    relative === ".." ||
    path.isAbsolute(relative)
  ) {
    throw new Error("Workstream path escapes the configured repository root");
  }
}

function createMatcher(pattern, { regex = false, caseSensitive = false } = {}) {
  if (typeof pattern !== "string" || !pattern || pattern.length > 1_000) {
    throw new TypeError("search pattern must be 1 through 1000 characters");
  }
  if (regex) {
    const expression = new RegExp(pattern, caseSensitive ? "" : "i");
    return (line) => {
      expression.lastIndex = 0;
      return expression.test(line);
    };
  }
  const expected = caseSensitive ? pattern : pattern.toLowerCase();
  return (line) =>
    (caseSensitive ? line : line.toLowerCase()).includes(expected);
}

function boundedLimit(value, maximum, name) {
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${name} must be an integer from 1 through ${maximum}`);
  }
  return value;
}

function parseHistory(output, sourcePath) {
  if (!output) {
    return [];
  }
  const commits = [];
  let current;
  for (const line of output.split(/\r?\n/)) {
    if (line.includes("\x1f")) {
      const [sha, committedAt, subject] = line.split("\x1f");
      current = { sha, committedAt, subject, changedPath: sourcePath };
      commits.push(current);
    } else if (line.trim() && current) {
      current.changedPath = line.trim().split(path.sep).join("/");
    }
  }
  return commits;
}

function deduplicateErrors(errors) {
  const seen = new Set();
  return errors.filter((error) => {
    const key = `${error.path}\0${error.reason}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}
