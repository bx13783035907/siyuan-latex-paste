export interface LatexPasteSettings {
  /** 总开关 */
  enabled: boolean;
  /** 有公式时把 HTML 转成 Markdown，保住加粗、列表等格式 */
  keepHtmlFormat: boolean;
  /** \( ... \) → $ ... $ */
  convertInline: boolean;
  /** \[ ... \] → $$ ... $$ */
  convertDisplay: boolean;
  /** \begin{equation} 等环境 → $$ ... $$ */
  convertEnvironments: boolean;
  /** 无定界符的裸 LaTeX（实验性） */
  bareLatex: boolean;
  /** 剪贴板里已经写成 $ ... $ / $$ ... $$ 的 Markdown 公式也要处理 */
  markdownMath: boolean;
  /** 从思源复制出去时，把公式还原成带 $ 定界符的 Markdown */
  copyAsMarkdown: boolean;
  /** 控制台输出处理日志，排查用 */
  debug: boolean;
}

export const DEFAULT_SETTINGS: LatexPasteSettings = {
  enabled: true,
  keepHtmlFormat: true,
  convertInline: true,
  convertDisplay: true,
  convertEnvironments: true,
  bareLatex: false,
  markdownMath: true,
  copyAsMarkdown: true,
  debug: true,
};

export const SETTINGS_KEY = "settings";
