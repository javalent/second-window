import "./main.css";

import {
    App,
    FileSystemAdapter,
    FuzzySuggestModal,
    MarkdownRenderer,
    Plugin,
    Plugin_2,
    TFile
} from "obsidian";
import { PluginSettings } from "./@types";

import { getType } from "mime/lite";

import type { BrowserWindow } from "electron";

import { remote } from "electron";

const DEFAULT_SETTINGS: PluginSettings = {};

declare global {
    interface Window {
        DOMPurify: {
            sanitize(
                html: string,
                options: Record<string, any>
            ): DocumentFragment;
        };
    }
}

declare module "obsidian" {
    interface App {
        customCss: {
            enabledSnippets: string[];
            getSnippetsFolder(): string;
            getThemeFolder(): string;
            theme: string;
        };
        plugins: {
            plugins: Record<string, Plugin>;
            getPluginFolder(): string;
        };
    }
    interface Vault {
        config: {
            theme?: "obsidian" | "moonstone";
        };
    }
    interface Plugin {
        _loaded: boolean;
    }
}

export default class ImageWindow extends Plugin {
    settings: PluginSettings;
    window: BrowserWindow;
    get stylesheets() {
        return document.head.innerHTML;
    }
    async onload() {
        await this.loadSettings();

        this.registerEvent(
            this.app.workspace.on("file-menu", (menu, file) => {
                if (!(this.app.vault.adapter instanceof FileSystemAdapter))
                    return;
                if (!(file instanceof TFile)) return;
                /* if (!/image/.test(getType(file.extension))) return; */

                menu.addItem((item) => {
                    item.setTitle("Open in new window")
                        .setIcon("open-elsewhere-glyph")
                        .onClick(async () => {
                            this.loadFile(file);
                        });
                });
            })
        );

        this.addCommand({
            id: "open-image",
            name: "Open image in new window",
            callback: () => {
                const files = this.app.vault
                    .getFiles()
                    .filter((file) => /image/.test(getType(file.extension)));
                const modal = new Suggester(files, this.app);
                modal.onClose = () => {
                    if (modal.file) {
                        this.loadFile(modal.file);
                    }
                };
                modal.open();
            }
        });

        console.log("Image Window loaded.");
    }
    buildHead() {
        const head = createEl("head");
        head.createEl("link", {
            href: "app://obsidian.md/app.css",
            type: "text/css",
            attr: { rel: "stylesheet" }
        });
        head.createEl("link", {
            href: this.theme,
            type: "text/css",
            attr: { rel: "stylesheet" }
        });

        for (const snippet of this.app.customCss.enabledSnippets) {
            head.createEl("link", {
                href: this.app.vault.adapter.getResourcePath(
                    `${this.app.customCss.getSnippetsFolder()}/${snippet}.css`
                ),
                type: "text/css",
                attr: { rel: "stylesheet" }
            });
        }
        for (const plugin of Object.keys(this.app.plugins.plugins)) {
            if (!this.app.plugins.plugins[plugin]._loaded) continue;
            head.createEl("link", {
                href: this.app.vault.adapter.getResourcePath(
                    `${this.app.plugins.getPluginFolder()}/${plugin}/styles.css`
                ),
                type: "text/css",
                attr: { rel: "stylesheet" }
            });
        }
        return head;
    }
    async loadImage(file: TFile) {
        const fragment = this.sanitizeHTMLToDom(
            `<div style="height: 100%; width: 100%;"><img src="${this.app.vault.adapter.getResourcePath(
                file.path
            )}" style="height: 100%; width: 100%; object-fit: contain;"></div>`
        );

        const html = createDiv();
        html.appendChild(fragment);

        const encoded =
            "data:text/html;charset=utf-8," + encodeURI(html.innerHTML);

        html.detach();
        return encoded;
    }
    get theme() {
        return this.app.vault.adapter.getResourcePath(
            `${this.app.customCss.getThemeFolder()}/${
                this.app.customCss.theme
            }.css`
        );
    }
    get mode() {
        return (this.app.vault.config?.theme ?? "obsidian") == "obsidian"
            ? "theme-dark"
            : "theme-light";
    }
    async loadFile(file: TFile) {
        if (!(this.app.vault.adapter instanceof FileSystemAdapter)) return;

        let encoded: string;
        if (/image/.test(getType(file.extension))) {
            encoded = await this.loadImage(file);
            if (!this.window) {
                this.window = new remote.BrowserWindow();

                this.window.on("close", () => (this.window = null));
            }

            await this.window.loadURL(encoded);

            this.window.moveTop();
        } else if (file.extension == "md") {
            const content = await this.app.vault.cachedRead(file);

            const doc = createEl("html");
            doc.append(this.buildHead());

            const note = doc
                .createEl("body", { cls: this.mode })
                .createDiv("app-container")
                .createDiv("horizontal-main-container")
                .createDiv("workspace")
                .createDiv("workspace-split mod-vertical mod-root")
                .createDiv("workspace-leaf mod-active")
                .createDiv("workspace-leaf-content")
                .createDiv("view-content")
                .createDiv("markdown-reading-view")
                .createDiv("markdown-preview-view")
                .createDiv("markdown-preview-sizer markdown preview-section");

            await MarkdownRenderer.renderMarkdown(content, note, "", null);

            await this.app.vault.adapter.write(
                `${this.app.plugins.getPluginFolder()}/image-window/file.html`,
                doc.outerHTML
            );
            if (!this.window) {
                this.window = new remote.BrowserWindow();

                this.window.on("close", () => (this.window = null));
            }

            await this.window.loadURL(
                this.app.vault.adapter.getResourcePath(
                    `${this.app.plugins.getPluginFolder()}/image-window/file.html`
                )
            );

            this.window.moveTop();
            /*  encoded =
                "data:text/html;charset=utf-8," + encodeURI(doc.innerHTML);
            doc.detach(); */
        } else {
            return;
        }
    }

    onunload() {
        if (this.window) {
            this.window.close();
        }
        console.log("Image Window unloaded.");
    }

    async loadSettings() {
        this.settings = Object.assign(
            {},
            DEFAULT_SETTINGS,
            await this.loadData()
        );
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }
    sanitizeHTMLToDom(html: string): DocumentFragment {
        return window.DOMPurify.sanitize(html, {
            ALLOW_UNKNOWN_PROTOCOLS: true,
            RETURN_DOM_FRAGMENT: true,
            RETURN_DOM_IMPORT: true,
            FORBID_TAGS: ["style"]
            /* ADD_TAGS: ["iframe"],
            ADD_ATTR: [
                "frameborder",
                "allowfullscreen",
                "allow",
                "aria-label-position"
            ] */
        });
    }
}

class Suggester extends FuzzySuggestModal<TFile> {
    file: TFile;
    constructor(public files: TFile[], app: App) {
        super(app);
    }
    getItemText(item: TFile) {
        return item.basename;
    }
    getItems(): TFile[] {
        return this.files;
    }
    onChooseItem(item: TFile, evt: MouseEvent | KeyboardEvent) {
        this.file = item;
        this.close();
    }
}
