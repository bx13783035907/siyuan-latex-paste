/**
 * HTML → Markdown，并把 LaTeX 公式先抽成占位符。
 *
 * 为什么不能直接转：Turndown 会把 LaTeX 里的反斜杠当 Markdown 转义符
 * （\frac → \\frac），公式就废了。所以先把公式片段换成占位符，
 * 转成 Markdown 之后再按原样还原成 $...$ / $$...$$。
 */

import { looksLikeMath } from "./latex";

export interface MathSegment {
  /** 原始 LaTeX（已去掉定界符） */
  latex: string;
  /** 是否块级公式 */
  display: boolean;
}

export interface StashResult {
  html: string;
  segments: MathSegment[];
}

const ENV_NAMES =
  "equation\\*?|align\\*?|alignat\\*?|flalign\\*?|gather\\*?|multline\\*?|eqnarray\\*?|displaymath|math";

/** 一条正则覆盖各种写法，用命名组区分类型 */
const MATH_IN_TEXT = new RegExp(
  [
    `\\$\\$(?<dollar>[\\s\\S]*?)\\$\\$`, // $$ ... $$
    // 定界符前的反斜杠要成奇数，\[ 才是定界符；\\[ 只是字面文本
    `(?<!\\\\)\\\\\\[(?<bracket>[\\s\\S]*?)(?<!\\\\)\\\\\\]`, // \[ ... \]
    `(?<!\\\\)\\\\\\((?<paren>[\\s\\S]*?)(?<!\\\\)\\\\\\)`, // \( ... \)
    `(?<!\\\\)\\\\begin\\{(?<envName>${ENV_NAMES})\\}(?<envBody>[\\s\\S]*?)(?<!\\\\)\\\\end\\{\\k<envName>\\}`,
    `(?<!\\\\)\\$(?<mdInline>[^$\\n]{1,200}?)\\$(?!\\d)`, // $ ... $
  ].join("|"),
  "gu",
);

const OPEN = "\uE000";
const CLOSE = "\uE001";

const token = (index: number) => `${OPEN}${index}${CLOSE}`;

export const HTML_TOKEN_RE = new RegExp(`${OPEN}(\\d+)${CLOSE}`, "g");

/** 把一段纯文本里的公式抽成占位符 */
function stashInText(text: string, segments: MathSegment[]): string {
  return text.replace(MATH_IN_TEXT, (matched, ...rest) => {
    const groups = (rest[rest.length - 1] ?? {}) as Record<string, string | undefined>;
    // 标签之间的文本还是 HTML 源码，< 写作 &lt;、& 写作 &amp;。
    // 公式被抽成占位符后就躲过了 Turndown 的实体解码，所以这里必须先还原，
    // 否则 |\zeta|&lt;1、align 里的 &amp; 会原封不动留在公式里。
    const dollar = decodeOne(groups.dollar);
    const bracket = decodeOne(groups.bracket);
    const paren = decodeOne(groups.paren);
    const envName = groups.envName;
    const envBody = decodeOne(groups.envBody);
    const mdInline = decodeOne(groups.mdInline);

    if (dollar !== undefined) {
      segments.push({ latex: dollar.trim(), display: true });
    } else if (bracket !== undefined) {
      segments.push({ latex: bracket.trim(), display: true });
    } else if (paren !== undefined) {
      segments.push({ latex: paren.trim(), display: false });
    } else if (envName !== undefined) {
      segments.push({ latex: `\\begin{${envName}}${envBody ?? ""}\\end{${envName}}`, display: true });
    } else if (mdInline !== undefined) {
      // $5 到 $10 这类不是公式，放过
      if (!looksLikeMath(mdInline.trim())) {
        return matched;
      }
      segments.push({ latex: mdInline.trim(), display: false });
    } else {
      return matched;
    }

    return token(segments.length - 1);
  });
}

function decodeOne(value: string | undefined): string | undefined {
  return value === undefined ? undefined : decodeEntities(value);
}

/**
 * 在 HTML 字符串上抽公式，只处理标签之间的文本片段。
 * PDF / 网页复制时公式有可能被拆进多个 span，这类情况这里抓不全，
 * 调用方需要用 textPlain 的公式数量做兜底判断。
 */
export function stashMathInHtml(html: string, segments: MathSegment[] = []): StashResult {
  if (!html) {
    return { html: "", segments };
  }

  // <br> 会把 \[ 和公式内容切成互不相干的文本片段，先摊平成换行
  // （从网页、ChatGPT 复制的块级公式经常是这样）
  const source = html.replace(/<br\s*\/?>/gi, "\n");

  let result = "";
  let cursor = 0;
  const tagRe = /<[^>]*>/g;
  let match: RegExpExecArray | null;

  while ((match = tagRe.exec(source)) !== null) {
    if (match.index > cursor) {
      result += stashInText(source.slice(cursor, match.index), segments);
    }
    result += match[0];
    cursor = match.index + match[0].length;
  }
  if (cursor < source.length) {
    result += stashInText(source.slice(cursor), segments);
  }

  return { html: result, segments };
}

/** 把 Markdown 里的占位符还原成思源公式 */
export function restoreMath(markdown: string, segments: MathSegment[]): string {
  if (!segments.length) {
    return markdown;
  }
  return markdown.replace(HTML_TOKEN_RE, (_matched, index: string) => {
    const segment = segments[Number(index)];
    if (!segment) {
      return "";
    }
    const body = segment.latex.replace(/(?<!\\)\$/g, "\\$");
    if (segment.display) {
      return `\n\n$$\n${body}\n$$\n\n`;
    }
    return `$${body}$`;
  });
}

