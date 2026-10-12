// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Koustav Betal

import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {DEFAULT_SCRIPT_ICON} from './common.js';

const DEFAULT_PREVIEW_TEXT = 'Your output will appear here!!';

// Icons shipped in the extension's icons/ folder, usable by name.
const OWN_ICONS = ['topbar-swipe-symbolic', 'topbar-swipe'];

// lib/ui.js -> <extension>/icons
function ownIconFile(name) {
    const [libFile] = GLib.filename_from_uri(import.meta.url);
    const root = GLib.path_get_dirname(GLib.path_get_dirname(libFile));
    return Gio.File.new_for_path(GLib.build_filenamev([root, 'icons', `${name}.svg`]));
}

// A themed icon name, one of our own icons, or an absolute path to an
// icon file. Files ending in -symbolic.svg are recolored like theme icons.
export function makeIcon(name, styleClass) {
    const params = {style_class: styleClass, fallback_icon_name: DEFAULT_SCRIPT_ICON};
    if (name && name.startsWith('/'))
        params.gicon = Gio.FileIcon.new(Gio.File.new_for_path(name));
    else if (OWN_ICONS.includes(name))
        params.gicon = Gio.FileIcon.new(ownIconFile(name));
    else
        params.icon_name = name || DEFAULT_SCRIPT_ICON;
    return new St.Icon(params);
}

export function outputFontStyle(settings) {
    const font = settings.get_string('output-label-font') || 'Sans';
    const size = settings.get_int('output-label-font-size');
    const bold = settings.get_boolean('output-label-bold');
    return `font-family: "${font.replace(/"/g, '')}"; font-size: ${size}px;${bold ? ' font-weight: bold;' : ''}`;
}

export function previewText(settings) {
    return settings.get_string('output-preview-text') || DEFAULT_PREVIEW_TEXT;
}
