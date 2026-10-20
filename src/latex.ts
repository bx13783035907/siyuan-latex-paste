/**
 * LaTeX 定界符 → 思源公式语法的纯文本转换。
 *
 * 思源（Lute / KaTeX）原生语法：
 *   行内公式   $E=mc^2$
 *   块级公式   $$
 *              E=mc^2
 *              $$
 *
 * 常见来源的写法（思源不认）：
 *   \( ... \)            LaTeX 标准行内
 *   \[ ... \]            LaTeX 标准块级
 *   \begin{equation} …   LaTeX 环境
 *   \begin{align} …
 *
 * 这个模块只处理字符串，不依赖 DOM，方便直接跑单元测试。
 */

export interface LatexConvertOptions {
  /** \( ... \)  →  $ ... $ */
  inline: boolean;
  /** \[ ... \]  →  $$ ... $$（独占行时用块级，夹在文字中间时降级为行内） */
  display: boolean;
  /** \begin{equation} / align / gather 等环境 → $$ ... $$ */
  environments: boolean;
  /** 无定界符的裸 LaTeX 行（实验性，默认关闭） */
  bare: boolean;
}

export interface LatexConvertResult {
  text: string;
  /** 实际转换掉的公式个数，0 表示内容没有变化 */
  count: number;
}

export const DEFAULT_OPTIONS: LatexConvertOptions = {
  inline: true,
  display: true,
  environments: true,
  bare: false,
};

