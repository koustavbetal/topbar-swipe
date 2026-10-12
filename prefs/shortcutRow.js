// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Koustav Betal

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';

// Best-effort check of the desktop's own shortcuts, so the user is warned
// before picking a combination that's already taken.
function findKeybindingConflict(accel) {
    const schemaIds = [
        'org.gnome.desktop.wm.keybindings',
        'org.gnome.shell.keybindings',
        'org.gnome.mutter.keybindings',
        'org.gnome.settings-daemon.plugins.media-keys',
    ];
    const source = Gio.SettingsSchemaSource.get_default();

    for (const schemaId of schemaIds) {
        if (!source?.lookup(schemaId, true))
            continue;
        let settings, schema;
        try {
            settings = new Gio.Settings({schema_id: schemaId});
            schema = settings.settings_schema;
        } catch {
            continue;
        }
        for (const key of schema.list_keys()) {
            let value;
            try {
                value = settings.get_value(key);
            } catch {
                continue;
            }
            if (value.get_type_string() !== 'as')
                continue;
            if (value.deep_unpack().includes(accel))
                return `${schemaId.split('.').pop()} → ${key}`;
        }
    }

    try {
        const mediaKeys = new Gio.Settings({schema_id: 'org.gnome.settings-daemon.plugins.media-keys'});
        for (const path of mediaKeys.get_strv('custom-keybindings')) {
            const cs = new Gio.Settings({
                schema_id: 'org.gnome.settings-daemon.plugins.media-keys.custom-keybinding', path,
            });
            if (cs.get_string('binding') === accel)
                return `custom shortcut "${cs.get_string('name')}"`;
        }
    } catch {
        // schema not present: skip
    }

    return null;
}

// Shortcut that opens the trigger menu while the button is hidden.
export function makeShortcutRow(settings) {
    const keyRow = new Adw.ActionRow({title: 'Shortcut', subtitle: 'Opens the menu while the button is hidden'});
    const shortcutDisplay = new Gtk.ShortcutLabel({valign: Gtk.Align.CENTER, disabled_text: 'Not set'});
    const setBtn = new Gtk.Button({
        icon_name: 'document-edit-symbolic', valign: Gtk.Align.CENTER,
        css_classes: ['flat'], tooltip_text: 'Click, then press a key combination',
    });
    const clearBtn = new Gtk.Button({
        icon_name: 'edit-clear-symbolic', valign: Gtk.Align.CENTER,
        css_classes: ['flat'], tooltip_text: 'Remove shortcut',
    });
    const conflictLabel = new Gtk.Label({css_classes: ['dim-label'], valign: Gtk.Align.CENTER, wrap: true, xalign: 1});

    const refresh = () => {
        const strv = settings.get_strv('trigger-button-key');
        shortcutDisplay.accelerator = strv.length ? strv[0] : '';
    };
    refresh();

    clearBtn.connect('clicked', () => {
        settings.set_strv('trigger-button-key', []);
        conflictLabel.set_label('');
        refresh();
    });

    setBtn.connect('clicked', () => {
        shortcutDisplay.accelerator = '';
        shortcutDisplay.disabled_text = 'Press a key… (Esc to cancel)';
        conflictLabel.set_label('');

        const controller = new Gtk.EventControllerKey();
        setBtn.add_controller(controller);
        controller.connect('key-pressed', (ctrl, keyval, keycode, state) => {
            if (keyval === Gdk.KEY_Escape) {
                setBtn.remove_controller(controller);
                shortcutDisplay.disabled_text = 'Not set';
                refresh();
                return true;
            }
            const mods = state & Gtk.accelerator_get_default_mod_mask();
            if (!Gtk.accelerator_valid(keyval, mods))
                return true; // wait for a real combo
            const accel = Gtk.accelerator_name(keyval, mods);
            setBtn.remove_controller(controller);
            shortcutDisplay.disabled_text = 'Not set';

            const conflict = findKeybindingConflict(accel);
            if (conflict) {
                conflictLabel.set_label(`⚠ Used by ${conflict}`);
            } else {
                conflictLabel.set_label('');
                settings.set_strv('trigger-button-key', [accel]);
            }
            refresh();
            return true;
        });
        setBtn.grab_focus();
    });

    keyRow.add_suffix(conflictLabel);
    keyRow.add_suffix(shortcutDisplay);
    keyRow.add_suffix(setBtn);
    keyRow.add_suffix(clearBtn);
    return keyRow;
}
