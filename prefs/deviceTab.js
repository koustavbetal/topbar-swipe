// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Koustav Betal

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import Pango from 'gi://Pango';

import {
    makeSwitchRow, makeColorRow, makeColorButton, makeSpinRow,
    makePreviewButton, sendTest, connectSetting,
} from './widgets.js';

export function buildDeviceTab(box, settings) {
    const group = new Adw.PreferencesGroup({
        title: 'Device Events',
        description: 'Event-driven via UPower/BlueZ, no polling. Turn this on to edit the options below.',
    });
    box.append(group);
    group.add(makeSwitchRow('React to Device Events', null, settings, 'device-enabled'));

    // Power Adapter, Bluetooth and Fill Bar each get their own group.
    // All of them are greyed out while the main switch is off.
    const section = row => {
        const g = new Adw.PreferencesGroup();
        g.add(row);
        settings.bind('device-enabled', g, 'sensitive', Gio.SettingsBindFlags.GET);
        box.append(g);
    };
    // Dividers: main switch | Power Adapter + Bluetooth | Fill Bar
    const divider = () => box.append(new Gtk.Separator({orientation: Gtk.Orientation.HORIZONTAL}));
    divider();

    const phaseRow = (title, subtitle, key, kind, phase) => {
        const row = makeSwitchRow(title, subtitle, settings, key);
        row.add_suffix(makePreviewButton(`Preview ${phase}`, () => sendTest(settings, {kind, phase})));
        return row;
    };

    // ----- Power Adapter -----
    const power = new Adw.ExpanderRow({title: 'Power Adapter', subtitle: 'Plugging in, unplugging and battery alerts'});
    power.add_row(phaseRow('On connect', 'Fill bar, swiping left to right', 'power-react-enabled', 'power', 'connect'));
    power.add_row(phaseRow('On disconnect', 'Fill bar, swiping from the level back to 0', 'power-react-disconnect', 'power', 'disconnect'));
    power.add_row(makeSwitchRow('Show fill bar', 'Off: a center-outward swipe instead', settings, 'battery-fill-power'));
    power.add_row(makeColorRow('Color', settings, 'power-color', 'Above the medium level, and for plain swipes'));
    power.add_row(makeSpinRow('Strokes per Cycle', null, settings, 'power-stroke-count', 1, 10, 1));
    power.add_row(makeSpinRow('Cycles', 'Swipe rounds, with or without the fill bar', settings, 'power-cycle-count', 1, 20, 1));
    power.add_row(makeBatteryAlertsRow(settings));
    section(power);

    // ----- Bluetooth -----
    const bt = new Adw.ExpanderRow({title: 'Bluetooth', subtitle: 'Devices connecting and disconnecting'});
    bt.add_row(phaseRow('On connect', 'Fill bar if the device reports its level', 'bt-react-enabled', 'bt', 'connect'));
    bt.add_row(phaseRow('On disconnect', 'Center-outward swipe (the level is gone by then)', 'bt-react-disconnect', 'bt', 'disconnect'));
    bt.add_row(makeSwitchRow('Show fill bar', 'Off, or no level reported: a center-outward swipe', settings, 'battery-fill-bt'));
    const nameFilterRow = new Adw.EntryRow({title: 'Device name contains (optional)'});
    nameFilterRow.set_text(settings.get_string('bt-name-filter'));
    nameFilterRow.connect('changed', () => settings.set_string('bt-name-filter', nameFilterRow.get_text().trim()));
    bt.add_row(nameFilterRow);
    bt.add_row(makeColorRow('Color', settings, 'bt-color', 'Above the medium level, and for plain swipes'));
    bt.add_row(makeSpinRow('Strokes per Cycle', null, settings, 'bt-stroke-count', 1, 10, 1));
    bt.add_row(makeSpinRow('Cycles', 'Swipe rounds, with or without the fill bar', settings, 'bt-cycle-count', 1, 20, 1));
    section(bt);
    divider();

    // ----- Fill bar -----
    section(makeFillBarRow(settings));
}