/** 代码块 / 行内代码：这些区域里的内容一律不动 */
const CODE_SEGMENT = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`+[^`\n]*?`+)/g;

/** 已经是思源块级公式的内容，先整段保护起来 */
const DISPLAY_MATH = /\$\$[\s\S]*?\$\$/g;

/** KaTeX 认识、且通常独立成块的 LaTeX 环境 */
const ENV_NAMES =
  "equation\\*?|align\\*?|alignat\\*?|flalign\\*?|gather\\*?|multline\\*?|eqnarray\\*?|displaymath|math";

/**
 * 定界符前的反斜杠必须是「奇数个」，也就是没有被转义过。
 *
 * 内容一旦经过 Markdown 转义，\[ 会变成 \\\[，这时候它表示的是字面文本而不是定界符，
 * 再处理就会拼出 \$ … \$ 这种畸形结果。前面的 (?<!\\) 就是为了挡住这种情况。
 */
const ENV_RE = new RegExp(
  `(?<!\\\\)\\\\begin\\{(${ENV_NAMES})\\}([\\s\\S]*?)(?<!\\\\)\\\\end\\{\\1\\}`,
  "g",
);
const BRACKET_RE = /(?<!\\)\\\[([\s\S]*?)(?<!\\)\\\]/g;
const PAREN_RE = /(?<!\\)\\\(([\s\S]*?)(?<!\\)\\\)/g;

/** 裸 LaTeX 行的判定：必须是明确的数学命令，避免误伤路径、正则等普通文本 */
const BARE_LATEX_RE =
  /\\(frac|dfrac|tfrac|sqrt|sum|prod|int|iint|oint|lim|log|ln|exp|sin|cos|tan|alpha|beta|gamma|delta|theta|lambda|mu|sigma|omega|pi|infty|partial|nabla|cdot|times|div|leq|geq|neq|approx|equiv|in|notin|subset|cup|cap|forall|exists|rightarrow|Rightarrow|leftrightarrow|Leftrightarrow|begin|end)\b|\^\{|_\{/;

const PLACEHOLDER_OPEN = "\u0000";
const PLACEHOLDER_CLOSE = "\u0001";

const placeholder = (index: number) => `${PLACEHOLDER_OPEN}M${index}${PLACEHOLDER_CLOSE}`;

/** 生成行内公式。内容里的 $ 需要转义，否则会破坏定界。 */
function inlineMath(inner: string): string {
  const body = inner.trim();
  if (!body) {
    return "";
  }
  return `$${body.replace(/(?<!\\)\$/g, "\\$")}$`;
}

/** 生成块级公式，前后留空行让它独立成块 */
function blockMath(inner: string): string {
  const body = inner.replace(/^\s*\n+/, "").replace(/\n+\s*$/, "").trim();
  if (!body) {
    return "";
  }
  return `\n\n$$\n${body.replace(/(?<!\\)\$/g, "\\$")}\n$$\n\n`;
}

/**
 * 判断一个 \[ ... \] 是否独占一行。
 * 独占行 → 块级公式；夹在段落中间 → 行内公式（避免把一句话拆成三块）。
 */
function isStandalone(whole: string, offset: number, length: number): boolean {
  const before = whole.slice(0, offset);
  const after = whole.slice(offset + length);
  const lineStart = /(^|\n)[ \t]*$/.test(before);
  const lineEnd = /^[ \t]*(\n|$)/.test(after);
  return lineStart && lineEnd;
}

function wrapBareLine(line: string): string | null {
  const trimmed = line.trim();
  if (trimmed.length < 3 || trimmed.length > 500) {
    return null;
  }
  // 含中文、美元符号、markdown 结构符号的行不处理
  if (/[\u4e00-\u9fa5]/.test(trimmed) || trimmed.includes("$")) {
    return null;
  }
  if (/^(#|>|-|\*|\+|\||\d+\.|\[|\]|!\[)/.test(trimmed)) {
    return null;
  }
  if (!BARE_LATEX_RE.test(trimmed)) {
    return null;
  }
  return `\n\n$$\n${trimmed}\n$$\n\n`;
}

/** 处理一段「非代码」文本 */
function convertSegment(segment: string, options: LatexConvertOptions): LatexConvertResult {
  let count = 0;
  // 只有真的插入了块级公式才需要压缩空行，否则会把原文里连续空行也一起压掉
  let blockInserted = false;
  const stash: string[] = [];

  // 1. 先保护已经是块级公式的部分，避免二次包裹
  let text = segment.replace(DISPLAY_MATH, (matched) => {
    stash.push(matched);
    return placeholder(stash.length - 1);
  });

  // 2. LaTeX 环境
  if (options.environments) {
    text = text.replace(ENV_RE, (_matched, env: string, body: string) => {
      count++;
      blockInserted = true;
      return blockMath(`\\begin{${env}}${body}\\end{${env}}`);
    });
  }

  // 3. \[ ... \]
  if (options.display) {
    text = text.replace(BRACKET_RE, (matched, inner: string, offset: number, whole: string) => {
      count++;
      const standalone = isStandalone(whole, offset, matched.length);
      if (standalone) {
        blockInserted = true;
      }
      return standalone ? blockMath(inner) : inlineMath(inner);
    });
  }

  // 4. \( ... \)
  if (options.inline) {
    text = text.replace(PAREN_RE, (_matched, inner: string) => {
      count++;
      return inlineMath(inner);
    });
  }

  // 5. 裸 LaTeX（默认关闭，逐行判断）
  if (options.bare) {
    text = text
      .split("\n")
      .map((line) => {
        const wrapped = wrapBareLine(line);
        if (wrapped) {
          count++;
          blockInserted = true;
          return wrapped;
        }
        return line;
      })
      .join("\n");
  }

  // 6. 还原被保护的块级公式
  if (stash.length > 0) {
    text = text.replace(
      new RegExp(`${PLACEHOLDER_OPEN}M(\\d+)${PLACEHOLDER_CLOSE}`, "g"),
      (_matched, index: string) => stash[Number(index)],
    );
  }

  // 块级公式前后会堆出多余空行，压回最多一空行
  if (blockInserted) {
    text = text.replace(/\n{3,}/g, "\n\n");
  }

  return { text, count };
}

/**
 * 把文本里的 LaTeX 定界符转换成思源公式语法。
 * 代码块、行内代码、已有的 $$ 公式都会被跳过。
 */
export function convertLatex(input: string, options: LatexConvertOptions = DEFAULT_OPTIONS): LatexConvertResult {
  if (!input) {
    return { text: input, count: 0 };
  }

  const parts = input.split(CODE_SEGMENT);
  let count = 0;

  const output = parts.map((part, index) => {
    // split 带捕获组时，奇数位是代码段，原样保留
    if (index % 2 === 1) {
      return part;
    }
    const result = convertSegment(part, options);
    count += result.count;
    return result.text;
  });

  return { text: output.join(""), count };
}

/**
 * Markdown 公式定界符 $ ... $ / $$ ... $$ 的检测。
 *
 * 从 ChatGPT、Claude 复制的内容里公式常常已经写成 $x^2+1=y$，这是思源的原生语法，
 * 但因为剪贴板同时带了 HTML，思源会走 HTML 分支而不做 Markdown 解析，公式就只是普通文字。
 * 检测到这类公式时需要把 HTML 降级掉。
 */

/** 内容是否像数学式子，用来避免把 $5 到 $10 之类的金额误判成公式 */
export function looksLikeMath(content: string): boolean {
  if (!content || content.length > 300) {
    return false;
  }
  // 含中文基本不可能是公式
  if (/[\u4e00-\u9fa5]/.test(content)) {
    return false;
  }
  if (!/[A-Za-z0-9]/.test(content)) {
    return false;
  }
  // 有明确的数学符号，基本可以断定是公式
  if (/[\^_\\=<>+\-*/]/.test(content)) {
    return true;
  }
  // 短的纯字母数字组合也算：$dA$、$dz$、$x$ 这类单个变量/微分非常常见，
  // 但之前会被漏掉，导致思源不把它当公式。
  // 限长 3 个字符 + 不允许空格：再宽就会把 $hello$ 这类普通词也当成公式。
  if (content.length <= 3 && /^[A-Za-z0-9]+$/.test(content)) {
    return true;
  }
  return false;
}

const MD_DISPLAY_RE = /\$\$[\s\S]{1,2000}?\$\$/;
const MD_INLINE_RE = /(?<!\\)\$(?!\$)(?!\s)([^$\n]{1,200})(?<!\s)\$(?!\d)/g;

export function hasMarkdownMath(input: string): boolean {
  if (!input) {
    return false;
  }
  if (MD_DISPLAY_RE.test(input)) {
    return true;
  }
  const matches = input.match(MD_INLINE_RE);
  if (!matches) {
    return false;
  }
  return matches.some((matched) => looksLikeMath(matched.slice(1, -1)));
}

/** 快速判断内容里有没有值得处理的东西（宽松判断，只用来决定是否进入处理流程） */
export function hasLatexDelimiters(input: string): boolean {
  if (!input) {
    return false;
  }
  return /(?<!\\)\\(?:\(|\[|begin\{(?:equation|align|alignat|flalign|gather|multline|eqnarray|displaymath|math)\*?\})/.test(
    input,
  );
}

/** 统计公式个数，用于「HTML 转换是否丢公式」的兜底判断 */
export function countLatexDelimiters(input: string): number {
  if (!input) {
    return 0;
  }
  const paren = input.match(PAREN_RE)?.length ?? 0;
  const bracket = input.match(BRACKET_RE)?.length ?? 0;
  const env = input.match(ENV_RE)?.length ?? 0;
  return paren + bracket + env;
}
