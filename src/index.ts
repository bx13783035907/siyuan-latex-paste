import { Plugin, Setting, showMessage } from "siyuan";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import {
  convertLatex,
  countLatexDelimiters,
  hasMarkdownMath,
  type LatexConvertOptions,
} from "./latex";
import {
  extractMathNodes,
  extractSiyuanComment,
  hasMathNodes,
  restoreMath,
  stashMathInHtml,
  stripHtml,
  type MathSegment,
} from "./html";
import { DEFAULT_SETTINGS, SETTINGS_KEY, type LatexPasteSettings } from "./settings";

interface IPasteDetail {
  protyle: any;
  resolve: (data: IPastePayload) => void;
  textHTML: string;
  textPlain: string;
  siyuanHTML: string;
  files: any;
}

interface IPastePayload {
  textHTML: string;
  textPlain: string;
  siyuanHTML: string;
  files: any;
}

/** 整页网页复制经常好几 MB，超过这个量就放弃处理，别让编辑器卡住 */
const MAX_HTML_LENGTH = 2 * 1024 * 1024;

module.exports = class LatexPaste extends Plugin {
  private settings: LatexPasteSettings = { ...DEFAULT_SETTINGS };
  private turndown: TurndownService | null = null;
  /** 事件总线最近一次接管的时间戳，用来判断 DOM 兜底是否还需要出手 */
  private lastBusHandled = 0;
  /** 加载结果提示，等 onLayoutReady（UI 就绪）再弹 */
  private loadReport = "";

  async onload() {
    await this.loadSettings();

    // 每一步单独 try/catch：只要有一处抛错，后面的注册就全废了。
    // 之前就是 addCommand 出问题，把 click-blockicon 一起带走了。
    const steps: string[] = [];
    const attempt = (name: string, run: () => void) => {
      try {
        run();
        steps.push(`${name}: ok`);
      } catch (error) {
        steps.push(`${name}: FAIL ${(error as Error)?.message ?? error}`);
        console.error(`[latex-paste] 注册 ${name} 失败`, error);
      }
    };

    // 路径一：思源的事件总线（能拿到 protyle，判断最准）
    attempt("paste-bus", () => this.eventBus.on("paste", this.handlePaste));
    // 路径二：DOM 捕获阶段直接改写剪贴板，不依赖思源版本
    attempt("paste-dom", () => document.addEventListener("paste", this.onDomPaste, true));
    // 路径三：复制出去时还原 Markdown。思源自己也会 preventDefault 后异步写剪贴板，
    // 所以这条实际拦不住，留着当兜底。
    attempt("copy-dom", () => window.addEventListener("copy", this.onCopy, true));

    // 真正能用的入口，靠主动触发：
    // 块图标菜单 —— 选中块后点图标，不依赖快捷键也不依赖浏览器事件
    attempt("block-icon", () => this.eventBus.on("click-blockicon", this.onBlockIcon));
    // 内容区右键菜单 —— 选中文字后右键就能用，比顶栏更顺手
    attempt("content-menu", () => this.eventBus.on("open-menu-content", this.onContentMenu));
    // 顶栏按钮 —— 万一菜单没出来，这个总能看见
    attempt("topbar", () =>
      this.addTopBar({
        icon: "iconCopy",
        title: this.i18n.commandCopyAsMarkdown,
        position: "right",
        callback: () => {
          void this.copyAsMarkdown();
        },
      }),
    );
    // 命令不带 hotkey：思源里 ⌘⇧C 是「复制块引用」，⌘⌥C 也不一定干净。
    // 想让快捷键生效，去「设置 → 快捷键」里给这个命令自己绑一个。
    attempt("command", () =>
      this.addCommand({
        langKey: "commandCopyAsMarkdown",
        callback: this.copyAsMarkdown,
      }),
    );

    // 思源是 Store 版，F12 可能打不开开发者工具，所以把结果落到插件存储里，
    // 外面直接读文件就能排查。
    await this.writeDiagnose(steps);

    this.log("插件已加载", JSON.stringify({ settings: this.settings, steps }));

    // 提示别在这里弹：onload 阶段思源的 UI 还没就绪，showMessage 会静默失效。
    // 先记下来，等 onLayoutReady 再弹。
    const failed = steps.filter((step) => step.includes("FAIL"));
    this.loadReport =
      failed.length > 0
        ? `LaTeX 公式粘贴：${failed.length} 项注册失败（${failed.join("；")}）`
        : "LaTeX 公式粘贴：已加载";
  }

  /** 把注册结果写到 data/storage/petal/<插件名>/diagnose，方便外部排查 */
  private async writeDiagnose(steps: string[]) {
    try {
      await this.saveData("diagnose", {
        at: new Date().toISOString(),
        steps,
      });
    } catch (error) {
      console.error("[latex-paste] 写入诊断信息失败", error);
    }
  }

  onunload() {
    this.eventBus.off("paste", this.handlePaste);
    this.eventBus.off("click-blockicon", this.onBlockIcon);
    this.eventBus.off("open-menu-content", this.onContentMenu);
    document.removeEventListener("paste", this.onDomPaste, true);
    window.removeEventListener("copy", this.onCopy, true);
    this.turndown = null;
  }

  onLayoutReady() {
    this.setting = new Setting({
      confirmCallback: () => {
        this.saveData(SETTINGS_KEY, this.settings);
      },
    });

    const items: Array<{ key: keyof LatexPasteSettings; title: string; description: string }> = [
      { key: "enabled", title: this.i18n.enabled, description: this.i18n.enabledDesc },
      { key: "keepHtmlFormat", title: this.i18n.keepHtml, description: this.i18n.keepHtmlDesc },
      { key: "convertInline", title: this.i18n.inline, description: this.i18n.inlineDesc },
      { key: "convertDisplay", title: this.i18n.display, description: this.i18n.displayDesc },
      {
        key: "convertEnvironments",
        title: this.i18n.environments,
        description: this.i18n.environmentsDesc,
      },
      {
        key: "markdownMath",
        title: this.i18n.markdownMath,
        description: this.i18n.markdownMathDesc,
      },
      {
        key: "copyAsMarkdown",
        title: this.i18n.copyAsMarkdown,
        description: this.i18n.copyAsMarkdownDesc,
      },
      { key: "bareLatex", title: this.i18n.bare, description: this.i18n.bareDesc },
      { key: "debug", title: this.i18n.debug, description: this.i18n.debugDesc },
    ];

    for (const item of items) {
      this.setting.addItem({
        title: item.title,
        description: item.description,
        createActionElement: () => this.createCheckbox(item.key),
      });
    }

    // 到这里 UI 才真的就绪，弹提示才看得见
    if (this.settings.debug && this.loadReport) {
      showMessage(this.loadReport, 5000);
    }
  }

  private log(...args: unknown[]) {
    if (this.settings.debug) {
      console.log("[latex-paste]", ...args);
    }
  }

  private createCheckbox(key: keyof LatexPasteSettings): HTMLInputElement {
    const input = document.createElement("input");
    input.type = "checkbox";
    input.className = "b3-switch fn__flex-center";
    input.checked = Boolean(this.settings[key]);
    input.addEventListener("change", () => {
      (this.settings as any)[key] = input.checked;
    });
    return input;
  }

  private async loadSettings() {
    try {
      const saved = await this.loadData(SETTINGS_KEY);
      if (saved && typeof saved === "object") {
        this.settings = { ...DEFAULT_SETTINGS, ...saved };
      }
    } catch (error) {
      console.warn("[latex-paste] load settings failed", error);
    }
  }

  private getOptions(): LatexConvertOptions {
    return {
      inline: this.settings.convertInline,
      display: this.settings.convertDisplay,
      environments: this.settings.convertEnvironments,
      bare: this.settings.bareLatex,
    };
  }

  /**
   * 判断一段内容里有没有需要处理的公式。
   * rawHtml 传原始 HTML：公式被渲染成 DOM 之后文本里的 $ 就没了，只能看 HTML 判断。
   */
  private detect(text: string, rawHtml = ""): { count: number; hasMath: boolean } {
    const count = countLatexDelimiters(text);
    const md = this.settings.markdownMath && hasMarkdownMath(text);
    const nodes = rawHtml ? hasMathNodes(rawHtml) : false;
    return { count: count + (nodes ? 1 : 0), hasMath: count > 0 || md || nodes };
  }

  /**
   * 优先把 HTML 转成 Markdown（保住加粗、列表、链接等格式），
   * 公式在 HTML 里被标签拆碎时退回纯文本。
   */
  private convertPayload(
    textPlain: string,
    textHTML: string,
    plain: { count: number; hasMath: boolean },
    html: { count: number; hasMath: boolean },
  ): string | null {
    const options = this.getOptions();

    if (textHTML && html.hasMath && this.settings.keepHtmlFormat) {
      const { markdown, count } = this.htmlToMarkdown(textHTML, options);
      if (count > 0 && count >= plain.count) {
        this.log("走 HTML → Markdown 路径", { count, markdown });
        return markdown;
      }
      // HTML 里明明有公式却一个都没抽出来，说明被标签拆碎还被转义了，
      // 这时候用它只会得到 \$ … \$ 这种怪东西，退回纯文本更稳。
      //
      // 注意这里没有「有 HTML 就转」的兜底分支：HTML 里没有公式标记时，
      // 转出来的 Markdown 会丢掉纯文本里那份能用的公式，公式优先于格式。
      this.log("HTML 里的公式没抽全，回退纯文本", { count, plainCount: plain.count });
    }

    const result = convertLatex(textPlain, options);
    if (result.count > 0) {
      return result.text;
    }
    // 纯文本里只有 Markdown 公式：内容不用改，关键是让思源走 Markdown 解析
    if (plain.hasMath && textPlain.trim()) {
      return textPlain;
    }
    return null;
  }

  /** 路径一：思源事件总线 */
  private handlePaste = (event: CustomEvent<IPasteDetail>) => {
    const detail = event?.detail;
    if (!detail || typeof detail.resolve !== "function") {
      return;
    }

    try {
      if (!this.settings.enabled) {
        return;
      }
      const protyle = detail.protyle;
      if (!protyle || protyle.options?.mode === "preview") {
        return;
      }
      // 思源内部复制粘贴：公式本来就是公式，不用管
      if (detail.siyuanHTML) {
        return;
      }
      // 带附件（图片等）的粘贴不接管，避免把文件弄丢
      if (detail.files && detail.files.length > 0) {
        return;
      }
      if (this.isInCodeContext()) {
        return;
      }

      const textPlain = detail.textPlain || "";
      const textHTML = detail.textHTML || "";
      if (textHTML.length > MAX_HTML_LENGTH) {
        this.log("HTML 太大，跳过处理", { length: textHTML.length });
        return;
      }
      const plain = this.detect(textPlain);
      const html = this.detect(textHTML ? stripHtml(textHTML) : "", textHTML);
      // 来源到底给了什么，排查时全靠这条
      this.log("收到粘贴", { textPlain, textHTML, plain, html });
      if (!plain.hasMath && !html.hasMath) {
        return;
      }

      const converted = this.convertPayload(textPlain, textHTML, plain, html);
      // 没有 HTML 时，纯文本本来就会走 Markdown 解析，不用多此一举
      if (!converted || (converted === textPlain && !textHTML)) {
        return;
      }

      this.lastBusHandled = Date.now();
      this.log("事件总线：改写载荷", { converted });
      event.preventDefault();
      detail.resolve({
        textHTML: "",
        textPlain: converted,
        siyuanHTML: "",
        files: detail.files,
      });
    } catch (error) {
      console.error("[latex-paste] paste handling failed", error);
    }
  };

  /**
   * 路径二：DOM 兜底，在捕获阶段直接改写剪贴板数据。
   * 老版本思源的事件总线替换载荷有 bug（3.8.0 才修），这条路径不依赖版本。
   */
  private onDomPaste = (event: ClipboardEvent) => {
    if (!this.settings.enabled) {
      return;
    }
    const data = event.clipboardData;
    if (!data) {
      return;
    }

    try {
      // 思源内部复制粘贴，公式已经是对的
      if (Array.prototype.indexOf.call(data.types, "text/siyuan") > -1) {
        return;
      }
      const target = event.target as HTMLElement | null;
      if (!target || typeof target.closest !== "function" || !target.closest(".protyle-wysiwyg")) {
        return;
      }
      if (this.isInCodeContext()) {
        return;
      }
      // 事件总线刚处理过这次粘贴，不再重复改
      if (Date.now() - this.lastBusHandled < 200) {
        return;
      }

      const textPlain = data.getData("text/plain") || "";
      const textHTML = data.getData("text/html") || "";
      if (textHTML.length > MAX_HTML_LENGTH) {
        this.log("HTML 太大，跳过处理", { length: textHTML.length });
        return;
      }
      const plain = this.detect(textPlain);
      const html = this.detect(textHTML ? stripHtml(textHTML) : "", textHTML);
      if (!plain.hasMath && !html.hasMath) {
        return;
      }

      const converted = this.convertPayload(textPlain, textHTML, plain, html);
      if (!converted) {
        return;
      }

      data.setData("text/plain", converted);
      if (textHTML) {
        data.setData("text/html", "");
        if (data.getData("text/html")) {
          // 少数环境下 setData 清不干净，记录在控制台便于排查
          console.warn("[latex-paste] 无法清空 text/html，HTML 分支可能仍然生效");
        }
      }
      this.log("DOM 兜底：改写剪贴板", { converted });
    } catch (error) {
      console.error("[latex-paste] dom paste failed", error);
    }
  };

  /**
   * 把当前选区转成 Markdown。
   * 没有公式、不在编辑器里、或者含图片视频时返回 null（表示别管这次复制）。
   */
  /**
   * 把一段 DOM 转成 Markdown。里面没有公式就返回 null（表示别管这次操作）。
   */
  private renderMarkdown(holder: HTMLElement): { markdown: string; siyuanHTML: string } | null {
    // 块图标（🏷️）只是装饰，转成 Markdown 会变成一串乱码
    holder.querySelectorAll(".protyle-attr").forEach((node) => node.remove());

    // 含图片/视频时不处理：转成 Markdown 后这些内容在其他软件里就没了
    if (holder.querySelector("img, video, audio, iframe")) {
      this.log("复制：内容里有媒体文件，跳过");
      return null;
    }

    // 思源内部互相粘贴靠这个，先留一份原样的（必须在替换占位符之前取）
    const siyuanHTML = holder.innerHTML;
    // 外层 HTML 里可能没有公式节点，得连注释里的完整块结构一起看
    const comment = extractSiyuanComment(siyuanHTML);

    if (!hasMathNodes(siyuanHTML) && !(comment && hasMathNodes(comment))) {
      return null;
    }

    // 这里别想着借 Lute.BlockDOM2Md 一把梭。实测把块 DOM 直接喂给它，
    // 它会原样吐回 HTML（带 language-math 包装和 &amp; 实体），根本不是 Markdown。
    // 自己抽占位符 + Turndown 虽然笨，但行为可预测。
    let source = holder;
    let segments = extractMathNodes(source);

    if (segments.length === 0 && comment) {
      const fromComment = document.createElement("div");
      fromComment.innerHTML = comment;
      fromComment.querySelectorAll(".protyle-attr").forEach((node) => node.remove());
      const extracted = extractMathNodes(fromComment);
      if (extracted.length > 0) {
        source = fromComment;
        segments = extracted;
        this.log("复制：公式节点在 data-siyuan 注释里，已从那里还原");
      }
    }

    if (segments.length === 0) {
      return null;
    }
    // 块级公式还原时会带出前后空行，连续几段就会堆成一堆空行
    const markdown = restoreMath(this.turndownService().turndown(source.innerHTML), segments)
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    if (!markdown) {
      return null;
    }
    return { markdown, siyuanHTML };
  }

  /** 一个 Range → Markdown */
  private rangeToMarkdown(range: Range): { markdown: string; siyuanHTML: string } | null {
    const anchor = range.commonAncestorContainer;
    const element =
      anchor.nodeType === Node.TEXT_NODE ? anchor.parentElement : (anchor as HTMLElement);
    if (!element || typeof element.closest !== "function" || !element.closest(".protyle-wysiwyg")) {
      return null;
    }

    const holder = document.createElement("div");
    holder.appendChild(range.cloneContents());
    return this.renderMarkdown(holder);
  }

  /** 当前选区 → Markdown */
  private selectionToMarkdown(): { markdown: string; siyuanHTML: string } | null {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      return null;
    }
    return this.rangeToMarkdown(selection.getRangeAt(0));
  }

  private async writeMarkdown(result: { markdown: string } | null) {
    if (!result) {
      showMessage(this.i18n.commandCopyEmpty);
      return;
    }
    try {
      await navigator.clipboard.writeText(result.markdown);
      showMessage(this.i18n.commandCopyDone);
    } catch (error) {
      console.error("[latex-paste] clipboard write failed", error);
      showMessage(this.i18n.commandCopyFailed);
    }
  }

  /**
   * 路径三：从思源复制出去时，把公式还原成标准 Markdown。
   *
   * 思源自己的纯文本输出里，公式是被渲染过的字符流（∂P f/∂z̄ 会压平成一串），
   * LaTeX 结构彻底没有。粘到 Obsidian / Typora 里根本不是公式。
   * 好在 HTML 层里公式节点带着 data-content 属性，能精确还原。
   *
   * 只在选区里真的有公式时才接管，其余情况一律不动，保留思源原生行为。
   */
  private onCopy = (event: ClipboardEvent) => {
    if (!this.settings.enabled || !this.settings.copyAsMarkdown) {
      return;
    }
    const data = event.clipboardData;
    if (!data) {
      return;
    }

    try {
      const result = this.selectionToMarkdown();
      if (!result) {
        return;
      }

      event.preventDefault();
      // preventDefault 之后浏览器不会再写入默认数据，所以只要不设 text/html，
      // 剪贴板里就只剩纯文本层，目标软件只能按 Markdown 源码接收。
      // （别写成 setData("text/html", "")，空 HTML 会被某些软件当成"没有内容"）
      data.setData("text/plain", result.markdown);
      if (result.siyuanHTML) {
        try {
          data.setData("text/siyuan", result.siyuanHTML);
        } catch {
          // 少数环境不认自定义 MIME 类型，忽略即可
        }
      }
      this.log("复制：已改写为 Markdown", { markdown: result.markdown });
    } catch (error) {
      console.error("[latex-paste] copy failed", error);
    }
  };

  /**
   * 显式命令兜底。
   * 思源菜单里的「复制富文本」是自己写系统剪贴板的，不经过 DOM copy 事件，
   * 上面那条拦不住，所以留一个能主动调用的入口。
   */
  private copyAsMarkdown = async () => {
    await this.writeMarkdown(this.selectionToMarkdown());
  };

  /**
   * 块图标菜单。
   *
   * 思源复制时会 preventDefault 再用 Electron 异步写系统剪贴板，
   * DOM copy 事件里改的数据会被它覆盖掉，所以从块的 DOM 主动生成才稳。
   */
  private onBlockIcon = ({ detail }: any) => {
    if (!this.settings.enabled || !this.settings.copyAsMarkdown) {
      return;
    }
    const blocks: HTMLElement[] = detail?.blockElements ?? [];
    const menu = detail?.menu;
    if (!blocks.length || !menu || typeof menu.addItem !== "function") {
      return;
    }
    menu.addItem({
      icon: "iconCopy",
      label: this.i18n.commandCopyAsMarkdown,
      click: () => {
        void this.writeMarkdown(this.blocksToMarkdown(blocks));
      },
    });
  };

  /**
   * 内容区右键菜单（选中文字后右键）。
   *
   * 只在选中的内容里确实有公式时才加这一项，免得平时右键也挂一条用不上的。
   * Markdown 在弹出菜单时就算好，点击时直接用 —— 菜单弹出后选区可能已经变了。
   */
  private onContentMenu = ({ detail }: any) => {
    if (!this.settings.enabled || !this.settings.copyAsMarkdown) {
      void this.writeMenuProbe({ skipped: "设置里没开" });
      return;
    }
    const menu = detail?.menu;
    if (!menu || typeof menu.addItem !== "function") {
      void this.writeMenuProbe({
        skipped: "detail 里没有可用的 menu",
        detailKeys: detail ? Object.keys(detail) : [],
      });
      return;
    }

    const range: Range | undefined = detail?.range;
    const result = range ? this.rangeToMarkdown(range) : this.selectionToMarkdown();
    if (!result) {
      void this.writeMenuProbe({
        skipped: "选区里没找到公式",
        hasRange: Boolean(range),
        rangeCollapsed: range?.collapsed ?? null,
      });
      return;
    }

    menu.addItem({
      icon: "iconCopy",
      label: this.i18n.commandCopyAsMarkdown,
      click: () => {
        void this.writeMarkdown(result);
      },
    });
    // 思源会把插件注入的项收进菜单末尾的「插件」子菜单，不是顶层。
    // 这里留个探针，确认到底注入成功没有。
    void this.writeMenuProbe({ injected: true, chars: result.markdown.length });
  };

  /** 右键菜单探针，写进 petal 存储，绕开打不开的开发者工具 */
  private async writeMenuProbe(info: Record<string, unknown>) {
    try {
      await this.saveData("menu-probe", { at: new Date().toISOString(), ...info });
    } catch {
      // 探针失败不影响主流程
    }
  }

  /** 一组块的 DOM → Markdown */
  private blocksToMarkdown(blocks: HTMLElement[]): { markdown: string; siyuanHTML: string } | null {
    const holder = document.createElement("div");
    for (const block of blocks) {
      holder.appendChild(block.cloneNode(true));
    }
    return this.renderMarkdown(holder);
  }

  private turndownService(): TurndownService {
    if (!this.turndown) {
      this.turndown = new TurndownService({
        headingStyle: "atx",
        hr: "---",
        bulletListMarker: "-",
        codeBlockStyle: "fenced",
        emDelimiter: "*",
        strongDelimiter: "**",
        linkStyle: "inlined",
      });
      this.turndown.use(gfm);
      this.turndown.remove(["script", "style", "noscript", "meta", "link"]);
    }
    return this.turndown;
  }

  private htmlToMarkdown(html: string, options: LatexConvertOptions): { markdown: string; count: number } {
    let bodyHtml = html;
    const segments: MathSegment[] = [];
    try {
      const doc = new DOMParser().parseFromString(html, "text/html");
      if (doc.body) {
        // 从渲染过的网页复制时，公式已经变成 KaTeX/MathJax 的 DOM，纯文本里的 $ 早没了。
        // 趁还在 DOM 上把 LaTeX 源码捞回来，否则这条路径救不回来。
        extractMathNodes(doc.body as unknown as HTMLElement, segments);
        bodyHtml = doc.body.innerHTML;
      }
    } catch {
      // DOMParser 不可用时直接用原始字符串
    }

    const { html: stashed } = stashMathInHtml(bodyHtml, segments);
    const restored = restoreMath(this.turndownService().turndown(stashed), segments);
    const result = convertLatex(restored, options);
    // 已还原成思源公式的部分 + 转换阶段新处理的定界符
    return { markdown: result.text, count: segments.length + result.count };
  }

  /** 光标在代码块 / 行内代码里时不做任何转换 */
  private isInCodeContext(): boolean {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      return false;
    }
    const anchor = selection.anchorNode;
    if (!anchor) {
      return false;
    }
    const element = anchor.nodeType === Node.TEXT_NODE ? anchor.parentElement : (anchor as HTMLElement);
    if (!element) {
      return false;
    }
    return Boolean(element.closest('[data-type="NodeCodeBlock"]') || element.closest("code"));
  }
};
