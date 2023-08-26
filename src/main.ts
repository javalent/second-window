import "./main.css";

import {
    App,
    Component,
    debounce,
    FileSystemAdapter,
    FuzzySuggestModal,
    MarkdownRenderer,
    Menu,
    Plugin,
    PluginSettingTab,
    sanitizeHTMLToDom,
    Setting,
    TAbstractFile,
    TextComponent,
    TFile
} from "obsidian";
import { PluginSettings, WindowState } from "./@types";

import { getType } from "mime/lite";
import { generateSlug } from "random-word-slugs";

import type { BrowserWindow } from "electron";

import { remote } from "electron";
import * as os from "os";

const DEFAULT_SETTINGS: PluginSettings = {
    saveWindowLocations: true,
    windows: {}
};

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
            extraStyleEls: HTMLStyleElement[];
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

interface Parent {
    app: App;
    settings: PluginSettings;
    saveSettings(): Promise<void>;
}

let uniqueId = 0;

class NamedWindow {
    window: BrowserWindow;
    head: HTMLHeadElement;
    stale = false;

    constructor(private parent: Parent, private name: string) {
        // no code, lazy init
    }

    rename(name: string) {
        this.name = name;
    }

    buildHead() {
        this.head = createEl("head");

        this.head.createEl("meta", {
            type: "charset",
            attr: { charset: "utf-8" }
        });

        this.head.createEl("link", {
            href: "app://obsidian.md/app.css",
            type: "text/css",
            attr: { rel: "stylesheet" }
        });
        /*  this.head.createEl("link", {
            href: this.theme,
            type: "text/css",
            attr: { rel: "stylesheet" }
        }); */
        for (const style of Array.from(
            document.head.querySelectorAll("style")
        )) {
            this.head.appendChild(style.cloneNode(true));
        }
        return this.head;
    }

    get theme() {
        return this.parent.app.vault.adapter.getResourcePath(
            `${this.parent.app.customCss.getThemeFolder()}/${
                this.parent.app.customCss.theme
            }.css`
        );
    }
    get mode() {
        return (this.parent.app.vault.config?.theme ?? "obsidian") == "obsidian"
            ? "theme-dark"
            : "theme-light";
    }
    async loadFile(file: TFile) {
        if (!(this.parent.app.vault.adapter instanceof FileSystemAdapter))
            return;

        let encoded: string;
        if (/image/.test(getType(file.extension))) {
            encoded = await this.loadImage(file);
        } else if (file.extension == "md") {
            encoded = await this.loadNote(file);
        } else {
            return;
        }
        if (!this.window) {
            this.window = new remote.BrowserWindow();
            this.window.menuBarVisible = false;
            const state: WindowState | undefined =
                this.parent.settings.windows[this.name]?.hosts?.[os.hostname()];
            if (state) {
                this.window.setBounds(state);
                this.window.setFullScreen(state.fullscreen);
                if (state.maximized) this.window.maximize();
            }
            this.window.on("close", () => {
                this.openFile = null;
                this.window = null;
            });

            const positionHandler = debounce(
                this.onMoved.bind(this),
                500,
                true
            );
            this.window.on("move", positionHandler);

            // resize is fired when the window is restored from maximized, and we need to know
            this.window.on("resize", positionHandler);
        }

        this.window.setTitle(file.name);

        await this.window.loadURL(encoded);

        this.window.moveTop();
    }
    /**
     * Save window position and size under a key specific to the host.  This way,
     * sharing the vault with a second computer with a different monitor layout will not overwrite the
     * first computer's saved state.
     * @param name
     */
    async onMoved() {
        if (!this.parent.settings.saveWindowLocations) return;
        const position = this.window.getPosition();
        const size = this.window.getSize();
        const hostname = os.hostname();
        if (!this.parent.settings.windows[this.name])
            this.parent.settings.windows[this.name] = { hosts: {} };
        this.parent.settings.windows[this.name].hosts[hostname] = {
            x: position[0],
            y: position[1],
            width: size[0],
            height: size[1],
            fullscreen: this.window.isFullScreen(),
            maximized: this.window.isMaximized()
        };
        // REVISIT don't invalidate views for this save, even if we end up having a settings dirty flag
        await this.parent.saveSettings();
    }
    onModified(file: TAbstractFile) {
        if (!this.openFile) return;
        if (this.openFile == file.path) {
            this.updateLoadedNote();
        }
    }

