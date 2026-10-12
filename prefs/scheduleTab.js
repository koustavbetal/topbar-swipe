// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Koustav Betal

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';

import {
    makeAddButton, makeDeleteButton, loadJsonList, connectSetting, disconnectSetting,
} from './widgets.js';

const NONE = 'Choose a script…';
const MODES = ['', 'every', 'daily'];

const pad = n => String(n).padStart(2, '0');

function intervalText(total) {
    const h = Math.floor(total / 60), m = total % 60;
    return [h ? `${h} h` : '', m ? `${m} min` : ''].filter(Boolean).join(' ');
}

function timerSubtitle(e) {
    if (!e.mode)
        return 'Not set up yet';
    return e.mode === 'daily'
        ? `Daily at ${pad(e.hour ?? 9)}:${pad(e.minute ?? 0)}`
        : `Every ${intervalText(Math.max(1, e.minutes ?? 60))}`;
}

// Two-digit spin button, used for both clock times and intervals.
function makeClockSpin(upper, value, onChange) {
    const spin = new Gtk.SpinButton({
        adjustment: new Gtk.Adjustment({lower: 0, upper, step_increment: 1, page_increment: 5, value}),
        numeric: true, wrap: true, valign: Gtk.Align.CENTER, width_chars: 2,
    });
    spin.connect('output', () => {
        spin.set_text(pad(spin.get_value_as_int()));
        return true;
    });
    spin.connect('value-changed', () => onChange(spin.get_value_as_int()));
    return spin;
}

const unit = label => new Gtk.Label({label, css_classes: ['dim-label'], valign: Gtk.Align.CENTER});

// Shared editor for a JSON list setting: header "+" button, one row per
// entry, saved on every change.
function buildJsonList(box, settings, key, {title, description, addTooltip, makeEntry, makeRow}) {
    const group = new Adw.PreferencesGroup({title, description});
    box.append(group);
    const addBtn = makeAddButton(addTooltip);
    group.set_header_suffix(addBtn);

    const rows = [];
    const save = () => settings.set_string(key, JSON.stringify(rows.map(r => r.entry)));
    const add = entry => {
        const row = makeRow(entry, save, () => {
            group.remove(row);
            rows.splice(rows.indexOf(row), 1);
            save();
        });
        row.entry = entry;
        rows.push(row);
        group.add(row);
        return row;
    };
    loadJsonList(settings, key).forEach(add);
    addBtn.connect('clicked', () => {
        add(makeEntry()).set_expanded(true);
        save();
    });
}

// Expander whose own switch is the entry's on/off.
function makeEntryExpander(entry, save, remove) {
    const row = new Adw.ExpanderRow({
        show_enable_switch: true, enable_expansion: entry.enabled !== false, use_markup: false,
    });
    row.connect('notify::enable-expansion', () => {
        entry.enabled = row.get_enable_expansion();
        save();
    });
    row.add_suffix(makeDeleteButton('Delete', remove));
    return row;
}

export function buildScheduleTab(box, settings) {
    const scriptNames = () => loadJsonList(settings, 'quick-scripts').map(s => s?.name).filter(Boolean);

    buildJsonList(box, settings, 'timed-scripts', {
        title: 'Schedule Scripts',
        description: 'Run a saved script on a schedule, like a cron job: every so often, or daily at a set time. ' +
            'Its answer shows on the top bar and in the menu. Needs the Trigger Button on and a named script. ' +
            'Schedules pause while the computer sleeps.',
        addTooltip: 'Add schedule',
        // Blank: nothing is picked until you pick it.
        makeEntry: () => ({script: '', mode: '', enabled: true}),
        makeRow: (entry, save, remove) => makeScheduleRow(settings, scriptNames, entry, save, remove),
    });
}

function makeScheduleRow(settings, scriptNames, entry, save, remove) {
    const row = makeEntryExpander(entry, save, remove);
    const sync = () => {
        row.set_title(entry.script || 'New schedule');
        row.set_subtitle(timerSubtitle(entry));
    };
    sync();

    // Script picker. Item 0 is the empty choice; refreshed when scripts
    // are added or renamed.
    const scriptRow = new Adw.ComboRow({title: 'Script'});
    let filling = false;
    let shown = [];
    const fillScripts = () => {
        const names = scriptNames();
        if (entry.script && !names.includes(entry.script))
            names.unshift(entry.script); // keep showing a missing one
        shown = [NONE, ...names];
        filling = true;
        scriptRow.set_model(new Gtk.StringList({strings: shown}));
        scriptRow.set_selected(entry.script ? shown.indexOf(entry.script) : 0);
        filling = false;
        scriptRow.set_subtitle(names.length ? '' : 'Add a named script in the Scripts tab first');
    };
    fillScripts();
    scriptRow.connect('notify::selected', () => {
        if (filling)
            return;
        const i = scriptRow.get_selected();
        entry.script = i > 0 ? shown[i] : '';
        sync();
        save();
    });
    const scriptsChangedId = connectSetting(settings, 'quick-scripts', fillScripts);
    row.connect('destroy', () => disconnectSetting(settings, scriptsChangedId));
    row.add_row(scriptRow);

    const modeRow = new Adw.ComboRow({
        title: 'Repeat',
        model: new Gtk.StringList({strings: ['Choose…', 'In every...', 'Daily at a time']}),
    });
    modeRow.set_selected(Math.max(0, MODES.indexOf(entry.mode ?? '')));
    row.add_row(modeRow);

    // Every: hours + minutes, like the daily time.
    const total = Math.max(1, entry.minutes ?? 60);
    const everyRow = new Adw.ActionRow({title: 'In every...'});
    let hSpin, mSpin;
    const setInterval = () => {
        const mins = hSpin.get_value_as_int() * 60 + mSpin.get_value_as_int();
        if (mins < 1) {
            mSpin.set_value(1); // 0 h 0 min isn't a timer
            return;
        }
        entry.minutes = mins;
        sync();
        save();
    };
    hSpin = makeClockSpin(24, Math.floor(total / 60), setInterval);
    mSpin = makeClockSpin(59, total % 60, setInterval);
    everyRow.add_suffix(hSpin);
    everyRow.add_suffix(unit('h'));
    everyRow.add_suffix(mSpin);
    everyRow.add_suffix(unit('min'));
    row.add_row(everyRow);

    const timeRow = new Adw.ActionRow({title: 'At'});
    timeRow.add_suffix(makeClockSpin(23, entry.hour ?? 9, v => {
        entry.hour = v;
        sync();
        save();
    }));
    timeRow.add_suffix(new Gtk.Label({label: ':'}));
    timeRow.add_suffix(makeClockSpin(59, entry.minute ?? 0, v => {
        entry.minute = v;
        sync();
        save();
    }));
    row.add_row(timeRow);

    const syncMode = () => {
        everyRow.set_visible(entry.mode === 'every');
        timeRow.set_visible(entry.mode === 'daily');
    };
    syncMode();
    modeRow.connect('notify::selected', () => {
        entry.mode = MODES[modeRow.get_selected()];
        if (entry.mode === 'every' && !entry.minutes)
            entry.minutes = 60;
        if (entry.mode === 'daily') {
            entry.hour ??= 9;
            entry.minute ??= 0;
        }
        syncMode();
        sync();
        save();
    });
    return row;
}
