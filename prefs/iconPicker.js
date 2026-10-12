// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Koustav Betal

import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';

import {setImageIcon} from './widgets.js';

let iconNames = null;
function installedIconNames() {
    // Every icon in the current theme chain (Adwaita + hicolor + extras).
    // The top bar uses the same theme, so anything listed here renders.
    if (!iconNames) {
        const theme = Gtk.IconTheme.get_for_display(Gdk.Display.get_default());
        // The extension's own icon first, then the theme's.
        iconNames = [...new Set(['topbar-swipe-symbolic', ...theme.get_icon_names().sort()])];
    }
    return iconNames;
}

// A button showing the current icon; its popover has a searchable grid of
// installed icons plus a free-text entry for a name or file path.
export function makeIconPicker(current, onChange) {
    const preview = new Gtk.Image();
    setImageIcon(preview, current);
    const button = new Gtk.MenuButton({
        child: preview, valign: Gtk.Align.CENTER, tooltip_text: 'Choose icon',
    });

    const popover = new Gtk.Popover();
    const box = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL, spacing: 8,
        margin_top: 8, margin_bottom: 8, margin_start: 8, margin_end: 8,
    });
    popover.set_child(box);
    button.set_popover(popover);

    const entry = new Gtk.Entry({
        text: current || '', placeholder_text: 'Icon name, or /path/to/icon.svg', width_chars: 30,
    });
    const choose = name => {
        if (!name)
            return;
        setImageIcon(preview, name);
        entry.set_text(name);
        onChange(name);
    };
    entry.connect('activate', () => {
        choose(entry.get_text().trim());
        popover.popdown();
    });

    // The grid is built the first time the popover opens, so a page full
    // of script rows doesn't load the whole theme up front.
    let built = false;
    popover.connect('show', () => {
        if (built)
            return;
        built = true;

        const search = new Gtk.SearchEntry({placeholder_text: 'Search installed icons'});
        const symbolicOnly = new Gtk.CheckButton({label: 'Symbolic only', active: true});
        const countLabel = new Gtk.Label({css_classes: ['dim-label', 'caption'], hexpand: true, xalign: 1});

        const filter = new Gtk.CustomFilter();
        filter.set_filter_func(item => {
            const n = item.get_string();
            if (symbolicOnly.get_active() && !n.endsWith('-symbolic'))
                return false;
            const q = search.get_text().trim().toLowerCase();
            return !q || n.includes(q);
        });
        const filtered = new Gtk.FilterListModel({model: Gtk.StringList.new(installedIconNames()), filter});

        const factory = new Gtk.SignalListItemFactory();
        factory.connect('setup', (f, item) => item.set_child(new Gtk.Image({
            pixel_size: 24, margin_top: 8, margin_bottom: 8, margin_start: 8, margin_end: 8,
        })));
        factory.connect('bind', (f, item) => {
            const name = item.get_item().get_string();
            const img = item.get_child();
            img.set_from_icon_name(name);
            img.set_tooltip_text(name);
        });
        const grid = new Gtk.GridView({
            model: new Gtk.NoSelection({model: filtered}), factory,
            min_columns: 8, max_columns: 8, single_click_activate: true,
        });
        grid.connect('activate', (g, pos) => {
            choose(filtered.get_item(pos).get_string());
            popover.popdown();
        });

        const refresh = () => {
            filter.changed(Gtk.FilterChange.DIFFERENT);
            countLabel.set_label(`${filtered.get_n_items()} icons`);
        };
        search.connect('search-changed', refresh);
        symbolicOnly.connect('toggled', refresh);

        const toolbar = new Gtk.Box({spacing: 8});
        toolbar.append(symbolicOnly);
        toolbar.append(countLabel);

        box.append(search);
        box.append(toolbar);
        box.append(new Gtk.ScrolledWindow({
            child: grid, min_content_height: 280, min_content_width: 400,
            hscrollbar_policy: Gtk.PolicyType.NEVER,
        }));
        box.append(entry);
        refresh();
        search.grab_focus();
    });

    return button;
}
