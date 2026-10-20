declare module "siyuan" {
  export class Plugin {
    constructor(options: any);
    name: string;
    i18n: Record<string, string>;
    eventBus: {
      on(type: string, listener: (event: CustomEvent<any>) => any): void;
      off(type: string, listener: (event: CustomEvent<any>) => any): void;
      once(type: string, listener: (event: CustomEvent<any>) => any): void;
    };
    setting: Setting;
    loadData(key: string): Promise<any>;
    saveData(key: string, value: any): Promise<any>;
    removeData(key: string): Promise<any>;
    addCommand(command: any): void;
    addTopBar(options: any): HTMLElement;
    addIcons(svg: string): void;
    onload(): void | Promise<void>;
    onunload(): void;
    onLayoutReady(): void;
  }

  export class Setting {
    constructor(options: { confirmCallback?: () => void; destroyCallback?: () => void });
    addItem(options: {
      title: string;
      description?: string;
      createActionElement?: () => HTMLElement;
    }): void;
    open(name: string): void;
  }

  export function showMessage(message: string, timeout?: number, type?: string): void;
}

declare module "turndown-plugin-gfm" {
  export const gfm: any;
  export const tables: any;
  export const strikethrough: any;
  export const taskListItems: any;
}

/** 思源插件以 CommonJS 形式导出插件类 */
declare const module: { exports: any };
