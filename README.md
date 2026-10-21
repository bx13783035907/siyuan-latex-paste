# LaTeX Math Paste

Paste text containing LaTeX into SiYuan and get real math formulas.

Content copied from ChatGPT, Claude, arXiv, PDFs or Typora usually writes formulas as `\(E=mc^2\)`, `\[...\]` or `\begin{equation}...\end{equation}`. SiYuan doesn't understand those delimiters — you end up with raw backslashes. This plugin rewrites them into SiYuan's `$...$` / `$$...$$` syntax at paste time and lets SiYuan do the parsing.

## Conversion reference

| Pasted as | Becomes | Note |
| --- | --- | --- |
| `\(E=mc^2\)` | `$E=mc^2$` | Inline |
| `\[ E=mc^2 \]` | `$$` block | Display block when it stands on its own line |
| `where \[x=1\] holds` | `where $x=1$ holds` | Falls back to inline inside a paragraph, so the paragraph isn't split |
| `\begin{equation} … \end{equation}` | `$$` block | Environment name is preserved, KaTeX understands it |
| `\begin{align} … \end{align}` | `$$` block | Multi-line derivations, matrices |
| `$x^2+1=y$` | `$x^2+1=y$` | Already SiYuan syntax, left as-is; the plugin drops the HTML payload so SiYuan actually parses it |
| `$$ … $$` | unchanged | Already a formula, never wrapped twice |

## Copying out

SiYuan's own copy puts formulas on the clipboard as **bare LaTeX with no `$` delimiters** — paste that into Obsidian or Typora and it's just source text, not math.

With **Copy out as Markdown** enabled, copying formulas out of SiYuan restores the delimiters:

| In SiYuan | Copied out |
| --- | --- |
| Inline formula `dA` | `$dA$` |
| Block formula `E=mc^2` | `$$` block |
| The equation **E=mc²** is famous | `The equation **$E=mc^2$** is famous` |

Details:

- **Only selections containing formulas are touched.** Everything else keeps SiYuan's native behaviour.
- **`text/siyuan` is preserved**, so pasting back into SiYuan is still lossless (block IDs, refs, …). Only other apps get the Markdown.
- When copying from a rendered web page where the `$` are already gone, the plugin tries to recover the LaTeX from KaTeX / MathJax `<annotation>` nodes.

## Install

### From a build

1. `npm install && npm run build`
2. Copy everything inside `dist/` (`index.js`, `plugin.json`, `i18n/`, `icon.png`, `preview.png`) into
   `<SiYuan workspace>/data/plugins/siyuan-latex-paste/`
3. In SiYuan: Settings → Marketplace → Downloaded → enable "LaTeX Math Paste"

> Find your workspace in SiYuan under Settings → About → Workspace. It is not the installation directory.

### Development

1. Copy `.env.example` to `.env` and point it at your workspace:

   ```
   SIYUAN_WORKSPACE=C:/Users/you/SiYuan
   ```

2. `npm install`
3. `npm run dev` — the bundle goes straight into `<workspace>/data/plugins/siyuan-latex-paste` and rebuilds on change. Refresh the plugin in SiYuan to see the result.

## Settings

| Setting | Default | Effect |
| --- | --- | --- |
| Enable formula conversion | on | Master switch |
| Keep rich text formatting | on | Converts pasted HTML into Markdown first, preserving bold, lists and links. Turn off to handle plain-text pastes only. |
| Inline formulas `\( … \)` | on | Convert to `$ … $` |
| Display formulas `\[ … \]` | on | Convert to `$$ … $$` |
| LaTeX environments | on | Convert `equation`, `align`, `gather` … into `$$ … $$` |
| Markdown formulas `$ … $` | on | Also parse `$x^2+1=y$` as a formula |
| Copy out as Markdown | on | Restore `$` delimiters when copying formulas out of SiYuan, so other Markdown apps render them |
| Bare LaTeX | off | Detect undelimited formulas line by line. Experimental, may misfire. |
| Debug log | off | Log each paste to the console and toast on load — turn it on only when investigating something |

## If it doesn't work

**1. The directory name must match `name` in `plugin.json`.**

If `name` is `siyuan-latex-paste`, the folder must be `<workspace>/data/plugins/siyuan-latex-paste`. A mismatch means SiYuan never loads it — the most common failure.

**2. Confirm the plugin actually loaded.**

Turn on "Debug log" in the plugin settings, then restart. A "LaTeX 公式粘贴：已加载" toast appears on load, and each paste is logged to the console. No toast means it never started: check the folder name, restart SiYuan, and make sure you installed it into the workspace you're currently using (SiYuan supports multiple workspaces and plugins are per-workspace).

**3. Read the console.**

F12 → Console, then paste. You should see:

```
[latex-paste] 事件总线：改写载荷 {...}
[latex-paste] DOM 兜底：改写剪贴板 {...}
```

No output means either no formula was detected or the plugin isn't loaded.

## Three channels

The plugin covers all of these, as a safety net:

- **Event bus (paste)** — SiYuan's official `paste` hook. Gets a `protyle` instance, so its decisions are the most accurate. Broken below 3.8.0 when replacing the payload.
- **DOM capture (paste)** — rewrites `clipboardData` during the capture phase, independent of SiYuan's version. Can't see `protyle`, so context is inferred from the DOM.
- **DOM capture (copy)** — restores `$` delimiters when copying out of SiYuan. Only takes over when the selection actually contains a formula.

Both paste channels firing at once is harmless — conversion is idempotent.

## Behaviour notes

- **Code is never touched.** Pasting inside a code block, or writing `` `\(x\)` `` inline, is left alone.
- **Internal SiYuan copy/paste is skipped.** Formulas are already formulas there (they travel through `siyuanHTML`).
- **Pastes containing files are skipped.** The payload isn't rewritten, so images can't get lost.
- **Conversion is idempotent.** Pasting the same content twice won't stack delimiters.

## Known limitations

- PDFs sometimes split a formula across many `<span>` elements (one per glyph). The plugin then falls back to plain text — formulas stay correct, but minor inline formatting on that line is lost.
- Sites that render formulas as images or MathML carry no LaTeX source; nothing can be recovered there.
- Requires SiYuan 3.1.0+ (uses the plugin `paste` event bus).

## Development

```bash
npm run dev        # watch build, output into the workspace
npm run build      # one-off build into dist/
npm test           # unit + integration tests (31 cases)
npm run typecheck
```

Layout:

```
src/
  index.ts      # entry: paste hook, settings panel
  latex.ts      # delimiter → SiYuan formula (pure functions, easy to test)
  html.ts       # HTML → Markdown with formulas stashed as placeholders
  settings.ts   # setting definitions
  i18n/
test/
  latex.test.mjs   # conversion logic
  plugin.test.mjs  # integration: mocked SiYuan runtime, real paste pipeline
scripts/
  build.mjs / test.mjs / make-assets.mjs
```

## How it works

SiYuan exposes a `paste` event bus: a plugin can `preventDefault()` and hand back a rewritten clipboard payload through `resolve()`. But whenever the clipboard carries `text/html` — which web pages, Word and ChatGPT all do — SiYuan takes the HTML branch and the plain-text rewrite is ignored.

So when a formula is detected, the plugin converts the HTML to Markdown, blanks `textHTML`, and lets SiYuan's `Md2BlockDOM` parse the Markdown. Formulas are native SiYuan Markdown syntax, so what comes out are real formula nodes, not disguised text.

Turndown escapes backslashes (`\frac` → `\\frac`), so formulas are stashed as placeholders before conversion and restored afterwards.

## License

MIT
