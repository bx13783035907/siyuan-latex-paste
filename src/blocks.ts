/**
 * 把思源的块 DOM 翻译成标准 HTML 标签。
 *
 * Turndown 只认 `<ul>` / `<li>` / `<h2>` / `<blockquote>` 这些标准标签，
 * 而思源用的是 `<div data-type="NodeList">`、`<div data-type="NodeHeading">`。
 * 不翻译的话，复制出去的列表、标题、引用会**全部退化成没有标记的纯文本段落** ——
 * 粘到 Obsidian 里层级和结构都没了。
 *
 * 翻译是「重建」而不是「原地改」：思源 DOM 里还混着 protyle-action（列表圆点、
 * 代码块语言选择器）、contenteditable 包装层这些纯编辑器痕迹，重建时顺手剔掉。
 *
 * 注意：公式节点在进来之前已经被换成**文本节点**形式的占位符（见 html.ts），
 * 所以这里遍历子节点必须用 childNodes 而不是 children —— 用 children 会把
 * 列表项里的块级公式整条吞掉。
 */

const HEADING_RE = /^h[1-6]$/;

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

/** 行内标记：思源用 span[data-type] 表达的那些格式 */
const INLINE_MARK_TAGS: Record<string, string> = {
  strong: "strong",
  em: "em",
  code: "code",
  s: "s",
  del: "s",
  strikethrough: "s",
  u: "u",
  mark: "mark",
  highlight: "mark",
  sup: "sup",
  sub: "sub",
  kbd: "kbd",
};

/** 纯编辑器装饰，没有任何正文含义 */
const CHROME_CLASSES = ["protyle-attr", "protyle-icons"];

/** protyle-action 里唯一有语义的是任务列表的复选框，其余都是装饰 */
function pickCheckbox(action: HTMLElement): HTMLInputElement | null {
  const input = action.querySelector('input[type="checkbox"]');
  return input ? (input.cloneNode(true) as HTMLInputElement) : null;
}

/**
 * 翻译单个子节点。
 *
 * `unwrapParagraph` 用于列表项内部：那里的 `<p>` 会被 Turndown 撑成空行，
 * 一条紧凑列表会散成一堆独立段落，所以直接拆包装。
 */
function translateChild(node: Node, dest: Node, unwrapParagraph: boolean): void {
  if (node.nodeType === TEXT_NODE) {
    // 占位符（公式）就是走这条路进来的，一个都不能漏
    dest.appendChild(node.cloneNode(true));
    return;
  }
  if (node.nodeType !== ELEMENT_NODE) {
    return;
  }

  const el = node as HTMLElement;
  const cls = el.classList;

  for (const chrome of CHROME_CLASSES) {
    if (cls.contains(chrome)) {
      return;
    }
  }
  if (cls.contains("protyle-action")) {
    const box = pickCheckbox(el);
    if (box) {
      dest.appendChild(box);
    }
    return;
  }

  const type = el.getAttribute("data-type") ?? "";

  if (unwrapParagraph && type === "NodeParagraph") {
    translateChildren(el, dest, unwrapParagraph);
    return;
  }

  const mapped = mapElement(el);
  if (mapped) {
    dest.appendChild(mapped);
    return;
  }

  // contenteditable 只是可编辑包装层，去掉这层，否则 Turndown 会当成独立块，
  // 每段之间多出空行。放在 mapElement 之后：万一某个块节点自身带 contenteditable，
  // 也要先按块类型翻译，别被这层剥没了
  if (el.getAttribute("contenteditable") === "true") {
    const frag = document.createDocumentFragment();
    translateChildren(el, frag, unwrapParagraph);
    dest.appendChild(frag);
    return;
  }

  const mark = convertInlineMark(el);
  if (mark) {
    dest.appendChild(mark);
    return;
  }

  // 不认识的容器（表格、SuperBlock、图片等）：保留原标签和属性，只翻译内容
  const clone = el.cloneNode(false) as HTMLElement;
  translateChildren(el, clone, unwrapParagraph);
  dest.appendChild(clone);
}

function translateChildren(src: ParentNode, dest: Node, unwrapParagraph = false): void {
  for (const child of Array.from(src.childNodes)) {
    translateChild(child, dest, unwrapParagraph);
  }
}

/**
 * 思源的行内标记：`<span data-type="strong">粗</span>` 这类。
 *
 * Turndown 只认 `<strong>` / `<em>` 这些标准标签，看到 span + data-type
 * 一律当普通文字，加粗、行内代码、高亮、链接会**全部丢格式**变成纯文本。
 * 返回 null 表示这不是行内标记，交给后面的通用分支处理。
 */