    openFile: string;
    async loadNote(file: TFile) {
        this.openFile = file.path;
        const content = await this.parent.app.vault.cachedRead(file);

        const doc = createEl("html");
        doc.append(this.head);

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
        await MarkdownRenderer.renderMarkdown(
            content,
            note,
            "",
            new Component()
        );

        await this.parent.app.vault.adapter.write(
            `${this.parent.app.plugins.getPluginFolder()}/image-window/file.html`,
            doc.outerHTML
        );

        doc.detach();
        return this.parent.app.vault.adapter.getResourcePath(
            `${this.parent.app.plugins.getPluginFolder()}/image-window/file.html`
        );
    }
    async loadImage(file: TFile) {
        const fragment = this.sanitizeHTMLToDom(
            `<div style="height: 100%; width: 100%;"><img src="${this.parent.app.vault.adapter.getResourcePath(
                file.path
            )}" style="height: 100%; width: 100%; object-fit: contain;"></div>`
        );

        const doc = createEl("html");
        doc.append(this.head);

        doc.createEl("body", { cls: this.mode })
            .createDiv("app-container")
            .createDiv("horizontal-main-container")
            .createDiv("workspace")
            .appendChild(fragment);

        await this.parent.app.vault.adapter.write(
            `${this.parent.app.plugins.getPluginFolder()}/image-window/file.html`,
            doc.outerHTML
        );

        doc.detach();
        return this.parent.app.vault.adapter.getResourcePath(
            `${this.parent.app.plugins.getPluginFolder()}/image-window/file.html`
        );
    }
    async updateLoadedNote() {
        const file = await this.parent.app.vault.getAbstractFileByPath(
            this.openFile
        );
        if (!(file instanceof TFile)) return;
        this.loadFile(file);
    }
    onunload() {
        if (this.window) {
            this.window.close();
        }
        console.log("Second Window unloaded.");
    }
    sanitizeHTMLToDom(html: string): DocumentFragment {
        return sanitizeHTMLToDom(html);
    }
}

const DEFAULT_WINDOW_NAME = "DEFAULT";

class ImageWindowSettingTab extends PluginSettingTab {
    constructor(private plugin: Plugin, private parent: Parent) {
        super(parent.app, plugin);
    }

    display() {
        const { containerEl } = this;

        containerEl.empty();
        containerEl.addClass("second-window-settings");
        containerEl.createEl("h2", {
            text: "Settings for Second Window Plugin"
        });

        new Setting(containerEl)
            .setName("Save Window Locations")
            .setDesc(
                "If true, window locations are saved in the plugin settings. Each computer with a different hostname has its own copy of these saved locations, so that window layouts can differ."
            )
            .addToggle((toggle) =>
                toggle
                    .setValue(this.parent.settings.saveWindowLocations)
                    .onChange(async (value) => {
                        this.parent.settings.saveWindowLocations = value;
                        if (!value) {
                            for (const window of Object.values(
                                this.parent.settings.windows
                            )) {
                                // flush all saved locations
                                window.hosts = {};
                            }
                        }
                        await this.parent.saveSettings();
                    })
            );
        this.buildWindows(this.containerEl.createDiv());
    }
    buildWindows(el: HTMLElement) {
        const additionalContainer = el.createDiv("additional-container");
        new Setting(additionalContainer)
            .setName("Add New Named Window")
            .setDesc(
                "Name windows allow you to specify specific windows to open files in."
            )
            .addButton((button) =>
                button
                    .setIcon("plus")
                    .setTooltip("Add a new window")
                    .onClick(async () => {
                        let name = generateSlug(2);
                        while (
                            this.parent.settings.windows.hasOwnProperty(name)
                        ) {
                            name = generateSlug(2);
                        }
                        this.parent.settings.windows[name] = {
                            hosts: {}
                        };
                        await this.parent.saveSettings();
                        this.display();
                    })
            );
        const additional = additionalContainer.createDiv("additional");
        for (const initialName of Object.keys(this.parent.settings.windows)) {
            if (initialName === DEFAULT_WINDOW_NAME) continue;
            const state = { collision: false, name: initialName };
            const setting = new Setting(additional).addExtraButton((button) =>
                button
                    .setIcon("trash")
                    .setTooltip("Delete this window")
                    .onClick(async () => {
                        delete this.parent.settings.windows[state.name];
                        additional.removeChild(setting.settingEl);
                        await this.parent.saveSettings();
                    })
            );
            const text = new TextComponent(setting.nameEl)
                .setValue(initialName)
                .onChange(async (value) => {
                    if (value === state.name) return;
                    if (
                        value === DEFAULT_WINDOW_NAME ||
                        this.parent.settings.windows[value] !== undefined
                    ) {
                        // collision can't be allowed, TODO how do we validate red?
                        text.inputEl.addClass("is-invalid");
                        state.collision = true;
                        return;
                    }
                    text.inputEl.removeClass("is-invalid");
                    const record = this.parent.settings.windows[state.name];
                    if (record !== undefined) {
                        this.parent.settings.windows[value] = record;
                        delete this.parent.settings.windows[state.name];
                    } else {
                        this.parent.settings.windows[value] = { hosts: {} };
                    }
                    state.name = value;
                    await this.parent.saveSettings();
                });
            text.inputEl.on("focusin", "input", () => {
                text.inputEl.select();
            });
            text.inputEl.on("focusout", "input", () => {
                if (state.collision) {
                    state.collision = false;
                    this.display();
                }
            });
        }
    }
}

