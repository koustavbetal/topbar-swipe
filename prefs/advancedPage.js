// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Koustav Betal

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';

import {DEFAULT_SCRIPT_ICON} from '../lib/common.js';
import {makeIconPicker} from './iconPicker.js';
import {ScriptRow} from './rows.js';
import {makeShortcutRow} from './shortcutRow.js';
import {buildScheduleTab} from './scheduleTab.js';
import {
    makeChoiceRow, makeSwitchRow, makeSpinRow, makeAddButton,
    askForText, makeTabbed, sendTest, loadJsonList, connectSetting,
} from './widgets.js';

// '' = hide that line.
const TIME_FORMATS = ['%H:%M', '%I:%M %p', '%H:%M:%S', ''];
const DATE_FORMATS = ['%A, %d %B', '%a %d %b', '%A, %d %B %Y', '%d/%m/%Y', ''];
const DEFAULT_PREVIEW_TEXT = 'Your output will appear here!!';

export function buildAdvancedPage(window, settings) {
    const page = new Adw.PreferencesPage({title: 'Advanced', icon_name: 'applications-engineering-symbolic'});
    window.add(page);

    const master = new Adw.PreferencesGroup({
        title: 'Trigger Button', description: 'Run your own scripts from the top bar. Hide the button or turn this off if you don\'t need it.',
    });
    page.add(master);
    master.add(makeSwitchRow('Enabled', null, settings, 'api-enabled'));
    // Older versions stored "Hidden" as a position; it was always shown
    // in the center, so that becomes hidden + center.
    if (settings.get_string('trigger-button-position') === 'key') {
        settings.set_boolean('trigger-button-hidden', true);
        settings.set_string('trigger-button-position', 'center');
    }
    master.add(makeChoiceRow('Position', settings, 'trigger-button-position',
        ['left', 'center', 'right'], ['Left', 'Center', 'Right'],
        'Where the button sits and the menu opens'));
    master.add(makeSwitchRow('Hide button',
        'Open the menu with a shortcut instead; it still opens at the position above',
        settings, 'trigger-button-hidden'));

    // Only meaningful (and only active) when the button is hidden.
    const shortcutRow = makeShortcutRow(settings);
    master.add(shortcutRow);
    settings.bind('trigger-button-hidden', shortcutRow, 'visible', Gio.SettingsBindFlags.GET);

    const iconRow = new Adw.ActionRow({title: 'Icon'});
    iconRow.add_suffix(makeIconPicker(settings.get_string('trigger-button-icon'),
        name => settings.set_string('trigger-button-icon', name)));
    master.add(iconRow);

    master.add(makeHeaderExpander(settings));
    master.add(makeMenuItemsExpander(settings));

    const outputGroup = new Adw.PreferencesGroup({
        title: 'Output', description: 'Where a script’s answer appears. It stays in the menu until you dismiss it.',
    });
    page.add(outputGroup);
    outputGroup.add(makeSwitchRow('Show on the top bar', 'Click the text to dismiss it', settings, 'output-panel-enabled'));
    outputGroup.add(makeChoiceRow('Top bar position', settings, 'output-panel-position',
        ['left', 'center', 'right'], ['Left', 'Center', 'Right']));
    outputGroup.add(makeSpinRow('Loops before hiding', 'Text that fits stays 3 s per loop. 0 keeps it until clicked',
        settings, 'output-panel-loops', 0, 50, 1));
    outputGroup.add(makeSpinRow('Max width (px)', 'Longer text scrolls like a ticker', settings, 'output-panel-max-width', 80, 2000, 10));
    outputGroup.add(makeFontRow(settings));
    outputGroup.add(makePreviewTextRow(window, settings));

    const {group: tabs} = makeTabbed([
        {id: 'scripts', title: 'Scripts', build: box => buildScriptsGroup(box, settings)},
        {id: 'schedule', title: 'Schedule', build: box => buildScheduleTab(box, settings)},
    ]);
    page.add(tabs);
}

function makeHeaderExpander(settings) {
    const sample = fmt => (fmt ? GLib.DateTime.new_now_local().format(fmt) ?? fmt : 'Hidden');
    // The switch lives on the row itself; the formats are inside.
    const expander = new Adw.ExpanderRow({title: 'Menu Header', show_enable_switch: true, use_markup: false});
    settings.bind('menu-clock-enabled', expander, 'enable-expansion', Gio.SettingsBindFlags.DEFAULT);

    const sync = () => {
        const parts = [settings.get_string('menu-clock-time-format'), settings.get_string('menu-clock-date-format')]
            .filter(Boolean).map(sample);
        expander.set_subtitle(settings.get_boolean('menu-clock-enabled')
            ? `Date and time: ${parts.length ? parts.join('  ·  ') : 'both lines hidden'}`
            : 'Date and time off (settings button only)');
    };
    addFormatRows(expander, settings, 'menu-clock-time-format', 'Time (large, top line)', TIME_FORMATS, sample, sync);
    addFormatRows(expander, settings, 'menu-clock-date-format', 'Date (second line)', DATE_FORMATS, sample, sync);
    connectSetting(settings, 'menu-clock-enabled', sync);
    sync();
    return expander;
}

