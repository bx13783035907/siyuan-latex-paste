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
  addCommand(command) {
    // 记录下来，测试里可以直接触发「复制为 Markdown」命令
    (this.commands ||= []).push(command);
  }
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

/** 模拟「光标停在某个节点上、没有选中任何文字」 */
function withCaret(node, fn) {
  const selection = {
    rangeCount: 1,
    isCollapsed: true,
    anchorNode: node,
    getRangeAt: () => null,
  };
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

test("跨多个块复制：每条 data-siyuan 注释里的公式都要还原", async () => {
  const { plugin } = await createPlugin();
  // 选区内有几个块，思源就给几条注释。只解第一条会把后面几个块的公式整段漏掉。
  const blockA =
    '<div data-type="NodeParagraph"><div contenteditable="true">First ' +
    '<span data-type="inline-math" data-subtype="math" data-content="a_1">a₁</span></div></div>';
  const blockB =
    '<div data-type="NodeParagraph"><div contenteditable="true">Second ' +
    '<span data-type="inline-math" data-subtype="math" data-content="b_2">b₂</span></div></div>';
  const outerHtml =
    `<!--data-siyuan='${Buffer.from(blockA, "utf8").toString("base64")}'--><p>First a₁</p>` +
    `<!--data-siyuan='${Buffer.from(blockB, "utf8").toString("base64")}'--><p>Second b₂</p>`;

  const container = makeCopyTarget(outerHtml);
  const { store } = withSelection(container, () => fireCopy(plugin));

  assert.match(store["text/plain"], /\$a_1\$/, "第一块的公式要还原");
  assert.match(store["text/plain"], /\$b_2\$/, "第二块的公式同样要还原");
});

test("文本里的 &#10; 实体要还原成真正的换行", async () => {
  const { handler } = await createPlugin();
  const { resolved } = firePaste(handler, {
    textHTML: "<p>$$a=1&#10;b=2$$</p>",
    textPlain: "$$a=1 b=2$$",
  });

  assert.match(resolved.textPlain, /a=1\nb=2/, "&#10; 应该变成换行，否则多行公式会挤成一行");
  assert.doesNotMatch(resolved.textPlain, /&#10;/, "不能把实体原样留在公式里");
});

test("单引号属性 / katex-display 也能识别并救回公式", async () => {
  const { handler } = await createPlugin();
  // 网页里的 HTML 常用单引号，class 也可能带后缀，判定太严就会整个粘贴失效
  const { resolved } = firePaste(handler, {
    textHTML:
      "<p><span class='katex-display'><span class='katex'>" +
      "<annotation encoding='application/x-tex'>x^2</annotation></span></span></p>",
    textPlain: "x2",
  });

  assert.ok(resolved, "应该被插件接管");
  assert.match(resolved.textPlain, /\$x\^2\$/, "应该从 annotation 里救回 LaTeX");
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

// ---- 多窗口：加载期间绝对不能写插件存储 ----

test("onload 期间不写插件存储（否则多窗口会反复重载）", async () => {
  const plugin = new LatexPaste({});
  await plugin.onload();

  assert.deepEqual(
    Object.keys(plugin.stored),
    [],
    "onload 里 saveData 会写入 petal 目录，思源把变更广播给所有窗口，" +
      "每个窗口的插件随之重载并再次写入，形成无限重启",
  );
  assert.equal(plugin.settings.debug, false, "调试日志默认关闭，正式版不该持续写盘");
});

test("注册失败但没有开调试时，也不写诊断", async () => {
  const plugin = new LatexPaste({});
  // addTopBar 抛错，制造一个 FAIL 步骤
  plugin.addTopBar = () => {
    throw new Error("boom");
  };
  await plugin.onload();

  assert.deepEqual(
    Object.keys(plugin.stored),
    [],
    "调试开关关闭时，即使有注册失败也不该落盘",
  );
});

// ---- 结构化内容：列表 / 标题 / 引用 / 代码块 ----
// 思源用 div[data-type=NodeList] 这类自定义标签表达结构，Turndown 只认标准标签。
// 没有 blocks.ts 那层翻译的话，这些结构复制出去会退化成纯文本段落。

const inlineMath = (latex, shown) =>
  `<span data-type="inline-math" data-subtype="math" data-content="${latex}">${shown}</span>`;

test("列表复制保留 - 标记和嵌套缩进", async () => {
  const { plugin } = await createPlugin();
  const container = makeCopyTarget(
    '<div data-type="NodeList" data-subtype="u">' +
      '<div data-type="NodeListItem">' +
      '<div class="protyle-action"></div>' +
      '<div data-type="NodeParagraph"><div contenteditable="true">第一项</div></div>' +
      '<div data-type="NodeList" data-subtype="u"><div data-type="NodeListItem">' +
      '<div class="protyle-action"></div>' +
      `<div data-type="NodeParagraph"><div contenteditable="true">嵌套 ${inlineMath("x^2", "x²")}</div></div>` +
      "</div></div></div></div>",
  );
  const { store } = withSelection(container, () => fireCopy(plugin));
  const md = store["text/plain"];

  assert.match(md, /^-\s+第一项/m, "列表项要带 - 标记");
  assert.match(md, /^\s+-\s+嵌套 \$x\^2\$/m, "嵌套项要缩进，公式也要还原");
  assert.doesNotMatch(md, /^- {2,}/m, "标记后只留一个空格，和手写 Markdown 保持一致");
});

test("有序列表用 1. 2. 而不是 -", async () => {
  const { plugin } = await createPlugin();
  const container = makeCopyTarget(
    '<div data-type="NodeList" data-subtype="o">' +
      '<div data-type="NodeListItem"><div data-type="NodeParagraph">' +
      `<div contenteditable="true">甲 ${inlineMath("a", "a")}</div></div></div>` +
      '<div data-type="NodeListItem"><div data-type="NodeParagraph">' +
      `<div contenteditable="true">乙 ${inlineMath("b", "b")}</div></div></div>` +
      "</div>",
  );
  const { store } = withSelection(container, () => fireCopy(plugin));
  const md = store["text/plain"];

  assert.match(md, /^1\.\s+甲 \$a\$/m);
  assert.match(md, /^2\.\s+乙 \$b\$/m);
});

test("标题复制带 ## 级别", async () => {
  const { plugin } = await createPlugin();
  const container = makeCopyTarget(
    '<div data-type="NodeHeading" data-subtype="h2"><div contenteditable="true">' +
      `标题 ${inlineMath("a^2", "a²")}</div></div>`,
  );
  const { store } = withSelection(container, () => fireCopy(plugin));

  assert.match(store["text/plain"], /^## 标题 \$a\^2\$/m, "应该输出 ## 而不是裸文本");
});

test("引用复制带 > 标记", async () => {
  const { plugin } = await createPlugin();
  const container = makeCopyTarget(
    '<div data-type="NodeBlockquote"><div data-type="NodeParagraph">' +
      `<div contenteditable="true">引用 ${inlineMath("b_1", "b₁")}</div></div></div>`,
  );
  const { store } = withSelection(container, () => fireCopy(plugin));

  assert.match(store["text/plain"], /^>\s+引用 \$b_1\$/m, "应该输出 > 而不是裸文本");
});

test("表格复制成 GFM 表格，公式列正常", async () => {
  const { plugin } = await createPlugin();
  const container = makeCopyTarget(
    '<div data-type="NodeTable"><table>' +
      "<tr><th>符号</th><th>含义</th></tr>" +
      `<tr><td>${inlineMath("\\alpha", "α")}</td><td>角度</td></tr>` +
      "</table></div>",
  );
  const { store } = withSelection(container, () => fireCopy(plugin));
  const md = store["text/plain"];

  assert.match(md, /\| 符号 \| 含义 \|/);
  assert.match(md, /\| \$\\alpha\$ \| 角度 \|/);
});

test("代码块内容原样保留，里面的定界符不被当公式", async () => {
  const { plugin } = await createPlugin();
  const container = makeCopyTarget(
    '<div data-type="NodeParagraph"><div contenteditable="true">' +
      `说明 ${inlineMath("x", "x")}</div></div>` +
      '<div data-type="NodeCodeBlock" data-subtype="python">' +
      '<div class="protyle-action"><span class="protyle-action__language">python</span></div>' +
      '<div class="hljs"><div contenteditable="true">print("\\(not math\\)")</div></div></div>',
  );
  const { store } = withSelection(container, () => fireCopy(plugin));
  const md = store["text/plain"];

  assert.match(md, /```python/, "代码块要带语言标记");
  assert.match(md, /\\\(not math\\\)/, "代码里的 \\( 必须原样保留");
  assert.doesNotMatch(md, /\$not math\$/, "不能把代码里的内容包成公式");
});

test("表格单元格里的段落不会撑破表格", async () => {
  const { plugin } = await createPlugin();
  // 真实思源的单元格里通常还套一层 NodeParagraph，包成 <p> 会在 GFM 表格里插入换行
  const container = makeCopyTarget(
    '<div data-type="NodeTable"><table>' +
      "<tr><th>符号</th><th>含义</th></tr>" +
      '<tr><td><div data-type="NodeParagraph"><div contenteditable="true">' +
      `${inlineMath("\\beta", "β")}</div></div></td>` +
      '<td><div data-type="NodeParagraph"><div contenteditable="true">角度</div></div></td></tr>' +
      "</table></div>",
  );
  const { store } = withSelection(container, () => fireCopy(plugin));
  const md = store["text/plain"];

  assert.match(md, /\| \$\\beta\$ \| 角度 \|/, "整行必须在一行内完成");
});

test("综合片段：标题 + 段落 + 列表 + 引用一起复制", async () => {
  const { plugin } = await createPlugin();
  const container = makeCopyTarget(
    '<div data-type="NodeHeading" data-subtype="h2">' +
      '<div contenteditable="true">定理</div></div>' +
      '<div data-type="NodeParagraph"><div contenteditable="true">' +
      `设 ${inlineMath("f", "f")} 为全纯函数。</div></div>` +
      '<div data-type="NodeList" data-subtype="u">' +
      '<div data-type="NodeListItem"><div data-type="NodeParagraph">' +
      '<div contenteditable="true">条件一</div></div></div>' +
      '<div data-type="NodeListItem"><div data-type="NodeParagraph">' +
      `<div contenteditable="true">条件二 ${inlineMath("g", "g")}</div></div></div>` +
      "</div>" +
      '<div data-type="NodeBlockquote"><div data-type="NodeParagraph">' +
      `<div contenteditable="true">推论 ${inlineMath("h", "h")}</div></div></div>`,
  );
  const { store } = withSelection(container, () => fireCopy(plugin));
  const md = store["text/plain"];

  assert.match(md, /^## 定理/m, "标题");
  assert.match(md, /设 \$f\$ 为全纯函数。/, "段落 + 行内公式");
  assert.match(md, /^- 条件一$/m, "列表项");
  assert.match(md, /^- 条件二 \$g\$/m, "列表项 + 公式");
  assert.match(md, /^> 推论 \$h\$/m, "引用 + 公式");
});

test("列表项里的块级公式不会被吞掉", async () => {
  const { plugin } = await createPlugin();
  const container = makeCopyTarget(
    '<div data-type="NodeList" data-subtype="u"><div data-type="NodeListItem">' +
      '<div class="protyle-action"></div>' +
      '<div data-type="NodeParagraph"><div contenteditable="true">推导</div></div>' +
      '<div data-type="NodeMathBlock" data-content="E = mc^2">渲染乱码</div>' +
      "</div></div>",
  );
  const { store } = withSelection(container, () => fireCopy(plugin));
  const md = store["text/plain"];

  assert.match(md, /^- 推导$/m, "列表项文字");
  assert.match(md, /^ {4}\$\$\n {4}E = mc\^2\n {4}\$\$$/m, "列表项里的块级公式要还原成 $$ 块，并且跟着列表缩进");
});

test("表格单元格里的块级公式降级成行内，表格不散架", async () => {
  const { plugin } = await createPlugin();
  const container = makeCopyTarget(
    '<div data-type="NodeTable"><table>' +
      "<tr><th>积分</th><th>备注</th></tr>" +
      '<tr><td><div data-type="NodeMathBlock" data-content="\\int_0^1 f">乱码</div></td>' +
      "<td>连续</td></tr></table></div>",
  );
  const { store } = withSelection(container, () => fireCopy(plugin));
  const md = store["text/plain"];

  assert.match(md, /^\| 积分 \| 备注 \|$/m, "表头还是单行");
  assert.match(md, /^\| \$\\int_0\^1 f\$ \| 连续 \|$/m, "单元格里只能是行内公式，且表格行没被拆开");
  assert.doesNotMatch(md, /\$\$/, "表格里不能出现 $$ 块");
});

test("引述块（Callout）复制成引用块", async () => {
  const { plugin } = await createPlugin();
  const container = makeCopyTarget(
    '<div data-type="NodeCallout" data-subtype="NOTE">' +
      '<div class="protyle-icons"></div>' +
      '<div data-type="NodeParagraph"><div contenteditable="true">' +
      `提示 ${inlineMath("a", "a")}</div></div></div>`,
  );
  const { store } = withSelection(container, () => fireCopy(plugin));

  assert.match(store["text/plain"], /^> 提示 \$a\$/m, "Callout 要降成引用块，内容不能变成裸段落");
});

test("思源 data-type 写法的行内格式转成 Markdown 标记", async () => {
  const { plugin } = await createPlugin();
  const container = makeCopyTarget(
    '<div data-type="NodeParagraph"><div contenteditable="true">' +
      '<span data-type="strong">粗</span>' +
      '<span data-type="em">斜</span>' +
      '<span data-type="code">code</span>' +
      '<span data-type="s">删除</span>' +
      '<span data-type="a" data-href="https://example.com">链接</span>' +
      `<span data-type="inline-math" data-content="x^2">x²</span>` +
      "</div></div>",
  );
  const { store } = withSelection(container, () => fireCopy(plugin));
  const md = store["text/plain"];

  assert.match(md, /\*\*粗\*\*/, "加粗");
  assert.match(md, /\*斜\*/, "斜体");
  assert.match(md, /`code`/, "行内代码");
  assert.match(md, /~~删除~~/, "删除线用两个波浪线，GitHub / Obsidian 才认");
  assert.match(md, /\[链接\]\(https:\/\/example\.com\)/, "链接要用 data-href");
  assert.match(md, /\$x\^2\$/, "行内公式不受影响");
});

test("思源标签复制成 #标签#", async () => {
  const { plugin } = await createPlugin();
  const container = makeCopyTarget(
    '<div data-type="NodeParagraph"><div contenteditable="true">' +
      '<span data-type="tag" data-content="复分析">复分析</span> ' +
      inlineMath("z", "z") +
      "</div></div>",
  );
  const { store } = withSelection(container, () => fireCopy(plugin));

  assert.match(store["text/plain"], /#复分析# \$z\$/, "标签要带上 # 才有语义");
});

test("列表项里的两个段落不会粘成一句话", async () => {
  const { plugin } = await createPlugin();
  const container = makeCopyTarget(
    '<div data-type="NodeList" data-subtype="u"><div data-type="NodeListItem">' +
      '<div class="protyle-action"></div>' +
      `<div data-type="NodeParagraph"><div contenteditable="true">第一段 ${inlineMath("a", "a")}</div></div>` +
      '<div data-type="NodeParagraph"><div contenteditable="true">第二段</div></div>' +
      "</div></div>",
  );
  const { store } = withSelection(container, () => fireCopy(plugin));

  assert.equal(store["text/plain"], "- 第一段 $a$\n\n    第二段", "第二段要另起一段并缩进到列表项里");
});

test("有序列表保留起始编号", async () => {
  const { plugin } = await createPlugin();
  const container = makeCopyTarget(
    '<div data-type="NodeList" data-subtype="o" start="3">' +
      `<div data-type="NodeListItem"><div data-type="NodeParagraph"><div contenteditable="true">三 ${inlineMath("c", "c")}</div></div></div>` +
      '<div data-type="NodeListItem"><div data-type="NodeParagraph"><div contenteditable="true">四</div></div></div>' +
      "</div>",
  );
  const { store } = withSelection(container, () => fireCopy(plugin));
  const md = store["text/plain"];

  assert.match(md, /^3\. 三 \$c\$/m, "从 3 开始的列表不能变成 1.");
  assert.match(md, /^4\. 四$/m);
});

test("引用块里的块级公式带着 > 前缀", async () => {
  const { plugin } = await createPlugin();
  const container = makeCopyTarget(
    '<div data-type="NodeBlockquote">' +
      '<div data-type="NodeParagraph"><div contenteditable="true">说明</div></div>' +
      '<div data-type="NodeMathBlock" data-content="a=b">渲染</div>' +
      "</div>",
  );
  const { store } = withSelection(container, () => fireCopy(plugin));
  const md = store["text/plain"];

  assert.match(md, /^> 说明$/m);
  assert.match(md, /^> \$\$$\n> a=b\n> \$\$$/m, "公式要留在引用块里，不能掉到外面");
});

test("光标停在列表项里用命令复制时，带出列表符号而不是裸段落", async () => {
  const { plugin } = await createPlugin();
  const container = makeCopyTarget(
    '<div data-node-id="list1" data-type="NodeList" data-subtype="u">' +
      '<div data-node-id="item1" data-type="NodeListItem"><div class="protyle-action"></div>' +
      '<div data-node-id="p1" data-type="NodeParagraph">' +
      `<div contenteditable="true">条目 ${inlineMath("x", "x")}</div></div></div></div>`,
  );
  const textNode = container.querySelector('[data-node-id="p1"] [contenteditable]').firstChild;

  let written = null;
  mockClipboard(async (text) => {
    written = text;
  });
  const command = plugin.commands.find((item) => item.langKey === "commandCopyAsMarkdown");
  assert.ok(command, "应该注册了复制命令");
  await withCaret(textNode, () => command.callback());

  assert.match(written, /^- 条目 \$x\$/m, "光标在项里也要带上 - 标记，不能只吐一段裸文字");
});

test("代码块里的连续空行原样保留", async () => {
  const { plugin } = await createPlugin();
  const container = makeCopyTarget(
    '<div data-type="NodeCodeBlock" data-subtype="python">' +
      '<div class="protyle-action"><span class="protyle-action__language">python</span></div>' +
      '<div class="hljs"><div contenteditable="true">a = 1\n\n\n\nb = 2</div></div></div>' +
      '<div data-type="NodeParagraph"><div contenteditable="true">' +
      inlineMath("x", "x") +
      "</div></div>",
  );
  const { store } = withSelection(container, () => fireCopy(plugin));
  const md = store["text/plain"];

  assert.match(md, /```python\na = 1\n\n\n\nb = 2\n```/, "代码块内的空行不能和正文一起被折叠");
});

test("正文里的多余空段落照常压成一个空行", async () => {
  const { plugin } = await createPlugin();
  const container = makeCopyTarget(
    '<div data-type="NodeParagraph"><div contenteditable="true">甲 ' +
      inlineMath("a", "a") +
      "</div></div>" +
      '<div data-type="NodeParagraph"><div contenteditable="true"></div></div>' +
      '<div data-type="NodeParagraph"><div contenteditable="true"></div></div>' +
      '<div data-type="NodeParagraph"><div contenteditable="true">乙</div></div>',
  );
  const { store } = withSelection(container, () => fireCopy(plugin));

  assert.equal(store["text/plain"], "甲 $a$\n\n乙", "中间只留一个空行");
});