/**
 * 公式节点的各种写法：思源的块级/行内，以及 KaTeX、MathJax 的渲染结果。
 *
 * 特意没放 `.render-node` —— 思源里嵌入块、数据库视图也是 render-node，
 * 一起匹配会把正常内容误当成公式替换掉。真正的公式块一定带 data-type 或 data-subtype。
 */
const MATH_NODE_SELECTOR = [
  '[data-type="NodeMathBlock"]',
  '[data-type="inline-math"]',
  '[data-subtype="math"]',
  "span.katex",
  "span.math",
].join(",");

/** 从公式节点里读 LaTeX 源码 */
function readLatex(node: HTMLElement): string {
  const own = node.getAttribute("data-content");
  if (own && own.trim()) {
    return decodeEntities(own).trim();
  }
  // KaTeX / MathJax 会把源码放在 annotation 里（从渲染过的网页复制时靠这个救回来）
  const annotation = node.querySelector('annotation[encoding="application/x-tex"]');
  if (annotation?.textContent?.trim()) {
    return decodeEntities(annotation.textContent).trim();
  }
  const child = node.querySelector("[data-content]");
  const nested = child?.getAttribute("data-content");
  if (nested && nested.trim()) {
    return decodeEntities(nested).trim();
  }
  return "";
}

function isDisplayNode(node: HTMLElement): boolean {
  const type = node.getAttribute("data-type") || "";
  if (type === "NodeMathBlock") {
    return true;
  }
  if (type === "inline-math") {
    return false;
  }
  if (node.classList.contains("katex") || node.classList.contains("math")) {
    return false;
  }
  return node.tagName === "DIV";
}

/**
 * 把 DOM 里的公式节点原地换成占位符，返回抽出来的公式。
 * 调用方拿到 segments 后走一遍 Markdown 转换，再用 restoreMath 还原成 $ … $ / $$ … $$。
 */
export function extractMathNodes(root: HTMLElement, segments: MathSegment[] = []): MathSegment[] {
  if (!root || typeof root.querySelectorAll !== "function") {
    return segments;
  }

  const nodes = Array.from(root.querySelectorAll(MATH_NODE_SELECTOR)) as HTMLElement[];

  for (const node of nodes) {
    // 外层节点顺手把内层一起换掉了，内层已经从树里脱离，不能再处理一遍
    if (!root.contains(node)) {
      continue;
    }
    const latex = readLatex(node);
    if (!latex) {
      continue;
    }
    segments.push({ latex, display: isDisplayNode(node) });
    node.replaceWith(document.createTextNode(token(segments.length - 1)));
  }
  return segments;
}

/**
 * 思源的「复制富文本」会把完整的块 HTML 塞进 text/html 的一个注释里（base64）。
 *
 * 外层的 HTML 只是给外部软件看的简化版，里面可能连公式节点都没有；
 * 真正的 data-content 躺在注释里。想还原公式就得往注释里翻。
 */
export function extractSiyuanComment(html: string): string {
  const match = /<!--data-siyuan='([A-Za-z0-9+/=\s]+)'-->/.exec(html);
  if (!match) {
    return "";
  }
  try {
    const binary = atob(match[1].replace(/\s+/g, ""));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return new TextDecoder("utf-8").decode(bytes);
  } catch {
    return "";
  }
}

/**
 * HTML 里有没有公式节点。
 *
 * 从渲染过的网页复制时，纯文本里的 $ 早就被吃掉了，光看文本是判断不出来的，
 * 得看 HTML 里有没有 KaTeX/MathJax 这类公式标记。
 */
export function hasMathNodes(html: string): boolean {
  if (!html) {
    return false;
  }
  return (
    html.includes('data-type="NodeMathBlock"') ||
    html.includes('data-type="inline-math"') ||
    html.includes('data-subtype="math"') ||
    html.includes('class="katex') ||
    html.includes('class="math') ||
    html.includes('encoding="application/x-tex"')
  );
}

/**
 * 还原 HTML 实体。
 *
 * 经过 DOM 序列化再转 Markdown 之后，公式里的 < 会变成 &lt;、& 会变成 &amp;
 * （比如 |\zeta|<1、align 环境的 &）。不还原的话 LaTeX 就废了。
 */
const ENTITIES: Record<string, string> = {
  lt: "<",
  gt: ">",
  amp: "&",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/**
 * 只认几个常见实体，不交给 DOM 解析。
 *
 * 用 textarea.innerHTML 那种写法看着省事，但公式里本来就可能出现裸 <，
 * 会被当成标签吃掉。一次正则扫完也不会有「替换出来的 &lt; 又被二次替换」的连锁问题。
 */
const ENTITY_RE = /&(lt|gt|amp|quot|apos|nbsp|#0*39|#x27);/gi;

export function decodeEntities(text: string): string {
  if (!text.includes("&")) {
    return text;
  }
  return text.replace(ENTITY_RE, (matched, name: string) => {
    const key = name.toLowerCase();
    if (key.startsWith("#")) {
      return "'";
    }
    return ENTITIES[key] ?? matched;
  });
}

/** 粗略去掉标签，用来统计公式数量 / 判断是否还有残留定界符 */
export function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]*>/g, "");
}
