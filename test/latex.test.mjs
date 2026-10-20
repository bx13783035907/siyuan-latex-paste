import test from "node:test";
import assert from "node:assert/strict";
import {
  convertLatex,
  countLatexDelimiters,
  hasLatexDelimiters,
  hasMarkdownMath,
  looksLikeMath,
} from "./.build/latex.mjs";

const DEFAULT = { inline: true, display: true, environments: true, bare: false };
const convert = (text, options = DEFAULT) => convertLatex(text, options);

test("行内公式 \\( ... \\) 转成 $ ... $", () => {
  assert.equal(convert("质能方程 \\(E=mc^2\\) 很著名").text, "质能方程 $E=mc^2$ 很著名");
});

test("块级公式 \\[ ... \\] 独占行时转成 $$ 块", () => {
  const result = convert("前文\n\n\\[\\int_0^1 x^2 dx\\]\n\n后文");
  assert.match(result.text, /\$\$\n\\int_0\^1 x\^2 dx\n\$\$/);
  assert.equal(result.count, 1);
});

test("\\[ ... \\] 夹在文字中间时降级为行内公式", () => {
  assert.equal(convert("由 \\[x=1\\] 可得").text, "由 $x=1$ 可得");
});

test("equation 环境转成 $$ 块", () => {
  const result = convert("\\begin{equation}\na^2+b^2=c^2\n\\end{equation}");
  assert.match(result.text, /\$\$\n\\begin\{equation\}/);
  assert.equal(result.count, 1);
});

test("align 环境保留环境名", () => {
  const result = convert("\\begin{align}\nx &= 1 \\\\\ny &= 2\n\\end{align}");
  assert.match(result.text, /\\begin\{align\}/);
  assert.match(result.text, /\\end\{align\}/);
});

test("已经是 $$ 的公式不会被二次包裹", () => {
  const input = "$$\nE=mc^2\n$$";
  assert.equal(convert(input).text.trim(), input.trim());
  assert.equal(convert(input).count, 0);
});

test("行内公式内容里的 $ 会被转义", () => {
  assert.equal(convert("\\(a\\$b\\)").text, "$a\\$b$");
});

test("代码块里的定界符保持原样", () => {
  const input = "```latex\n\\(x^2\\)\n```";
  assert.equal(convert(input).text, input);
  assert.equal(convert(input).count, 0);
});

test("行内代码里的定界符保持原样", () => {
  const input = "写法是 `\\(x\\)` 这样";
  assert.equal(convert(input).text, input);
});

test("代码块之外的部分仍然转换", () => {
  const input = "`\\(ignore\\)`\n\n\\(keep\\)";
  const result = convert(input);
  assert.match(result.text, /`\\\(ignore\\\)`/);
  assert.match(result.text, /\$keep\$/);
});

test("多个公式全部转换", () => {
  const result = convert("\\(a\\) 和 \\(b\\) 以及 \\(c\\)");
  assert.equal(result.text, "$a$ 和 $b$ 以及 $c$");
  assert.equal(result.count, 3);
});

test("转换是幂等的", () => {
  const once = convert("公式 \\(x^2\\) 与 \\[y^2\\]").text;
  const twice = convert(once).text;
  assert.equal(once, twice);
});

test("裸 LaTeX 默认不处理", () => {
  const input = "\\frac{a}{b} = c";
  assert.equal(convert(input).text, input);
  assert.equal(convert(input).count, 0);
});

test("打开 bare 选项后裸公式被包裹", () => {
  const result = convert("\\frac{a}{b} = c", { ...DEFAULT, bare: true });
  assert.match(result.text, /\$\$\n\\frac\{a\}\{b\} = c\n\$\$/);
});

test("bare 不误伤普通中文行和路径", () => {
  const options = { ...DEFAULT, bare: true };
  assert.equal(convert("这是一段普通的中文", options).count, 0);
  assert.equal(convert("C:\\Users\\clock\\Desktop", options).count, 0);
});

test("嵌套：\\[ 里含环境时只包一层", () => {
  const result = convert("\\[\\begin{matrix}a & b\\\\c & d\\end{matrix}\\]");
  assert.equal(result.count, 1);
  assert.equal((result.text.match(/\$\$/g) || []).length, 2);
});

test("块级公式前后多余空行被压回", () => {
  const result = convert("a\n\n\\[x\\]\n\nb");
  assert.ok(!/\n{3,}/.test(result.text), "不应出现三连换行");
});

test("没有公式时不动原文的空行", () => {
  const result = convert("a\n\n\n\nb");
  assert.equal(result.text, "a\n\n\n\nb", "原文的空行不该被顺手压掉");
  assert.equal(result.count, 0);
});

test("countLatexDelimiters 统计各类定界符", () => {
  assert.equal(countLatexDelimiters("\\(a\\) \\[b\\]"), 2);
  assert.equal(countLatexDelimiters("\\begin{align}x\\end{align}"), 1);
  assert.equal(countLatexDelimiters("没有公式"), 0);
});

test("hasLatexDelimiters 快速判断", () => {
  assert.equal(hasLatexDelimiters("一段 \\(x\\) 文字"), true);
  assert.equal(hasLatexDelimiters("\\begin{equation}x\\end{equation}"), true);
  assert.equal(hasLatexDelimiters("纯中文文本"), false);
});

test("空字符串安全", () => {
  assert.deepEqual(convert(""), { text: "", count: 0 });
});

// ---- looksLikeMath：单个变量/微分这类「没有数学符号」的公式也要认 ----

test("短的变量名也算公式", () => {
  for (const item of ["dA", "x", "dz", "n", "E0", "abc"]) {
    assert.equal(looksLikeMath(item), true, `${item} 应该被当成公式`);
  }
});

test("金额和普通词不算公式", () => {
  assert.equal(looksLikeMath("5 到 10"), false, "含空格和数字");
  assert.equal(looksLikeMath("hello"), false, "普通英文单词");
  assert.equal(looksLikeMath("note"), false, "四个字母也不该算");
  assert.equal(looksLikeMath("价格"), false, "中文");
  assert.equal(looksLikeMath(""), false);
});

test("$dA$ 这种短公式能被 hasMarkdownMath 识别", () => {
  assert.equal(hasMarkdownMath("记 $dA$ 为面积测度"), true);
  assert.equal(hasMarkdownMath("这本书 $5 到 $10 之间"), false);
});