// A preset dropdown (labels rendered with the current time) plus a
// "Custom" entry that only shows when chosen.
function addFormatRows(expander, settings, key, title, presets, sample, onChange) {
    const combo = new Adw.ComboRow({
        title, model: new Gtk.StringList({strings: [...presets.map(sample), 'Custom']}),
    });
    const custom = new Adw.EntryRow({title: `${title}: custom format (e.g. %H:%M)`});
    custom.set_text(settings.get_string(key));

    const idx = presets.indexOf(settings.get_string(key));
    combo.set_selected(idx >= 0 ? idx : presets.length);
    custom.set_visible(idx < 0);

    combo.connect('notify::selected', () => {
        const i = combo.get_selected();
        const isCustom = i >= presets.length;
        custom.set_visible(isCustom);
        settings.set_string(key, isCustom ? custom.get_text() : presets[i]);
    });
    custom.connect('changed', () => {
        if (custom.get_visible())
            settings.set_string(key, custom.get_text());
    });
    connectSetting(settings, key, onChange);

    expander.add_row(combo);
    expander.add_row(custom);
}

function makeMenuItemsExpander(settings) {
    const keys = [['menu-show-icon', 'Icon'], ['menu-show-name', 'Name'], ['menu-show-run', 'Run arrow']];
    const expander = new Adw.ExpanderRow({title: 'Menu Items'});
    const sync = () => {
        const on = keys.filter(([k]) => settings.get_boolean(k)).map(([, l]) => l);
        expander.set_subtitle(on.join(' · ') + (settings.get_boolean('menu-show-name') ? '' : '  (side by side)'));
    };
    keys.forEach(([key, label]) => {
        expander.add_row(makeSwitchRow(label, null, settings, key));
        connectSetting(settings, key, () => {
            // Keep at least one visible.
            if (keys.every(([k]) => !settings.get_boolean(k)))
                settings.set_boolean(key, true);
            sync();
        });
    });
    sync();
    return expander;
}

function makePreviewTextRow(window, settings) {
    const row = new Adw.ActionRow({
        title: 'Preview text',
        subtitle: settings.get_string('output-preview-text'),
        use_markup: false,
    });
    const editBtn = new Gtk.Button({
        icon_name: 'document-edit-symbolic', valign: Gtk.Align.CENTER,
        css_classes: ['flat'], tooltip_text: 'Change the preview text',
    });
    editBtn.connect('clicked', () => askForText(window, 'Preview text',
        'Shown on the top bar and in the menu instead of real output while preview is on.',
        settings.get_string('output-preview-text'),
        text => settings.set_string('output-preview-text', text.trim() || DEFAULT_PREVIEW_TEXT)));
    connectSetting(settings, 'output-preview-text',
        () => row.set_subtitle(settings.get_string('output-preview-text')));

    const toggle = new Gtk.Switch({valign: Gtk.Align.CENTER, tooltip_text: 'Show the preview instead of running scripts'});
    settings.bind('output-label-debug', toggle, 'active', Gio.SettingsBindFlags.DEFAULT);
    row.add_suffix(editBtn);
    row.add_suffix(toggle);
    row.set_activatable_widget(toggle);
    return row;
}

function makeFontRow(settings) {
    const fontBtn = new Gtk.FontDialogButton({
        dialog: new Gtk.FontDialog(), valign: Gtk.Align.CENTER, use_size: true,
    });
    const fam = settings.get_string('output-label-font') || 'Sans';
    const size = settings.get_int('output-label-font-size');
    const bold = settings.get_boolean('output-label-bold');
    fontBtn.set_font_desc(Pango.FontDescription.from_string(`${fam}${bold ? ' Bold' : ''} ${size}`));

    fontBtn.connect('notify::font-desc', () => {
        const desc = fontBtn.get_font_desc();
        if (!desc)
            return;
        settings.set_string('output-label-font', desc.get_family() || 'Sans');
        const px = desc.get_size_is_absolute()
            ? desc.get_size()
            : Math.round(desc.get_size() / Pango.SCALE);
        settings.set_int('output-label-font-size', px);
        settings.set_boolean('output-label-bold', desc.get_weight() >= Pango.Weight.BOLD);
    });

    const fontRow = new Adw.ActionRow({title: 'Font'});
    fontRow.add_suffix(fontBtn);
    return fontRow;
}

function buildScriptsGroup(box, settings) {
    const group = new Adw.PreferencesGroup({
        title: 'Scripts', description: 'Each one becomes an item in the trigger menu',
    });
    box.append(group);
    const addBtn = makeAddButton('Add script');
    group.set_header_suffix(addBtn);

    const rows = [];
    const saveAll = () => settings.set_string('quick-scripts', JSON.stringify(rows.map(r => r.script)));
    const addRow = script => {
        const row = new ScriptRow(script, saveAll, r => {
            group.remove(r);
            const idx = rows.indexOf(r);
            if (idx >= 0)
                rows.splice(idx, 1);
            saveAll();
        }, r => {
            saveAll();
            // The extension only accepts an index into the saved list.
            sendTest(settings, {kind: 'script', index: rows.indexOf(r)});
        });
        settings.bind('api-enabled', row.runButton, 'sensitive', Gio.SettingsBindFlags.GET);
        rows.push(row);
        group.add(row);
        return row;
    };
    loadJsonList(settings, 'quick-scripts').forEach(addRow);
    addBtn.connect('clicked', () => addRow({name: '', command: '', icon: DEFAULT_SCRIPT_ICON}).set_expanded(true));
}
