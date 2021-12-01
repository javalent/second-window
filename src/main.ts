import "./main.css";

import {
    App,
    FileSystemAdapter,
    FuzzySuggestModal,
    Plugin,
    TFile
} from "obsidian";
import { PluginSettings } from "./@types";

import { getType } from "mime/lite";

import type { BrowserWindow } from "electron";

const DEFAULT_SETTINGS: PluginSettings = {};

export default class ImageWindow extends Plugin {
    settings: PluginSettings;
    window: BrowserWindow;
    async onload() {
        await this.loadSettings();

        this.registerEvent(
            this.app.workspace.on("file-menu", (menu, file) => {
                if (!(file instanceof TFile)) return;
                if (!/image/.test(getType(file.extension))) return;
                if (!(this.app.vault.adapter instanceof FileSystemAdapter))
                    return;

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
    }
    async loadFile(file: TFile) {
        if (!(this.app.vault.adapter instanceof FileSystemAdapter)) return;

        const html = `<div style="height: 100%; width: 100%;"><img src="${this.app.vault.adapter.getFullPath(
            file.path
        )}" style="height: 100%; width: 100%; object-fit: contain;"></div>`;

        const encoded = "data:text/html;charset=utf-8," + encodeURI(html);

        if (!this.window) {
            const remote = require("electron").remote;

            this.window = new remote.BrowserWindow({
                webPreferences: {
                    webSecurity: false
                }
            });

            this.window.on("close", () => (this.window = null));
        }
        await this.window.loadURL(encoded);
        this.window.moveTop();
    }

    openImageModal() {}

    onunload() {
        if (this.window) {
            this.window.close();
        }
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
