// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Koustav Betal

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';

import {RUN_ICON, DEFAULT_SCRIPT_ICON} from '../lib/common.js';

export const DIRECTIONS = ['ltr', 'rtl', 'center-out'];
export const DIRECTION_LABELS = ['Left to right', 'Right to left', 'Center outward'];

function hexFromRgba(rgba) {
    return '#' + [rgba.red, rgba.green, rgba.blue]
        .map(v => Math.round(v * 255).toString(16).padStart(2, '0'))
        .join('');
}

export function makeChoiceRow(title, settings, key, values, labels, subtitle = null) {
    const row = new Adw.ComboRow({title, subtitle, model: new Gtk.StringList({strings: labels})});
    row.set_selected(Math.max(0, values.indexOf(settings.get_string(key))));
    row.connect('notify::selected', () => settings.set_string(key, values[row.get_selected()]));
    return row;
}

export function makeDirectionRow(title, settings, key) {
    return makeChoiceRow(title, settings, key, DIRECTIONS, DIRECTION_LABELS);
}

export function makeColorButton(hex, onChange) {
    const btn = new Gtk.ColorDialogButton({
        dialog: new Gtk.ColorDialog({with_alpha: false}),
        valign: Gtk.Align.CENTER,
    });
    const c = new Gdk.RGBA();
    c.parse(hex);
    btn.set_rgba(c);
    btn.connect('notify::rgba', () => onChange(hexFromRgba(btn.get_rgba())));
    return btn;
}

export function makeColorRow(title, settings, key, subtitle = null) {
    const row = new Adw.ActionRow({title, subtitle});
    row.add_suffix(makeColorButton(settings.get_string(key), hex => settings.set_string(key, hex)));
    return row;
}

// `digits` matters: without it Adw.SpinRow rounds to integers even for a
// double key (that was the opacity bug).
export function makeSpinRow(title, subtitle, settings, key, lower, upper, step, digits = 0) {
    const row = new Adw.SpinRow({
        title, subtitle, digits,
        adjustment: new Gtk.Adjustment({lower, upper, step_increment: step}),
    });
    settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

export function makeSwitchRow(title, subtitle, settings, key) {
    const row = new Adw.SwitchRow({title, subtitle});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

export function makePreviewButton(tooltip, onClick) {
    const btn = new Gtk.Button({
        icon_name: RUN_ICON, valign: Gtk.Align.CENTER,
        css_classes: ['flat'], tooltip_text: tooltip,
    });
    btn.connect('clicked', onClick);
    return btn;
}

export function makeHeaderPreviewButton(onClick) {
    const btn = new Gtk.Button({
        child: new Adw.ButtonContent({icon_name: RUN_ICON, label: 'Preview'}),
        css_classes: ['flat'], valign: Gtk.Align.CENTER,
        tooltip_text: 'Play this on the top bar now',
    });
    btn.connect('clicked', onClick);
    return btn;
}

export function makeAddButton(tooltip) {
    return new Gtk.Button({
        icon_name: 'list-add-symbolic', css_classes: ['flat'],
        valign: Gtk.Align.CENTER, tooltip_text: tooltip,
    });
}

export function makeDeleteButton(tooltip, onClick) {
    const btn = new Gtk.Button({
        icon_name: 'user-trash-symbolic', valign: Gtk.Align.CENTER,
        css_classes: ['flat'], tooltip_text: tooltip,
    });
    btn.connect('clicked', onClick);
    return btn;
}

// Settings signals connected by Preferences. prefs.js drops them all when
// the window closes, so no handler outlives the widgets it updates.
const settingsHandlers = new WeakMap();

export function connectSetting(settings, key, fn) {
    const id = settings.connect(`changed::${key}`, fn);
    if (!settingsHandlers.has(settings))
        settingsHandlers.set(settings, new Set());
    settingsHandlers.get(settings).add(id);
    return id;
}

// Safe to call twice: only disconnects an id it still holds.
export function disconnectSetting(settings, id) {
    if (settingsHandlers.get(settings)?.delete(id))
        settings.disconnect(id);
}

export function disconnectSettings(settings) {
    settingsHandlers.get(settings)?.forEach(id => settings.disconnect(id));
    settingsHandlers.delete(settings);
}

// Adw.AlertDialog on libadwaita 1.5+, Adw.MessageDialog before that.
function presentDialog(dialog, parent) {
    if (Adw.AlertDialog) {
        dialog.present(parent);
    } else {
        dialog.set_transient_for(parent);
        dialog.present();
    }
}

// A yes/no question with a red confirm button.
export function confirmDestructive(parent, heading, body, confirmLabel, onConfirm) {
    const Dialog = Adw.AlertDialog ?? Adw.MessageDialog;
    const dialog = new Dialog({heading, body});
    dialog.add_response('cancel', 'Cancel');
    dialog.add_response('confirm', confirmLabel);
    dialog.set_response_appearance('confirm', Adw.ResponseAppearance.DESTRUCTIVE);
    dialog.set_default_response('cancel');
    dialog.set_close_response('cancel');
    dialog.connect('response', (d, response) => {
        if (response === 'confirm')
            onConfirm();
    });
    presentDialog(dialog, parent);
}

// The running extension listens to this key and plays the reaction.
export function sendTest(settings, payload) {
    settings.set_string('test-trigger', JSON.stringify({...payload, t: Date.now()}));
}

// A JSON-array setting for an editor; anything malformed reads as empty.
export function loadJsonList(settings, key) {
    try {
        const value = JSON.parse(settings.get_string(key));
        return Array.isArray(value) ? value : [];
    } catch {
        return [];
    }
}

export function setImageIcon(image, name) {
    if (name && name.startsWith('/'))
        image.set_from_file(name);
    else
        image.set_from_icon_name(name || DEFAULT_SCRIPT_ICON);
}

// Adw.AlertDialog on libadwaita 1.5+, Adw.MessageDialog before that.
export function askForText(parent, heading, body, current, onSave) {
    const entry = new Gtk.Entry({text: current, activates_default: true, hexpand: true});
    const Dialog = Adw.AlertDialog ?? Adw.MessageDialog;
    const dialog = new Dialog({heading, body});
    dialog.add_response('cancel', 'Cancel');
    dialog.add_response('save', 'Save');
    dialog.set_response_appearance('save', Adw.ResponseAppearance.SUGGESTED);
    dialog.set_default_response('save');
    dialog.set_close_response('cancel');
    dialog.set_extra_child(entry);
    dialog.connect('response', (d, response) => {
        if (response === 'save')
            onSave(entry.get_text());
    });
    presentDialog(dialog, parent);
}

// Tabs inside one preferences page.
export function makeTabbed(tabs) {
    const stack = new Gtk.Stack({transition_type: Gtk.StackTransitionType.CROSSFADE});
    const switcher = new Gtk.StackSwitcher({stack, halign: Gtk.Align.CENTER, margin_bottom: 6});

    const wrapper = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 12});
    wrapper.append(switcher);
    wrapper.append(stack);

    const group = new Adw.PreferencesGroup();
    group.add(wrapper);

    tabs.forEach(tab => {
        const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 18});
        tab.build(box);
        stack.add_titled(box, tab.id, tab.title);
    });

    return {group, stack};
}
