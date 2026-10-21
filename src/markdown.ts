/**
 * Markdown 文本的后处理。
 *
 * 只做一件事，但必须做对：把连续空行压成一个空行时，**不能碰围栏代码块里的内容**。
 * 代码里的连续空行是有意义的（Python 里空行分段、配置文件里空行分块），
 * 全局来一发 /\n{3,}/g 会把它们啃成一行，复制出去的代码就和原来不一样了。
 */

const FENCE_RE = /^\s*(`{3,}|~{3,})/;

/**
 * 压掉多余空行，围栏代码块内部原样保留。
 *
 * 逐行扫而不是用正则切分：切分要处理「开头围栏带语言标记、结尾围栏不带」、
 * 代码里本身包含 ``` 这些情况，扫一遍反而更稳。
 */
export function collapseBlankLines(markdown: string): string {
  if (!markdown.includes("\n\n\n")) {
    return markdown;
  }

  const out: string[] = [];
  let fence: string | null = null;
  let blanks = 0;

  for (const line of markdown.split("\n")) {
    const match = FENCE_RE.exec(line);
    const isFence = match !== null;

    if (fence !== null) {
      out.push(line);
      // 闭合围栏：同样的符号、不短于开启它的长度
      if (isFence && match[1][0] === fence[0] && match[1].length >= fence.length) {
        fence = null;
        blanks = 0;
      }
      continue;
    }

    if (isFence) {
      fence = match[1];
      blanks = 0;
      out.push(line);
      continue;
    }

    if (line.trim() === "") {
      blanks += 1;
      // 空段落最多留一个，再多的就是排版噪音
      if (blanks > 1) {
        continue;
      }
      out.push(line);
      continue;
    }

    blanks = 0;
    out.push(line);
  }

  return out.join("\n");
}
