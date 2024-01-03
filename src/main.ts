import "./main.css";

import {
    App,
    Component,
    debounce,
    FileSystemAdapter,
    FuzzySuggestModal,
    Menu,
    Plugin,
    PluginSettingTab,
    Setting,
    TextComponent,
    TFile,
    WorkspaceLeaf,
    WorkspaceWindow
} from "obsidian";
import { PluginSettings, WindowState } from "./@types";
import type { BrowserWindow } from "electron";

import { getType } from "mime/lite";
import { generateSlug } from "random-word-slugs";

import * as os from "os";

const DEFAULT_WINDOW_NAME = "Second Window";

const DEFAULT_SETTINGS: PluginSettings = {
    saveWindowLocations: true,
    useCustomWindowName: false,
    customWindowName: DEFAULT_WINDOW_NAME,
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
        electronWindow: BrowserWindow;
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
        resolveFileUrl(path: string): TFile;
    }
    interface Plugin {
        _loaded: boolean;
    }
    interface View {
        headerEl: HTMLDivElement;
        contentEl: HTMLDivElement;
    }
    interface WorkspaceLeaf {
        parent: WorkspaceTabs;
    }
    interface WorkspaceTabs {
        tabHeaderContainerEl: HTMLDivElement;
    }
    interface WorkspaceWindow {
        rootEl: HTMLDivElement;
    }
}

interface Parent {
    app: App;
    settings: PluginSettings;
    saveSettings(): Promise<void>;
}

let uniqueId = 0;

class NamedWindow extends Component {
    window: WorkspaceWindow;
    stale = false;
    leaf: WorkspaceLeaf;

    constructor(private parent: Parent, private name: string) {
        super();
        this.load();
    }

    rename(name: string) {
        this.name = name;
    }

    adjust(leaf: WorkspaceLeaf, image: boolean) {
        let parent = leaf.parent;
        parent.tabHeaderContainerEl.empty();
        this.leaf.view.headerEl.empty();

        if (image) {
            this.leaf.view.contentEl
                .querySelector("img")
                ?.setAttr(
                    "style",
                    "height: 100%; width: 100%; object-fit: contain"
                );
        }
    }

    async loadFile(file: TFile) {
        if (!(this.parent.app.vault.adapter instanceof FileSystemAdapter))
            return;
        if (!this.window) {
            const state: WindowState | undefined =
                this.parent.settings.windows[this.name]?.hosts?.[os.hostname()];

            this.leaf = this.parent.app.workspace.openPopoutLeaf();
            this.window = this.leaf.getContainer() as WorkspaceWindow;

            if (state) {
                this.window.win.electronWindow.setBounds(state);
                this.window.win.electronWindow.setFullScreen(state.fullscreen);
                if (state.maximized) this.window.win.electronWindow.maximize();
            }
            this.window.win.electronWindow.on("close", () => {
                this.window = null;
            });
            this.registerEvent(
                this.parent.app.workspace.on("window-close", (win, window) => {
                    if (win == this.window) {
                        this.window = null;
                    }
                })
            );

            const positionHandler = debounce(
                this.onMoved.bind(this),
                500,
                true
            );
            this.window.win.electronWindow.on("move", positionHandler);

            // resize is fired when the window is restored from maximized, and we need to know
            this.window.win.electronWindow.on("resize", positionHandler);
            this.window.win.electronWindow.on(
                "enter-full-screen",
                positionHandler
            );
            this.window.win.electronWindow.on(
                "leave-full-screen",
                positionHandler
            );
        }

        await this.leaf.openFile(file, { state: { mode: "preview" } });

        this.window.rootEl.querySelector(".status-bar")?.detach();
        this.adjust(this.leaf, /image/.test(getType(file.extension)));
        if (this.parent.settings.useCustomWindowName) {
            this.window.win.electronWindow.setTitle(
                this.name !== DEFAULT_WINDOW_NAME
                    ? this.name
                    : this.parent.settings.customWindowName
            );
        } else {
            this.window.win.electronWindow.setTitle(file.name);
        }
    }
    /**
     * Save window position and size under a key specific to the host.  This way,
     * sharing the vault with a second computer with a different monitor layout will not overwrite the
     * first computer's saved state.
     * @param name
     */
    async onMoved() {
        if (!this.parent.settings.saveWindowLocations) return;
        const position = this.window.win.electronWindow.getPosition();
        const size = this.window.win.electronWindow.getSize();
        const hostname = os.hostname();
        if (!this.parent.settings.windows[this.name])
            this.parent.settings.windows[this.name] = { hosts: {} };
        this.parent.settings.windows[this.name].hosts[hostname] = {
            x: position[0],
            y: position[1],
            width: size[0],
            height: size[1],
            fullscreen: this.window.win.electronWindow.isFullScreen(),
            maximized: this.window.win.electronWindow.isMaximized()
        };
        // REVISIT don't invalidate views for this save, even if we end up having a settings dirty flag
        await this.parent.saveSettings();
    }

    onunload() {
        if (this.window) {
            this.window.win.electronWindow.close();
        }
        console.log("Second Window unloaded.");
    }
}

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

        new Setting(containerEl)
            .setName("Use Custom Window Name")
            .setDesc(
                "If true, use a custom window name instead of the file name. Set as window's name when using named windows."
            )
            .addToggle((toggle) =>
                toggle
                    .setValue(this.parent.settings.useCustomWindowName)
                    .onChange(async (value) => {
                        this.parent.settings.useCustomWindowName = value;
                        await this.parent.saveSettings();
                        this.display();
                    })
            );

        if (this.parent.settings.useCustomWindowName) {
            new Setting(containerEl)
                .setName("Custom Window Name")
                .setDesc(
                    "The custom window name to show when not using named windows."
                )
                .addText((text) =>
                    text
                        .setValue(this.parent.settings.customWindowName)
                        .onChange(async (value) => {
                            this.parent.settings.customWindowName = value;
                            await this.parent.saveSettings();
                        })
                );
        }

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
    async onload() {
        await this.loadSettings();
        if ("DEFAULT" in this.settings.windows) {
            this.settings.windows[DEFAULT_WINDOW_NAME] = {
                ...this.settings.windows.DEFAULT
            };
            delete this.settings.windows.DEFAULT;
        }
        this.addSettingTab(new ImageWindowSettingTab(this, this));

        this.registerEvent(
            this.app.workspace.on("file-menu", (menu, file) => {
                if (!(this.app.vault.adapter instanceof FileSystemAdapter))
                    return;
                if (!(file instanceof TFile)) return;

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
            const file = this.app.vault.resolveFileUrl(imgPath);

            if (!(file instanceof TFile)) return;
            const menu = new Menu();
            menu.addItem((item) => {
                item.setTitle("Open in new window")
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
        this.defaultWindow.unload();
        for (const window of this.windows.values()) {
            window.unload();
        }
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
