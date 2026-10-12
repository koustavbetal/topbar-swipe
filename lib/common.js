// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Koustav Betal

// Shared by the shell side (extension.js) and Preferences (prefs.js), so it
// must stay plain JavaScript: no St/Clutter/Shell and no Gtk/Adw/Gdk here.

export const DEFAULT_SCRIPT_ICON = 'utilities-terminal-symbolic';
export const RUN_ICON = 'media-playback-start-symbolic';

export function hexToRgb(hex) {
    hex = (hex || '#50a0ff').replace('#', '');
    const r = parseInt(hex.substring(0, 2), 16);
    const g = parseInt(hex.substring(2, 4), 16);
    const b = parseInt(hex.substring(4, 6), 16);
    return [r, g, b];
}

// A JSON-array string setting; anything malformed reads as an empty list.
export function getJsonArray(settings, key) {
    try {
        const value = JSON.parse(settings.get_string(key));
        return Array.isArray(value) ? value : [];
    } catch (e) {
        console.error(`topbar-swipe: invalid JSON in "${key}"`, e);
        return [];
    }
}