function makeFillBarRow(settings) {
    const battery = new Adw.ExpanderRow({
        title: 'Fill Bar',
        subtitle: 'Solid up to the level; swipes run inside it for the device’s Cycles, then it fades away',
    });
    // The switch is the toggle; text, font and color open under it.
    const textExpander = new Adw.ExpanderRow({
        title: 'Show text', subtitle: 'Just right of the top bar’s left section',
        show_enable_switch: true,
    });
    settings.bind('battery-show-percent', textExpander, 'enable-expansion', Gio.SettingsBindFlags.DEFAULT);
    battery.add_row(textExpander);

    const formatRow = new Adw.EntryRow({title: 'Text  ({percent} and {name} are filled in)', use_markup: false});
    formatRow.set_text(settings.get_string('battery-text-format'));
    formatRow.connect('changed', () => settings.set_string('battery-text-format', formatRow.get_text()));
    [
        formatRow,
        makeBatteryFontRow(settings),
        makeColorRow('Text color', settings, 'battery-text-color'),
    ].forEach(r => textExpander.add_row(r));
    battery.add_row(makeSpinRow('Edge fade (px)', 'Soft fading end of the fill. 0 = hard edge',
        settings, 'battery-fill-fade', 0, 600, 10));

    // One compact row per level: limit + color.
    const levelRow = (title, colorKey, thresholdKey, upper) => {
        const row = new Adw.ActionRow({title});
        row.add_suffix(new Gtk.Label({label: 'below', css_classes: ['dim-label']}));
        const spin = new Gtk.SpinButton({
            adjustment: new Gtk.Adjustment({lower: 1, upper, step_increment: 1, page_increment: 10}),
            numeric: true, valign: Gtk.Align.CENTER, width_chars: 3,
        });
        settings.bind(thresholdKey, spin, 'value', Gio.SettingsBindFlags.DEFAULT);
        row.add_suffix(spin);
        row.add_suffix(new Gtk.Label({label: '%', css_classes: ['dim-label']}));
        row.add_suffix(makeColorButton(settings.get_string(colorKey), hex => settings.set_string(colorKey, hex)));
        return row;
    };
    battery.add_row(levelRow('Low', 'battery-low-color', 'battery-low-threshold', 99));
    battery.add_row(levelRow('Medium', 'battery-mid-color', 'battery-mid-threshold', 100));
    const high = new Adw.ActionRow({title: 'High'});
    const syncHigh = () => high.set_subtitle(
        `${settings.get_int('battery-mid-threshold')}% and above: the Power Adapter or Bluetooth color`);
    connectSetting(settings, 'battery-mid-threshold', syncHigh);
    syncHigh();
    battery.add_row(high);
    return battery;
}

// One font button: family, weight (bold) and size all come from it.
// An empty key means "the top bar's own font", shown in the subtitle.
function makeBatteryFontRow(settings) {
    const row = new Adw.ActionRow({title: 'Font'});
    const fontBtn = new Gtk.FontDialogButton({
        dialog: new Gtk.FontDialog(), valign: Gtk.Align.CENTER, use_size: true,
    });
    const resetBtn = new Gtk.Button({
        icon_name: 'edit-undo-symbolic', valign: Gtk.Align.CENTER,
        css_classes: ['flat'], tooltip_text: 'Use the top bar font',
    });

    let syncing = false;
    const sync = () => {
        const saved = settings.get_string('battery-text-font');
        let fallback = 'Sans Bold 11';
        try {
            const iface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
            fallback = `${iface.get_string('font-name').replace(/\s+\d+(\.\d+)?$/, '')} Bold 11`;
        } catch {
            // no desktop schema: keep the plain fallback
        }
        syncing = true;
        fontBtn.set_font_desc(Pango.FontDescription.from_string(saved || fallback));
        syncing = false;
        row.set_subtitle(saved ? '' : 'Top bar font, bold');
        resetBtn.set_visible(!!saved);
    };
    fontBtn.connect('notify::font-desc', () => {
        const desc = fontBtn.get_font_desc();
        if (!syncing && desc)
            settings.set_string('battery-text-font', desc.to_string());
    });
    resetBtn.connect('clicked', () => settings.set_string('battery-text-font', ''));
    connectSetting(settings, 'battery-text-font', sync);
    sync();

    row.add_suffix(resetBtn);
    row.add_suffix(fontBtn);
    return row;
}

// Battery alerts live inside Power Adapter: the switch is on the row,
// and the dropdowns only open under it while it's on.
function makeBatteryAlertsRow(settings) {
    const expander = new Adw.ExpanderRow({
        title: 'Battery alerts', show_enable_switch: true,
        subtitle: 'Plays the fill bar when the laptop battery crosses a level',
    });
    settings.bind('battery-alerts-enabled', expander, 'enable-expansion', Gio.SettingsBindFlags.DEFAULT);

    const alertRow = (title, subtitle, key, levels, op) => {
        const labels = ['Off', ...levels.map(l => `${l}%`)];
        const values = [0, ...levels];
        const row = new Adw.ComboRow({title, subtitle, model: new Gtk.StringList({strings: labels})});
        row.set_selected(Math.max(0, values.indexOf(settings.get_int(key))));
        row.connect('notify::selected', () => settings.set_int(key, values[row.get_selected()]));
        row.add_suffix(makePreviewButton('Preview', () =>
            sendTest(settings, {kind: 'alert', op, level: settings.get_int(key) || levels[0]})));
        return row;
    };
    expander.add_row(alertRow('Low battery alert', 'When it drops below, on battery',
        'battery-alert-low', [5, 10, 15, 20, 25, 30, 40], 'below'));
    expander.add_row(alertRow('Charged alert', 'When it reaches, while charging',
        'battery-alert-high', [80, 85, 90, 95, 100], 'above'));
    return expander;
}
