/**
 * 集成测试：mock 思源运行环境，加载构建产物，模拟粘贴事件。
 * 目的是验证挂载点、拦截条件、载荷改写这些「接线」是否真的通。
 */
import test from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// 最小化的思源运行环境（DOM 部分用 jsdom，Turndown 依赖它）
const dom = new JSDOM("<!doctype html><html><body></body></html>");
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.DOMParser = dom.window.DOMParser;
globalThis.Node = dom.window.Node;
globalThis.HTMLElement = dom.window.HTMLElement;

const mockI18n = new Proxy({}, { get: (_t, key) => String(key) });

class MockPlugin {
  constructor() {
    this.i18n = mockI18n;
    this.listeners = new Map();
    this.stored = {};
    this.eventBus = {
      on: (type, listener) => this.listeners.set(type, listener),
      off: (type, listener) => {
        if (this.listeners.get(type) === listener) {
          this.listeners.delete(type);
        }
      },
    };
  }
  async loadData(key) {
    return this.stored[key] ?? null;
  }
  async saveData(key, value) {
    this.stored[key] = value;
  }
  addCommand() {}
  onLayoutReady() {}
}

class MockSetting {
  constructor(options) {
    this.options = options;
    this.items = [];
  }
  addItem(item) {
    this.items.push(item);
  }
}

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "siyuan") {
    return { Plugin: MockPlugin, Setting: MockSetting, showMessage: () => {} };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const require = Module.createRequire(import.meta.url);
const LatexPaste = require(path.join(root, "dist", "index.js"));
Module._load = originalLoad;

async function createPlugin(settings) {
  const plugin = new LatexPaste({});
  await plugin.onload();
  if (settings) {
    Object.assign(plugin.settings, settings);
  }
  const handler = plugin.listeners.get("paste");
  assert.ok(handler, "插件应该注册了 paste 监听");
  return { plugin, handler };
}

function firePaste(handler, payload) {
  let prevented = false;
  let resolved = null;
  const event = {
    detail: {
      protyle: { options: { mode: "wysiwyg" } },
      textHTML: "",
      textPlain: "",
      siyuanHTML: "",
      files: [],
      ...payload,
      resolve: (data) => {
        resolved = data;
      },
    },
    preventDefault: () => {
      prevented = true;
    },
  };
  handler(event);
  return { prevented, resolved };
}

test("纯文本里的行内公式被转换", async () => {
  const { handler } = await createPlugin();
  const { prevented, resolved } = firePaste(handler, {
    textPlain: "质能方程 \\(E=mc^2\\) 很著名",
  });
  assert.equal(prevented, true);
  assert.equal(resolved.textPlain, "质能方程 $E=mc^2$ 很著名");
});

test("带 HTML 的粘贴会清空 HTML 走 Markdown 解析", async () => {
  const { handler } = await createPlugin();
  const { prevented, resolved } = firePaste(handler, {
    textHTML: "<p>质能方程 <strong>\\(E=mc^2\\)</strong> 很著名</p>",
    textPlain: "质能方程 E=mc^2 很著名",
  });
  assert.equal(prevented, true);
  assert.equal(resolved.textHTML, "");
  assert.match(resolved.textPlain, /\$E=mc\^2\$/);
  assert.match(resolved.textPlain, /\*\*/, "加粗格式应该保留");
});

test("没有公式时不拦截，交回思源默认逻辑", async () => {
  const { handler } = await createPlugin();
  const { prevented, resolved } = firePaste(handler, {
    textPlain: "一段普通的文字，没有任何公式",
  });
  assert.equal(prevented, false);
  assert.equal(resolved, null);
});

test("思源内部复制的 siyuanHTML 不处理", async () => {
  const { handler } = await createPlugin();
  const { prevented } = firePaste(handler, {
    textPlain: "\\(x\\)",
    siyuanHTML: "<div data-type=\"NodeParagraph\"></div>",
  });
  assert.equal(prevented, false);
});

test("带附件的粘贴不接管，避免丢文件", async () => {
  const { handler } = await createPlugin();
  const { prevented } = firePaste(handler, {
    textPlain: "\\(x\\)",
    files: [{ name: "a.png" }],
  });
  assert.equal(prevented, false);
});

test("块级公式转换", async () => {
  const { handler } = await createPlugin();
  const { resolved } = firePaste(handler, {
    textPlain: "推导如下\n\n\\[a^2+b^2=c^2\\]\n\n证毕",
  });
  assert.match(resolved.textPlain, /\$\$\na\^2\+b\^2=c\^2\n\$\$/);
});

test("equation 环境转换", async () => {
  const { handler } = await createPlugin();
  const { resolved } = firePaste(handler, {
    textPlain: "\\begin{equation}\nE=mc^2\n\\end{equation}",
  });
  assert.match(resolved.textPlain, /\\begin\{equation\}/);
  assert.match(resolved.textPlain, /\$\$/);
});

test("总开关关闭时不处理", async () => {
  const { handler } = await createPlugin({ enabled: false });
  const { prevented } = firePaste(handler, { textPlain: "\\(x\\)" });
  assert.equal(prevented, false);
});

test("预览模式下不处理", async () => {
  const { handler } = await createPlugin();
  const { prevented } = firePaste(handler, {
    textPlain: "\\(x\\)",
    protyle: { options: { mode: "preview" } },
  });
  assert.equal(prevented, false);
});

test("关闭行内转换后 \\( \\) 保持原样", async () => {
  const { handler } = await createPlugin({ convertInline: false });
  const { prevented } = firePaste(handler, { textPlain: "\\(x\\)" });
  assert.equal(prevented, false);
});

test("卸载时注销监听", async () => {
  const { plugin } = await createPlugin();
  plugin.onunload();
  assert.equal(plugin.listeners.has("paste"), false);
});

// ---- Markdown 公式：思源原生语法，只需要把 HTML 降级掉 ----

test("带 HTML 的 Markdown 公式会被降级处理", async () => {
  const { handler } = await createPlugin();
  const { prevented, resolved } = firePaste(handler, {
    textHTML: "<p>方程 $x^2+1=y$ 成立</p>",
    textPlain: "方程 $x^2+1=y$ 成立",
  });
  assert.equal(prevented, true);
  assert.equal(resolved.textHTML, "");
  assert.match(resolved.textPlain, /\$x\^2\+1=y\$/, "公式原样保留，交给思源解析");
});

test("只有纯文本的 Markdown 公式不拦截，思源自己会解析", async () => {
  const { handler } = await createPlugin();
  const { prevented } = firePaste(handler, { textPlain: "方程 $x^2+1=y$ 成立" });
  assert.equal(prevented, false);
});

test("金额之类的 $ 不会被误判成公式", async () => {
  const { handler } = await createPlugin();
  const { prevented } = firePaste(handler, {
    textHTML: "<p>这本书 $5 到 $10 之间</p>",
    textPlain: "这本书 $5 到 $10 之间",
  });
  assert.equal(prevented, false);
});

test("关闭 Markdown 公式开关后不再处理 $ … $", async () => {
  const { handler } = await createPlugin({ markdownMath: false });
  const { prevented } = firePaste(handler, {
    textHTML: "<p>方程 $x^2+1=y$ 成立</p>",
    textPlain: "方程 $x^2+1=y$ 成立",
  });
  assert.equal(prevented, false);
});

// ---- 用户实测反馈的两个样例（回归） ----

test("行内 Markdown 公式里的 < 不会被转成实体", async () => {
  const { handler } = await createPlugin();
  const { prevented, resolved } = firePaste(handler, {
    textHTML: "<p>$\\D=\\{\\zeta\\in\\C:|\\zeta|&lt;1\\}$</p>",
    textPlain: "$\\D=\\{\\zeta\\in\\C:|\\zeta|<1\\}$",
  });
  assert.equal(prevented, true);
  assert.equal(resolved.textHTML, "");
  assert.equal(
    resolved.textPlain,
    "$\\D=\\{\\zeta\\in\\C:|\\zeta|<1\\}$",
    "公式原样保留，反斜杠不加倍、< 不变 &lt;",
  );
});

test("被 <br> 拆开的块级公式能正确还原成 $$", async () => {
  const { handler } = await createPlugin();
  const { resolved } = firePaste(handler, {
    textHTML: "<p>\\[<br>G_{\\D,0}(\\zeta)=\\log|\\zeta|.<br>\\]</p>",
    textPlain: "\\[ G_{\\D,0}(\\zeta)=\\log|\\zeta|. \\]",
  });
  assert.ok(
    resolved.textPlain.includes("G_{\\D,0}(\\zeta)=\\log|\\zeta|."),
    "公式内容原样保留",
  );
  assert.match(resolved.textPlain, /\$\$/);
  assert.doesNotMatch(resolved.textPlain, /\\\$/, "不应该出现 \\$ 这种畸形定界符");
});

test("单行块级公式不会被拆碎", async () => {
  const { handler } = await createPlugin();
  const { resolved } = firePaste(handler, {
    textHTML: "<p>\\[ G_{\\D,0}(\\zeta)=\\log|\\zeta|. \\]</p>",
    textPlain: "\\[ G_{\\D,0}(\\zeta)=\\log|\\zeta|. \\]",
  });
  assert.equal(
    resolved.textPlain,
    "\n\n$$\nG_{\\D,0}(\\zeta)=\\log|\\zeta|.\n$$\n\n",
  );
});

test("align 环境里的 &amp; 会还原成 &", async () => {
  const { handler } = await createPlugin();
  const { resolved } = firePaste(handler, {
    textHTML: "<p>\\begin{align}a &amp;= b \\\\ c &amp;= d\\end{align}</p>",
    textPlain: "\\begin{align}a &= b \\\\ c &= d\\end{align}",
  });
  assert.doesNotMatch(resolved.textPlain, /&amp;/);
  assert.match(resolved.textPlain, /a &= b/);
});

// ---- DOM 兜底路径 ----

function makeEditorTarget() {
  const container = document.createElement("div");
  container.className = "protyle-wysiwyg";
  const paragraph = document.createElement("p");
  container.appendChild(paragraph);
  document.body.appendChild(container);
  return paragraph;
}

function makeClipboard(payload) {
  const store = { ...payload };
  return {
    store,
    clipboardData: {
      types: Object.keys(store),
      getData: (type) => store[type] ?? "",
      setData: (type, value) => {
        store[type] = value;
      },
    },
  };
}

test("DOM 兜底会直接改写剪贴板", async () => {
  const { plugin } = await createPlugin();
  const target = makeEditorTarget();
  const clipboard = makeClipboard({
    "text/html": "<p>质能方程 \\(E=mc^2\\)</p>",
    "text/plain": "质能方程 \\(E=mc^2\\)",
  });
  plugin.onDomPaste({ ...clipboard, target });
  assert.equal(clipboard.store["text/html"], "", "HTML 被清空，思源才会走 Markdown 解析");
  assert.match(clipboard.store["text/plain"], /\$E=mc\^2\$/);
});

test("DOM 兜底认得 Markdown 公式", async () => {
  const { plugin } = await createPlugin();
  const target = makeEditorTarget();
  const clipboard = makeClipboard({
    "text/html": "<p>方程 $x^2+1=y$ 成立</p>",
    "text/plain": "方程 $x^2+1=y$ 成立",
  });
  plugin.onDomPaste({ ...clipboard, target });
  assert.equal(clipboard.store["text/html"], "");
  assert.match(clipboard.store["text/plain"], /\$x\^2\+1=y\$/);
});

test("DOM 兜底跳过思源内部复制", async () => {
  const { plugin } = await createPlugin();
  const target = makeEditorTarget();
  const clipboard = makeClipboard({
    "text/siyuan": "<div data-type=\"NodeParagraph\">x</div>",
    "text/plain": "\\(x\\)",
  });
  plugin.onDomPaste({ ...clipboard, target });
  assert.equal(clipboard.store["text/plain"], "\\(x\\)", "原样不动");
});

test("DOM 兜底只在编辑器内生效", async () => {
  const { plugin } = await createPlugin();
  const outside = document.createElement("input");
  document.body.appendChild(outside);
  const clipboard = makeClipboard({
    "text/html": "<p>\\(x\\)</p>",
    "text/plain": "\\(x\\)",
  });
  plugin.onDomPaste({ ...clipboard, target: outside });
  assert.equal(clipboard.store["text/plain"], "\\(x\\)", "编辑器外的粘贴不碰");
});

test("纯文本里 $ 已丢失时，能从 KaTeX 渲染结果里救回公式", async () => {
  const { handler } = await createPlugin();
  const { prevented, resolved } = firePaste(handler, {
    textHTML:
      '<p>记 <span class="katex"><span class="katex-mathml"><math><semantics><mrow><mi>d</mi><mi>A</mi></mrow></semantics></math></span><annotation encoding="application/x-tex">dA</annotation></span> 为面积测度</p>',
    textPlain: "记 dA 为面积测度",
  });
  assert.equal(prevented, true);
  assert.match(resolved.textPlain, /\$dA\$/, "公式应该被补回 $ 定界符");
});

test("HTML 里没公式时回退纯文本，不能把公式丢掉", async () => {
  const { handler } = await createPlugin();
  const { resolved } = firePaste(handler, {
    textHTML: "<p>由 x 可得</p>",
    textPlain: "由 \\(x\\) 可得",
  });
  assert.ok(resolved, "应该接管");
  assert.match(resolved.textPlain, /\$x\$/, "公式来自纯文本，不能被 HTML 覆盖掉");
});

// ---- 复制通道：思源 → 其他 Markdown 软件 ----

function makeCopyTarget(html) {
  const container = document.createElement("div");
  container.className = "protyle-wysiwyg";
  container.innerHTML = html;
  document.body.appendChild(container);
  return container;
}

/** 临时把选区指向 element，跑完还原 */
function withSelection(element, fn) {
  const range = document.createRange();
  range.selectNodeContents(element);
  const selection = { rangeCount: 1, isCollapsed: false, getRangeAt: () => range };
  const original = dom.window.getSelection;
  dom.window.getSelection = () => selection;
  try {
    return fn();
  } finally {
    dom.window.getSelection = original;
  }
}

/**
 * 替换 navigator.clipboard。
 *
 * 注意不能写成 Object.defineProperty(globalThis.navigator, ...)：
 * globalThis.navigator 是 Node 21 才加的全局对象，Node 20 上它是 undefined，
 * 直接 defineProperty 会抛 TypeError。
 */
function mockClipboard(writeText) {
  Object.defineProperty(globalThis, "navigator", {
    value: { clipboard: { writeText } },
    configurable: true,
    writable: true,
  });
}

function fireCopy(plugin) {
  const store = {};
  let prevented = false;
  const clipboardData = {
    types: [],
    getData: (type) => store[type] ?? "",
    setData: (type, value) => {
      store[type] = value;
    },
  };
  plugin.onCopy({
    clipboardData,
    preventDefault: () => {
      prevented = true;
    },
  });
  return { prevented, store };
}

test("复制行内公式时补上 $ 定界符", async () => {
  const { plugin } = await createPlugin();
  const container = makeCopyTarget(
    '<div contenteditable="true">记 <span data-type="inline-math" data-content="dA">dA</span> 为面积测度</div>',
  );
  const { prevented, store } = withSelection(container, () => fireCopy(plugin));
  assert.equal(prevented, true);
  assert.equal(store["text/html"], undefined, "不写 HTML 层，目标软件只能按 Markdown 源码接收");
  assert.match(store["text/plain"], /\$dA\$/);
});

test("复制块级公式时补上 $$ 定界符", async () => {
  const { plugin } = await createPlugin();
  const container = makeCopyTarget(
    '<div data-type="NodeMathBlock" data-content="E=mc^2"><div class="protyle-attr">x</div></div>',
  );
  const { prevented, store } = withSelection(container, () => fireCopy(plugin));
  assert.equal(prevented, true);
  assert.match(store["text/plain"], /\$\$\nE=mc\^2\n\$\$/);
});

test("KaTeX 渲染结果也能还原出 LaTeX", async () => {
  const { plugin } = await createPlugin();
  const container = makeCopyTarget(
    '<span class="katex"><annotation encoding="application/x-tex">\\frac{a}{b}</annotation></span>',
  );
  const { prevented, store } = withSelection(container, () => fireCopy(plugin));
  assert.equal(prevented, true);
  assert.match(store["text/plain"], /\$\\frac\{a\}\{b\}\$/);
});

test("复制时保留 text/siyuan，思源内部粘贴不受影响", async () => {
  const { plugin } = await createPlugin();
  const container = makeCopyTarget(
    '<div data-type="NodeMathBlock" data-content="E=mc^2"><div class="protyle-attr">x</div></div>',
  );
  const { store } = withSelection(container, () => fireCopy(plugin));
  assert.match(store["text/siyuan"], /NodeMathBlock/);
});

test("没有公式的复制完全不动，交回思源原生行为", async () => {
  const { plugin } = await createPlugin();
  const container = makeCopyTarget('<div contenteditable="true">一段普通文字</div>');
  const { prevented, store } = withSelection(container, () => fireCopy(plugin));
  assert.equal(prevented, false);
  assert.equal(store["text/plain"], undefined);
});

test("关闭复制开关后不接管", async () => {
  const { plugin } = await createPlugin({ copyAsMarkdown: false });
  const container = makeCopyTarget(
    '<div data-type="NodeMathBlock" data-content="E=mc^2"></div>',
  );
  const { prevented } = withSelection(container, () => fireCopy(plugin));
  assert.equal(prevented, false);
});

test("公式节点藏在 data-siyuan 注释里时也能还原", async () => {
  const { plugin } = await createPlugin();
  // 思源「复制富文本」的真实形态：外层只是简化文本，完整块结构在注释的 base64 里
  const blockHtml =
    '<div data-type="NodeParagraph"><div contenteditable="true">Since ' +
    '<span data-type="inline-math" data-subtype="math" data-content="f\\circ R_\\theta">' +
    '<span class="katex">f∘Rθ</span></span> is holomorphic</div>' +
    '<div class="protyle-attr" contenteditable="false">🏷️</div></div>';
  const encoded = Buffer.from(blockHtml, "utf8").toString("base64");
  const outerHtml = `<!--data-siyuan='${encoded}'--><p>Since f∘Rθ is holomorphic</p>`;

  const container = makeCopyTarget(outerHtml);
  const { prevented, store } = withSelection(container, () => fireCopy(plugin));

  assert.equal(prevented, true);
  assert.match(store["text/plain"], /\$f\\circ R_\\theta\$/, "LaTeX 应该从 data-content 还原出来");
  assert.doesNotMatch(store["text/plain"], /🏷/, "块图标不该被转进正文");
});

test("真实块结构：行内 + 块级公式混排", async () => {
  const { plugin } = await createPlugin();
  const inline = (latex, rendered) =>
    `<span data-type="inline-math" data-subtype="math" data-content="${latex}" contenteditable="false" class="render-node" data-render="true">` +
    `<span class="katex"><span class="katex-html">${rendered}</span></span></span>`;

  const container = makeCopyTarget(
    '<div data-node-id="a" data-type="NodeParagraph" class="p"><div contenteditable="true">' +
      `Since ${inline("f\\\\circ R_\\\\theta", "f∘Rθ")} is holomorphic` +
      '</div><div class="protyle-attr">🏷️</div></div>' +
      '<div data-node-id="b" data-type="NodeMathBlock" class="render-node" data-content="\\\\begin{aligned}a&amp;=b\\\\end{aligned}">' +
      '<span class="katex-display"><span class="katex">渲染</span></span>' +
      '<div class="protyle-attr">🏷️</div></div>',
  );
  const { store } = withSelection(container, () => fireCopy(plugin));

  assert.match(store["text/plain"], /Since \$f\\\\circ R_\\\\theta\$ is holomorphic/);
  assert.match(store["text/plain"], /\$\$\n\\\\begin\{aligned\}a&=b\\\\end\{aligned\}\n\$\$/);
  assert.doesNotMatch(store["text/plain"], /<span|<div|&amp;|🏷/);
});

test("复制结果里不能混进 HTML 标签", async () => {
  const { plugin } = await createPlugin();
  const container = makeCopyTarget(
    '<div data-type="NodeParagraph"><div contenteditable="true">Since ' +
      '<span data-type="inline-math" data-subtype="math" data-content="f\\circ R_\\theta" class="render-node">' +
      '<span class="language-math">f∘Rθ</span></span> is holomorphic</div></div>',
  );
  // 就算环境里有 Lute，也不该相信它吐出来的东西
  const original = dom.window.Lute;
  dom.window.Lute = { New: () => ({ BlockDOM2Md: () => '<span class="language-math">$x$</span>' }) };
  const { store } = withSelection(container, () => fireCopy(plugin));
  dom.window.Lute = original;

  assert.doesNotMatch(store["text/plain"], /<span|<div|&amp;/, "不能贴出一堆 HTML 标签");
  assert.match(store["text/plain"], /\$f\\circ R_\\theta\$/);
});

test("嵌入块（render-node）不会被误当成公式", async () => {
  const { plugin } = await createPlugin();
  const container = makeCopyTarget(
    '<div class="render-node" data-subtype="database" data-content="SELECT * FROM blocks"><div>查询结果</div></div>' +
      '<span data-type="inline-math" data-content="x">x</span>',
  );
  const { store } = withSelection(container, () => fireCopy(plugin));
  assert.doesNotMatch(store["text/plain"], /SELECT/, "嵌入块的内容不该被塞进公式");
  assert.match(store["text/plain"], /\$x\$/, "真正的公式照常处理");
});

test("选区里有图片时不接管复制，避免丢图", async () => {
  const { plugin } = await createPlugin();
  const container = makeCopyTarget(
    '<div data-type="NodeParagraph"><span data-type="inline-math" data-content="x">x</span><img src="assets/a.png"></div>',
  );
  const { prevented } = withSelection(container, () => fireCopy(plugin));
  assert.equal(prevented, false);
});

test("块图标菜单里会出现复制为 Markdown", async () => {
  const { plugin } = await createPlugin();
  const handler = plugin.listeners.get("click-blockicon");
  assert.ok(handler, "应该注册了 click-blockicon");

  const block = document.createElement("div");
  block.setAttribute("data-type", "NodeParagraph");
  block.innerHTML =
    'Since <span data-type="inline-math" data-subtype="math" data-content="f\\circ R_\\theta">f∘Rθ</span> is holomorphic';

  const items = [];
  handler({
    detail: { blockElements: [block], menu: { addItem: (item) => items.push(item) } },
  });

  assert.equal(items.length, 1);
  assert.equal(items[0].label, "commandCopyAsMarkdown");
});

test("块图标菜单点击后写入带 $ 的 Markdown", async () => {
  const { plugin } = await createPlugin();
  const handler = plugin.listeners.get("click-blockicon");

  const block = document.createElement("div");
  block.setAttribute("data-type", "NodeParagraph");
  block.innerHTML =
    'Since <span data-type="inline-math" data-subtype="math" data-content="f\\circ R_\\theta">f∘Rθ</span> is holomorphic';
  const attr = document.createElement("div");
  attr.className = "protyle-attr";
  attr.textContent = "🏷️";
  block.appendChild(attr);

  const items = [];
  handler({
    detail: { blockElements: [block], menu: { addItem: (item) => items.push(item) } },
  });

  let written = null;
  mockClipboard(async (text) => {
    written = text;
  });
  await items[0].click();

  assert.match(written, /\$f\\circ R_\\theta\$/, "行内公式要带 $ 定界符");
  assert.doesNotMatch(written, /🏷/, "块图标不能混进正文");
});

test("右键菜单里有复制为 Markdown", async () => {
  const { plugin } = await createPlugin();
  const handler = plugin.listeners.get("open-menu-content");
  assert.ok(handler, "应该注册了 open-menu-content");

  const container = makeCopyTarget(
    '<div data-type="NodeParagraph"><div contenteditable="true">Since ' +
      '<span data-type="inline-math" data-content="x">x</span> is holomorphic</div></div>',
  );
  const range = document.createRange();
  range.selectNodeContents(container);

  const items = [];
  handler({ detail: { range, menu: { addItem: (item) => items.push(item) } } });

  assert.equal(items.length, 1);
  assert.equal(items[0].label, "commandCopyAsMarkdown");
});

test("选区里没有公式时右键菜单不挂这一项", async () => {
  const { plugin } = await createPlugin();
  const handler = plugin.listeners.get("open-menu-content");

  const container = makeCopyTarget('<div data-type="NodeParagraph">一段普通文字</div>');
  const range = document.createRange();
  range.selectNodeContents(container);

  const items = [];
  handler({ detail: { range, menu: { addItem: (item) => items.push(item) } } });

  assert.equal(items.length, 0, "没公式就别往菜单里塞");
});

test("右键菜单点击后写入带 $ 的 Markdown", async () => {
  const { plugin } = await createPlugin();
  const handler = plugin.listeners.get("open-menu-content");

  const container = makeCopyTarget(
    '<div data-type="NodeParagraph"><div contenteditable="true">Since ' +
      '<span data-type="inline-math" data-content="f\\circ R_\\theta">f∘Rθ</span> is holomorphic</div></div>',
  );
  const range = document.createRange();
  range.selectNodeContents(container);

  const items = [];
  handler({ detail: { range, menu: { addItem: (item) => items.push(item) } } });

  let written = null;
  mockClipboard(async (text) => {
    written = text;
  });
  await items[0].click();

  assert.match(written, /Since \$f\\circ R_\\theta\$ is holomorphic/);
});

test("编辑器外的复制不处理", async () => {
  const { plugin } = await createPlugin();
  const outside = document.createElement("div");
  outside.innerHTML = '<span data-type="inline-math" data-content="x">x</span>';
  document.body.appendChild(outside);
  const { prevented } = withSelection(outside, () => fireCopy(plugin));
  assert.equal(prevented, false);
});