function convertInlineMark(el: HTMLElement): Node | null {
  const type = (el.getAttribute("data-type") ?? "").toLowerCase();
  if (!type) {
    return null;
  }

  if (type === "a") {
    const href = el.getAttribute("data-href") ?? el.getAttribute("href") ?? "";
    const link = document.createElement("a");
    if (href) {
      link.setAttribute("href", href);
    }
    translateChildren(el, link);
    return link;
  }

  // 思源的标签在编辑器里是个小胶囊，Markdown 里对应 #标签#。
  // 粘到 Obsidian 就是真标签，不留 # 的话只剩一串普通文字
  if (type === "tag") {
    const name = (el.textContent ?? "").trim().replace(/^#+/, "").replace(/#+$/, "");
    return document.createTextNode(name ? `#${name}#` : "");
  }

  const tag = INLINE_MARK_TAGS[type];
  if (tag) {
    const out = document.createElement(tag);
    translateChildren(el, out);
    return out;
  }

  // 其余行内节点（标签、块引用、着色文字……）剥掉外壳只留文字。
  // Markdown 表达不了这些东西，但正文不能丢
  const frag = document.createDocumentFragment();
  translateChildren(el, frag);
  return frag;
}

function mapElement(el: HTMLElement): Node | null {
  switch (el.getAttribute("data-type") ?? "") {
    case "NodeParagraph":
      return convertParagraph(el);
    case "NodeHeading":
      return convertHeading(el);
    case "NodeBlockquote":
      return convertBlockquote(el);
    // 引述块（Callout）在思源里是个带图标标题的卡片，Markdown 没有对应语法。
    // 降成引用块最接近：内容保住、视觉上仍是「缩进的旁注」，粘到哪儿都读得通
    case "NodeCallout":
      return convertBlockquote(el);
    case "NodeList":
      return convertList(el);
    case "NodeListItem":
      return convertListItem(el);
    case "NodeCodeBlock":
      return convertCodeBlock(el);
    case "NodeThematicBreak": {
      return document.createElement("hr");
    }
    // 正常流程里 extractMathNodes 已经把它们换成占位符，根本走不到这里。
    // 能走到说明 data-content 是空的，剩下的是 KaTeX 渲染出来的符号堆，
    // 直接丢掉比把乱码转进正文强。
    case "NodeMathBlock":
    case "inline-math":
      return document.createTextNode("");
    default:
      return null;
  }
}

function convertParagraph(el: HTMLElement): Node {
  // 表格单元格里的段落绝不能包成 <p>：GFM 表格规则取单元格内容时，
  // 段落会带出换行，把一行表格撑成多行，整张表就废了
  if (el.closest("td, th")) {
    const frag = document.createDocumentFragment();
    translateChildren(el, frag);
    return frag;
  }
  const p = document.createElement("p");
  translateChildren(el, p);
  return p;
}

function convertHeading(el: HTMLElement): HTMLElement {
  const sub = (el.getAttribute("data-subtype") ?? "").toLowerCase();
  const heading = document.createElement(HEADING_RE.test(sub) ? sub : "h2");
  translateChildren(el, heading);
  return heading;
}

function convertBlockquote(el: HTMLElement): HTMLElement {
  const quote = document.createElement("blockquote");
  translateChildren(el, quote);
  return quote;
}

/**
 * 思源的列表：`data-subtype` 是 `u`（无序）/ `o`（有序）/ `t`（任务）。
 * 任务列表先按无序处理，复选框由 Turndown 的 GFM 插件转成 `- [ ]`。
 */
function convertList(el: HTMLElement): HTMLElement {
  const sub = el.getAttribute("data-subtype") ?? "u";
  const list = document.createElement(sub === "o" ? "ol" : "ul");

  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === TEXT_NODE) {
      // 列表标签下不该有裸文本，但公式占位符有可能落在这儿，丢了不如留着
      if (child.textContent?.trim()) {
        list.appendChild(child.cloneNode(true));
      }
      continue;
    }
    if (child.nodeType !== ELEMENT_NODE) {
      continue;
    }
    const item = child as HTMLElement;
    if (item.getAttribute("data-type") === "NodeListItem") {
      list.appendChild(convertListItem(item));
      continue;
    }
    translateChild(item, list, true);
  }
  return list;
}

function convertListItem(el: HTMLElement): HTMLLIElement {
  const li = document.createElement("li");
  translateChildren(el, li, true);
  return li;
}

/** 代码块用 textContent 整体取：高亮会把代码拆成一堆 span，逐个翻译会串味 */
function convertCodeBlock(el: HTMLElement): HTMLElement {
  const lang = (el.getAttribute("data-subtype") ?? "").trim();
  const source = el.querySelector(".hljs, [contenteditable='true']") ?? el;
  const pre = document.createElement("pre");
  const code = document.createElement("code");
  if (lang) {
    code.className = `language-${lang}`;
  }
  code.textContent = source.textContent ?? "";
  pre.appendChild(code);
  return pre;
}

/** 入口：返回一个全新的容器，内容已全部换成标准 HTML 标签 */
export function renderSiyuanBlocks(root: HTMLElement): HTMLElement {
  const out = document.createElement("div");
  translateChildren(root, out);
  return out;
}
