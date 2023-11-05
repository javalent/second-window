export interface PluginSettings {
    saveWindowLocations: boolean;
    /**
     * indexed by configured window name, plus the default window at "DEFAULT"
     */ 
    windows: Record<string, WindowSettings>;

    autoplayVideos: boolean;
    
    showVideoControls: boolean;
}

export interface WindowSettings {
    /**
     * not serialized
     */
    id?: number;

    /**
     * indexed by host name
     */
    hosts: Record<string, WindowState>;
}

export interface WindowState {
    width: number;
    height: number;
    x: number;
    y: number;
    maximized: boolean;
    fullscreen: boolean;
}
