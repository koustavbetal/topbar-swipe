// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Koustav Betal

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';

import {confirmDestructive} from './widgets.js';

// Kept on reset: internal bookkeeping, not user choices.
const KEEP_ON_RESET = new Set(['welcome-shown', 'test-trigger']);

function makeLinkRow(window, title, subtitle, uri) {
    const row = new Adw.ActionRow({title, subtitle, activatable: true, use_markup: false});
    row.add_suffix(new Gtk.Image({icon_name: 'adw-external-link-symbolic'}));
    row.connect('activated', () => new Gtk.UriLauncher({uri}).launch(window, null, null));
    return row;
}

export function buildAboutPage(window, settings, metadata) {
    const page = new Adw.PreferencesPage({title: 'About', icon_name: 'help-about-symbolic'});
    window.add(page);

    const header = new Adw.PreferencesGroup();
    page.add(header);
    const box = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL, spacing: 8,
        halign: Gtk.Align.CENTER, margin_top: 24, margin_bottom: 12,
    });
    box.append(new Gtk.Image({icon_name: 'topbar-swipe', pixel_size: 96}));
    box.append(new Gtk.Label({label: metadata.name, css_classes: ['title-1']}));
    const version = metadata['version-name'] ?? String(metadata.version ?? '');
    box.append(new Gtk.Label({label: `${version ? `v${version} · ` : ''}Made with ❤ by Koustav`, css_classes: ['dim-label']}));
    header.add(box);

    const repo = metadata.url;
    const links = new Adw.PreferencesGroup({title: 'Links'});
    page.add(links);
    links.add(makeLinkRow(window, "What's New", 'Release notes for every version', `${repo}/releases`));
    links.add(makeLinkRow(window, 'Source Code', repo, repo));
    links.add(makeLinkRow(window, 'Report an Issue', `${repo}/issues`, `${repo}/issues`));
    links.add(makeLinkRow(window, 'Website', 'https://koustavbetal.github.io', 'https://koustavbetal.github.io'));
    links.add(makeLinkRow(window, 'License', 'GPL-2.0-or-later', `${repo}/blob/main/LICENSE`));

    const updates = new Adw.PreferencesGroup({
        title: 'Updates',
        description: 'Installed from extensions.gnome.org, updates arrive automatically ' +
            'through the Extensions app. Installed from source, pull the latest code from GitHub.',
    });
    page.add(updates);
    updates.add(makeLinkRow(window, 'Latest Release', 'See if a newer version is out', `${repo}/releases/latest`));

    const danger = new Adw.PreferencesGroup({title: 'Reset'});
    page.add(danger);
    const resetRow = new Adw.ActionRow({
        title: 'Reset All Settings',
        subtitle: 'Every option goes back to its default, and your rules, scripts, schedules and shortcut are deleted',
    });
    const resetBtn = new Gtk.Button({
        label: 'Reset…', valign: Gtk.Align.CENTER, css_classes: ['destructive-action'],
    });
    resetBtn.connect('clicked', () => confirmDestructive(window,
        'Reset all settings?',
        'All notification rules, scripts, schedules and the keyboard shortcut will be deleted, ' +
        'and every option goes back to its default. This can\'t be undone.\n\n' +
        'Preferences will close afterwards.',
        'Reset Everything',
        () => {
            settings.settings_schema.list_keys()
                .filter(key => !KEEP_ON_RESET.has(key))
                .forEach(key => settings.reset(key));
            // Lists and pickers were built from the old values, so close
            // rather than show stale rows.
            window.close();
        }));
    resetRow.add_suffix(resetBtn);
    danger.add(resetRow);
}