export default class ImageWindow extends Plugin {
    settings: PluginSettings;
    /**
     * Default window, available even if nothing configured.
     */
    defaultWindow: NamedWindow = new NamedWindow(this, DEFAULT_WINDOW_NAME);
    /**
     * Optional, additional windows created by settings.
     */
    windows: Map<number, NamedWindow> = new Map();

    get stylesheets() {
        return document.head.innerHTML;
    }
    manifold<TArg>(handler: (arg: TArg) => void): (arg: TArg) => void {
        return (arg: TArg) => {
            handler.bind(this.defaultWindow)(arg);
            for (const window of this.windows.values()) {
                handler.bind(window)(arg);
            }
        };
    }
    async onload() {
        await this.loadSettings();
        this.app.workspace.onLayoutReady(
            this.manifold<void>(this.defaultWindow.buildHead)
        );
        this.addSettingTab(new ImageWindowSettingTab(this, this));
        this.registerEvent(
            this.app.workspace.on(
                "css-change",
                this.manifold<void>(this.defaultWindow.buildHead)
            )
        );

        this.registerEvent(
            this.app.vault.on(
                "modify",
                debounce(
                    this.manifold(this.defaultWindow.onModified),
                    500,
                    true
                )
            )
        );

        this.registerEvent(
            this.app.workspace.on("file-menu", (menu, file) => {
                if (!(this.app.vault.adapter instanceof FileSystemAdapter))
                    return;
                if (!(file instanceof TFile)) return;
                /* if (!/image/.test(getType(file.extension))) return; */

                menu.addItem((item) => {
                    item.setTitle("Open in second window")
                        .setIcon("open-elsewhere-glyph")
                        .onClick(async () => {
                            this.defaultWindow.loadFile(file);
                        });
                });
                for (const [name, record] of Object.entries(
                    this.settings.windows
                )) {
                    if (name === DEFAULT_WINDOW_NAME) continue;
                    menu.addItem((item) => {
                        item.setTitle(`Open in second window '${name}'`)
                            .setIcon("open-elsewhere-glyph")
                            .onClick(async () => {
                                const namedWindow = this.windows.get(record.id);
                                if (namedWindow !== undefined) {
                                    namedWindow.loadFile(file);
                                }
                            });
                    });
                }
            })
        );

        this.registerDomEvent(document, "contextmenu", (event: MouseEvent) => {
            const target = event.target as HTMLElement;
            if (target.localName !== "img") return;

            const imgPath = (target as HTMLImageElement).currentSrc;
            const file = this.app.vault.resolveFileUrl(imgPath)

            if (!(file instanceof TFile)) return;
            const menu = new Menu();
            menu.addItem((item) => {
                item.setTitle("Open in new window")
                    .setIcon("open-elsewhere-glyph")
                    .onClick(async () => {
                        this.defaultWindow.loadFile(file);
                    });
            });

            for (const [name, record] of Object.entries(this.settings.windows)) {
                if (name === DEFAULT_WINDOW_NAME) continue;
                menu.addItem((item) => {
                    item.setTitle(`Open in window '${name}'`)
                        .setIcon("open-elsewhere-glyph")
                        .onClick(async () => {
                            const namedWindow = this.windows.get(record.id);
                            if (namedWindow !== undefined) {
                                namedWindow.loadFile(file);
                            }
                        });
                });
            }

            menu.showAtPosition({ x: event.pageX, y: event.pageY });
        });

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
                        this.defaultWindow.loadFile(modal.file);
                    }
                };
                modal.open();
            }
        });

        console.log("Second Window loaded.");
    }

    async onunload() {
        this.manifold<void>(this.defaultWindow.onunload)();
    }

    async loadSettings() {
        this.settings = Object.assign(
            {},
            DEFAULT_SETTINGS,
            await this.loadData()
        );
        for (const [name, record] of Object.entries(this.settings.windows)) {
            record.id = uniqueId++;
            this.windows.set(record.id, new NamedWindow(this, name));
        }
    }

    async saveSettings() {
        this.updateWindows();

        // now serialize without the ids
        const temp: PluginSettings = JSON.parse(JSON.stringify(this.settings));
        for (const window of Object.values(temp.windows)) {
            delete window.id;
        }
        await this.saveData(temp);
    }

    private updateWindows() {
        for (const window of this.windows.values()) {
            window.stale = true;
        }

        // match up configuration to what we have running
        for (const key of Object.keys(this.settings.windows)) {
            const configured = this.settings.windows[key];
            const existing = this.windows.get(configured.id);
            if (existing !== undefined) {
                // matched a window
                existing.stale = false;
                existing.rename(key);
            } else {
                // added a window
                this.windows.set(configured.id, new NamedWindow(this, key));
            }
        }

        // cull
        for (const [id, window] of this.windows.entries()) {
            if (window.stale) {
                window.onunload();
                this.windows.delete(id);
            }
        }
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
