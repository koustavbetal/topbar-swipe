// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Koustav Betal

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import Pango from 'gi://Pango';
import GObject from 'gi://GObject';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

function hexFromRgba(rgba) {
    return '#' + [rgba.red, rgba.green, rgba.blue]
        .map(v => Math.round(v * 255).toString(16).padStart(2, '0'))
        .join('');
}

const DIRECTIONS = ['ltr', 'rtl', 'center-out'];
const DIRECTION_LABELS = ['Left to right', 'Right to left', 'Center outward'];

function makeDirectionRow(title, settings, key) {
    const model = new Gtk.StringList({ strings: DIRECTION_LABELS });
    const row = new Adw.ComboRow({ title, model });
    row.set_selected(Math.max(0, DIRECTIONS.indexOf(settings.get_string(key))));
    row.connect('notify::selected', () => settings.set_string(key, DIRECTIONS[row.get_selected()]));
    return row;
}

function makeColorButton(hex, onChange) {
    const btn = new Gtk.ColorDialogButton({
        dialog: new Gtk.ColorDialog({ with_alpha: false }),
        valign: Gtk.Align.CENTER,
    });
    const c = new Gdk.RGBA();
    c.parse(hex);
    btn.set_rgba(c);
    btn.connect('notify::rgba', () => onChange(hexFromRgba(btn.get_rgba())));
    return btn;
}

function makeColorRow(title, settings, key) {
    const row = new Adw.ActionRow({ title });
    row.add_suffix(makeColorButton(settings.get_string(key), hex => settings.set_string(key, hex)));
    return row;
}

// `digits` matters: without it an Adw.SpinRow defaults to integer-only
// display AND rounding, even when the underlying GSettings key is a double
// (that was the opacity bug — 0.05 steps rounding to whole numbers).
function makeSpinRow(title, subtitle, settings, key, lower, upper, step, digits = 0) {
    const row = new Adw.SpinRow({
        title, subtitle, digits,
        adjustment: new Gtk.Adjustment({ lower, upper, step_increment: step }),
    });
    settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

// Top-mounted Gtk.StackSwitcher + Gtk.Stack inside one Adw.PreferencesGroup
// — PreferencesPage only accepts PreferencesGroup children, so this is the
// simplest way to get tabbed sections without a second window. Renders at
// the top of the page rather than pinned to the bottom.
function makeTabbed(tabs) {
    const stack = new Gtk.Stack({ transition_type: Gtk.StackTransitionType.CROSSFADE });
    const switcher = new Gtk.StackSwitcher({ stack, halign: Gtk.Align.CENTER, margin_bottom: 6 });

    const wrapper = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 12 });
    wrapper.append(switcher);
    wrapper.append(stack);

    const group = new Adw.PreferencesGroup();
    group.add(wrapper);

    tabs.forEach(tab => {
        const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 18 });
        tab.build(box);
        stack.add_titled(box, tab.id, tab.title);
    });

    return { group, stack };
}

// ---------- Notification per-app rule row ----------

const AppRuleRow = GObject.registerClass(
class AppRuleRow extends Adw.ExpanderRow {
    _init(rule, onChanged, onDelete) {
        super._init({ title: rule.appName || 'New app', subtitle: AppRuleRow._subtitle(rule) });
        this.rule = rule;
        this._onChanged = onChanged;

        const nameRow = new Adw.EntryRow({ title: 'App name' });
        nameRow.set_text(rule.appName || '');
        nameRow.connect('changed', () => { this.rule.appName = nameRow.get_text().trim(); this._commit(); });
        this.add_row(nameRow);

        // Notification filters: app name (above) and title only — the
        // message body/content is deliberately never matched against.
        const titleRow = new Adw.EntryRow({ title: 'Title contains (optional)' });
        titleRow.set_text(rule.titleFilter || '');
        titleRow.connect('changed', () => { this.rule.titleFilter = titleRow.get_text().trim(); this._commit(); });
        this.add_row(titleRow);
        this.add_row(new Adw.ActionRow({
            title: 'Matches only the notification\u2019s title/sender line \u2014 never the message body.',
            sensitive: false,
        }));

        const colorRow = new Adw.ActionRow({ title: 'Color' });
        colorRow.add_suffix(makeColorButton(rule.color || '#50a0ff', hex => { this.rule.color = hex; this._commit(); }));
        this.add_row(colorRow);

        const strokeAdj = new Gtk.Adjustment({ lower: 1, upper: 10, step_increment: 1, value: rule.strokeCount || 2 });
        const strokeRow = new Adw.SpinRow({ title: 'Strokes per cycle', subtitle: 'The "bam-bam" count', adjustment: strokeAdj });
        strokeAdj.connect('value-changed', () => { this.rule.strokeCount = strokeAdj.get_value(); this._commit(); });
        this.add_row(strokeRow);

        const cycleAdj = new Gtk.Adjustment({
            lower: 0, upper: 20, step_increment: 1,
            value: rule.cycleCount !== undefined ? rule.cycleCount : 3,
        });
        const cycleRow = new Adw.SpinRow({
            title: 'Total cycles', subtitle: '0 = stay active until dismissed or opened', adjustment: cycleAdj,
        });
        cycleAdj.connect('value-changed', () => { this.rule.cycleCount = cycleAdj.get_value(); this._commit(); });
        this.add_row(cycleRow);

        this.add_row(makeDirectionRuleRow(rule, dir => { this.rule.direction = dir; this._commit(); }));

        const delBtn = new Gtk.Button({ icon_name: 'user-trash-symbolic', valign: Gtk.Align.CENTER, css_classes: ['flat'] });
        delBtn.connect('clicked', () => onDelete(this));
        this.add_suffix(delBtn);
    }

    _commit() {
        this.set_title(this.rule.appName || 'New app');
        this.set_subtitle(AppRuleRow._subtitle(this.rule));
        this._onChanged();
    }

    static _subtitle(rule) {
        const cycles = rule.cycleCount !== undefined ? rule.cycleCount : 3;
        const cycleText = cycles === 0 ? 'until dismissed' : `${cycles} cycle(s)`;
        return `${rule.strokeCount || 2} stroke(s) \u00d7 ${cycleText} \u00b7 ${rule.direction || 'ltr'}`;
    }
});

function makeDirectionRuleRow(rule, onChange) {
    const model = new Gtk.StringList({ strings: DIRECTION_LABELS });
    const row = new Adw.ComboRow({ title: 'Direction', model });
    row.set_selected(Math.max(0, DIRECTIONS.indexOf(rule.direction || 'ltr')));
    row.connect('notify::selected', () => onChange(DIRECTIONS[row.get_selected()]));
    return row;
}

// ---------- Quick script row (Advanced > Script tab) ----------

const ScriptRow = GObject.registerClass(
class ScriptRow extends Adw.ExpanderRow {
    _init(script, onChanged, onDelete) {
        super._init({ title: script.name || 'New script', subtitle: script.command || '' });
        this.script = script;
        this._onChanged = onChanged;

        const nameRow = new Adw.EntryRow({ title: 'Name (shown in the menu)' });
        nameRow.set_text(script.name || '');
        nameRow.connect('changed', () => { this.script.name = nameRow.get_text().trim(); this._commit(); });
        this.add_row(nameRow);

        const cmdRow = new Adw.EntryRow({ title: 'Command' });
        cmdRow.set_text(script.command || '');
        cmdRow.connect('changed', () => { this.script.command = cmdRow.get_text().trim(); this._commit(); });
        this.add_row(cmdRow);

        // Inline output, revealed after a run — kept simple (no popup
        // window to manage) and it's right where you'd look for it.
        this._outputBuffer = new Gtk.TextBuffer();
        const outputView = new Gtk.TextView({
            buffer: this._outputBuffer, editable: false, monospace: true,
            wrap_mode: Gtk.WrapMode.WORD_CHAR,
            top_margin: 6, bottom_margin: 6, left_margin: 8, right_margin: 8,
        });
        this._outputScroll = new Gtk.ScrolledWindow({ min_content_height: 90, max_content_height: 160, child: outputView });
        this._outputScroll.set_visible(false);
        this.add_row(this._outputScroll);

        const runBtn = new Gtk.Button({
            icon_name: 'media-playback-start-symbolic', valign: Gtk.Align.CENTER,
            css_classes: ['flat'], tooltip_text: 'Run now',
        });
        runBtn.connect('clicked', () => this._run());
        this.add_suffix(runBtn);

        const delBtn = new Gtk.Button({ icon_name: 'user-trash-symbolic', valign: Gtk.Align.CENTER, css_classes: ['flat'] });
        delBtn.connect('clicked', () => onDelete(this));
        this.add_suffix(delBtn);
    }

    _run() {
        if (!this.script.command) return;
        this._outputScroll.set_visible(true);
        this._outputBuffer.set_text('Running\u2026', -1);
        try {
            const proc = Gio.Subprocess.new(
                ['/bin/sh', '-c', this.script.command],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_MERGE);
            proc.communicate_utf8_async(null, null, (p, res) => {
                try {
                    const [, stdout] = p.communicate_utf8_finish(res);
                    this._outputBuffer.set_text(stdout || '(no output)', -1);
                } catch (e) {
                    this._outputBuffer.set_text(`Error: ${e.message}`, -1);
                }
            });
        } catch (e) {
            this._outputBuffer.set_text(`Error: ${e.message}`, -1);
        }
    }

    _commit() {
        this.set_title(this.script.name || 'New script');
        this.set_subtitle(this.script.command || '');
        this._onChanged();
    }
});

// ---------- best-effort keybinding conflict check ----------
function findKeybindingConflict(accel) {
    const schemaIds = [
        'org.gnome.desktop.wm.keybindings',
        'org.gnome.shell.keybindings',
        'org.gnome.mutter.keybindings',
        'org.gnome.settings-daemon.plugins.media-keys',
    ];
    const source = Gio.SettingsSchemaSource.get_default();

    for (const schemaId of schemaIds) {
        if (!source?.lookup(schemaId, true)) continue;
        let settings, schema;
        try {
            settings = new Gio.Settings({ schema_id: schemaId });
            schema = settings.settings_schema;
        } catch (e) { continue; }
        for (const key of schema.list_keys()) {
            let value;
            try { value = settings.get_value(key); } catch (e) { continue; }
            if (value.get_type_string() !== 'as') continue;
            if (value.deep_unpack().includes(accel))
                return `${schemaId.split('.').pop()} \u2192 ${key}`;
        }
    }

    try {
        const mediaKeys = new Gio.Settings({ schema_id: 'org.gnome.settings-daemon.plugins.media-keys' });
        for (const path of mediaKeys.get_strv('custom-keybindings')) {
            const cs = new Gio.Settings({
                schema_id: 'org.gnome.settings-daemon.plugins.media-keys.custom-keybinding', path,
            });
            if (cs.get_string('binding') === accel)
                return `custom shortcut "${cs.get_string('name')}"`;
        }
    } catch (e) { /* schema not present — skip */ }

    return null;
}

export default class TopBarSwipePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.set_default_size(560, 640);

        this._buildGeneralPage(window, settings);
        this._buildReactPage(window, settings);
        this._buildAdvancedPage(window, settings);
        this._buildAboutPage(window);
    }

    // ================= General (shared style + Ambient toggle) =================
    _buildGeneralPage(window, settings) {
        const page = new Adw.PreferencesPage({ title: 'General', icon_name: 'preferences-system-symbolic' });
        window.add(page);

        const shared = new Adw.PreferencesGroup({ title: 'Appearance' });
        page.add(shared);
        shared.add(makeSpinRow('Max Opacity', null, settings, 'swipe-opacity', 0.05, 1.0, 0.05, 2));
        shared.add(makeSpinRow('Border Radius (px)', null, settings, 'swipe-radius', 0, 200, 1));

        // ONE style per direction family — used everywhere (ambient,
        // notifications, device reactions). Pick your numbers here once.
        const lr = new Adw.PreferencesGroup({
            title: 'Side Timing', description: 'Left-to-right and right-to-left \u2014 used everywhere in the extension',
        });
        page.add(lr);
        lr.add(makeSpinRow('Stroke Length (px)', null, settings, 'swipe-lr-width', 20, 2000, 10));
        lr.add(makeSpinRow('Stroke Duration (ms)', null, settings, 'swipe-lr-duration', 100, 10000, 50));
        lr.add(makeSpinRow('Gap Between Strokes (ms)', null, settings, 'swipe-lr-stroke-gap', 0, 5000, 25));
        lr.add(makeSpinRow('Gap Between Cycles (ms)', 'Also the ambient idle interval', settings, 'swipe-lr-cycle-gap', 0, 60000, 100));

        const center = new Adw.PreferencesGroup({
            title: 'Center Timing', description: 'Center-out \u2014 used everywhere in the extension',
        });
        page.add(center);
        center.add(makeSpinRow('Stroke Length (px)', null, settings, 'swipe-center-width', 20, 2000, 10));
        center.add(makeSpinRow('Stroke Duration (ms)', null, settings, 'swipe-center-duration', 100, 10000, 50));
        center.add(makeSpinRow('Gap Between Strokes (ms)', null, settings, 'swipe-center-stroke-gap', 0, 5000, 25));
        center.add(makeSpinRow('Gap Between Cycles (ms)', 'Also the ambient idle interval', settings, 'swipe-center-cycle-gap', 0, 60000, 100));

        const ambient = new Adw.PreferencesGroup({ title: 'Ambient Mode' });
        page.add(ambient);
        const idleRow = new Adw.SwitchRow({ title: 'Enabled', subtitle: 'Keep swiping continuously with no notifications' });
        settings.bind('idle-loop-enabled', idleRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        ambient.add(idleRow);
        ambient.add(makeColorRow('Color', settings, 'swipe-color'));
        ambient.add(makeDirectionRow('Direction', settings, 'swipe-direction'));
        ambient.add(makeSpinRow('Strokes per Cycle', null, settings, 'ambient-stroke-count', 1, 10, 1));
    }

    // ================= React (Notifications / Device tabs) =================
    _buildReactPage(window, settings) {
        const page = new Adw.PreferencesPage({ title: 'React', icon_name: 'preferences-system-notifications-symbolic' });
        window.add(page);

        const { group } = makeTabbed([
            { id: 'notif', title: 'Notifications', build: box => this._buildNotificationsTab(box, settings) },
            { id: 'device', title: 'Device', build: box => this._buildDeviceTab(box, settings) },
        ]);
        page.add(group);
    }

    _buildNotificationsTab(box, settings) {
        const master = new Adw.PreferencesGroup({
            title: 'Notifications', description: 'Timing comes from the Side/Center styles on the General page',
        });
        box.append(master);
        const enabledRow = new Adw.SwitchRow({ title: 'React to Notifications' });
        settings.bind('notifications-enabled', enabledRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        master.add(enabledRow);
        master.add(makeColorRow('Fallback Color', settings, 'notif-default-color'));
        master.add(makeDirectionRow('Fallback Direction', settings, 'notif-default-direction'));
        master.add(makeSpinRow('Fallback Strokes per Cycle', 'Used for apps with no rule', settings, 'default-stroke-count', 1, 10, 1));
        master.add(makeSpinRow('Fallback Cycles', 'Used for apps with no rule', settings, 'default-cycle-count', 1, 20, 1));

        const rulesGroup = new Adw.PreferencesGroup({
            title: 'App Rules', description: 'Filters on app name and title only \u2014 message content is never matched',
        });
        box.append(rulesGroup);
        const addBtn = new Gtk.Button({ icon_name: 'list-add-symbolic', css_classes: ['flat'], valign: Gtk.Align.CENTER });
        rulesGroup.set_header_suffix(addBtn);

        const rows = [];
        const loadRules = () => { try { return JSON.parse(settings.get_string('app-rules')); } catch (e) { return []; } };
        const saveAll = () => settings.set_string('app-rules', JSON.stringify(rows.map(r => r.rule)));
        const addRow = (rule) => {
            const row = new AppRuleRow(rule, saveAll, (r) => {
                rulesGroup.remove(r);
                const idx = rows.indexOf(r);
                if (idx >= 0) rows.splice(idx, 1);
                saveAll();
            });
            rows.push(row);
            rulesGroup.add(row);
        };
        loadRules().forEach(addRow);
        addBtn.connect('clicked', () => addRow({ appName: '', titleFilter: '', color: '#50a0ff', strokeCount: 2, cycleCount: 3, direction: 'ltr' }));
    }

    _buildDeviceTab(box, settings) {
        const master = new Adw.PreferencesGroup({
            title: 'Device Events',
            description: 'Event-driven via UPower/BlueZ \u2014 no polling. Timing comes from the General page styles.',
        });
        box.append(master);
        const deviceEnabled = new Adw.SwitchRow({ title: 'React to Device Events' });
        settings.bind('device-enabled', deviceEnabled, 'active', Gio.SettingsBindFlags.DEFAULT);
        master.add(deviceEnabled);

        const power = new Adw.PreferencesGroup({ title: 'Power' });
        box.append(power);
        const powerEnabled = new Adw.SwitchRow({ title: 'React when charger connects' });
        settings.bind('power-react-enabled', powerEnabled, 'active', Gio.SettingsBindFlags.DEFAULT);
        power.add(powerEnabled);
        power.add(makeColorRow('Color', settings, 'power-color'));
        power.add(makeDirectionRow('Direction', settings, 'power-direction'));
        power.add(makeSpinRow('Strokes per Cycle', null, settings, 'power-stroke-count', 1, 10, 1));
        power.add(makeSpinRow('Cycles', null, settings, 'power-cycle-count', 1, 20, 1));

        const bt = new Adw.PreferencesGroup({ title: 'Bluetooth' });
        box.append(bt);
        const btEnabled = new Adw.SwitchRow({ title: 'React when a device connects' });
        settings.bind('bt-react-enabled', btEnabled, 'active', Gio.SettingsBindFlags.DEFAULT);
        bt.add(btEnabled);
        const nameFilterRow = new Adw.EntryRow({ title: 'Device name contains (optional)' });
        nameFilterRow.set_text(settings.get_string('bt-name-filter'));
        nameFilterRow.connect('changed', () => settings.set_string('bt-name-filter', nameFilterRow.get_text().trim()));
        bt.add(nameFilterRow);
        bt.add(makeColorRow('Color', settings, 'bt-color'));
        bt.add(makeDirectionRow('Direction', settings, 'bt-direction'));
        bt.add(makeSpinRow('Strokes per Cycle', null, settings, 'bt-stroke-count', 1, 10, 1));
        bt.add(makeSpinRow('Cycles', null, settings, 'bt-cycle-count', 1, 20, 1));
    }

    // ================= Advanced =================
    _buildAdvancedPage(window, settings) {
        const page = new Adw.PreferencesPage({ title: 'Advanced', icon_name: 'applications-engineering-symbolic' });
        window.add(page);

        const master = new Adw.PreferencesGroup({
            title: 'Trigger Button', description: 'A manual, on-demand way to run scripts \u2014 off by default',
        });
        page.add(master);
        const apiEnabled = new Adw.SwitchRow({ title: 'Enabled' });
        settings.bind('api-enabled', apiEnabled, 'active', Gio.SettingsBindFlags.DEFAULT);
        master.add(apiEnabled);

        const POSITIONS = ['left', 'center', 'right', 'key'];
        const POSITION_LABELS = ['Left of panel', 'Center of panel', 'Right of panel', 'Custom key'];
        const posModel = new Gtk.StringList({ strings: POSITION_LABELS });
        const posRow = new Adw.ComboRow({ title: 'Button Position', model: posModel });
        posRow.set_selected(Math.max(0, POSITIONS.indexOf(settings.get_string('trigger-button-position'))));
        master.add(posRow);

        // GNOME's own shortcut-display widget — keycap-style chips, same
        // as Settings > Keyboard Shortcuts, instead of a hand-rolled label
        // that was wrapping/hyphenating in a narrow button before.
        const keyRow = new Adw.ActionRow({ title: 'Shortcut' });
        const shortcutDisplay = new Gtk.ShortcutLabel({ valign: Gtk.Align.CENTER, disabled_text: 'Not set' });
        const setBtn = new Gtk.Button({
            icon_name: 'document-edit-symbolic', valign: Gtk.Align.CENTER,
            css_classes: ['flat'], tooltip_text: 'Click, then press a key combination',
        });
        const conflictLabel = new Gtk.Label({ css_classes: ['dim-label'], valign: Gtk.Align.CENTER, wrap: true, xalign: 1 });

        const refreshShortcut = () => {
            const strv = settings.get_strv('trigger-button-key');
            shortcutDisplay.accelerator = strv.length ? strv[0] : '';
        };
        refreshShortcut();

        setBtn.connect('clicked', () => {
            shortcutDisplay.accelerator = '';
            shortcutDisplay.disabled_text = 'Press a key\u2026 (Esc to cancel)';
            conflictLabel.set_label('');

            const controller = new Gtk.EventControllerKey();
            setBtn.add_controller(controller);
            controller.connect('key-pressed', (ctrl, keyval, keycode, state) => {
                if (keyval === Gdk.KEY_Escape) {
                    setBtn.remove_controller(controller);
                    shortcutDisplay.disabled_text = 'Not set';
                    refreshShortcut();
                    return true;
                }
                const mods = state & Gtk.accelerator_get_default_mod_mask();
                if (!Gtk.accelerator_valid(keyval, mods)) return true; // wait for a real combo
                const accel = Gtk.accelerator_name(keyval, mods);
                setBtn.remove_controller(controller);
                shortcutDisplay.disabled_text = 'Not set';

                const conflict = findKeybindingConflict(accel);
                if (conflict) {
                    conflictLabel.set_label(`\u26a0 Used by ${conflict}`);
                } else {
                    conflictLabel.set_label('No conflict found (best-effort)');
                    settings.set_strv('trigger-button-key', [accel]);
                }
                refreshShortcut();
                return true;
            });
            setBtn.grab_focus();
        });

        keyRow.add_suffix(conflictLabel);
        keyRow.add_suffix(shortcutDisplay);
        keyRow.add_suffix(setBtn);

        const keyGroup = new Adw.PreferencesGroup();
        keyGroup.add(keyRow);
        page.add(keyGroup);

        const outputGroup = new Adw.PreferencesGroup({
            title: 'Output Label',
            description: 'Controls the St.Label shown in the trigger-button popup.',
        });
        page.add(outputGroup);
        const fontBtn = new Gtk.FontDialogButton({
            dialog: new Gtk.FontDialog(), valign: Gtk.Align.CENTER, use_size: true,
        });

        const currentFontDesc = () => {
            const fam = settings.get_string('output-label-font') || 'Sans';
            const size = settings.get_int('output-label-font-size');
            const bold = settings.get_boolean('output-label-bold');
            return `${fam}${bold ? ' Bold' : ''} ${size}`;
        };
        fontBtn.set_font_desc(Pango.FontDescription.from_string(currentFontDesc()));

        fontBtn.connect('notify::font-desc', () => {
            const desc = fontBtn.get_font_desc();
            if (!desc) return;
            settings.set_string('output-label-font', desc.get_family() || 'Sans');
            const px = desc.get_size_is_absolute()
                ? desc.get_size()
                : Math.round(desc.get_size() / Pango.SCALE);
            settings.set_int('output-label-font-size', px);
            settings.set_boolean('output-label-bold', desc.get_weight() >= Pango.Weight.BOLD);
        });

        const fontRow = new Adw.ActionRow({ title: 'Font' });
        fontRow.add_suffix(fontBtn);
        outputGroup.add(fontRow);
        const debugRow = new Adw.SwitchRow({
            title: 'Debug text',
            subtitle: 'Show “Your output will appear here!!” instead of running a script',
        });
        settings.bind('output-label-debug', debugRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        outputGroup.add(debugRow);

        const syncKeyRowVisibility = () => keyGroup.set_visible(POSITIONS[posRow.get_selected()] === 'key');
        syncKeyRowVisibility();
        posRow.connect('notify::selected', () => {
            settings.set_string('trigger-button-position', POSITIONS[posRow.get_selected()]);
            syncKeyRowVisibility();
        });

        this._buildScriptsGroup(page, settings);
    }

    _buildScriptsGroup(page, settings) {
        const group = new Adw.PreferencesGroup({
            title: 'Scripts', description: 'Shown as menu items under the trigger button (or run the first one for the keyboard shortcut)',
        });
        page.add(group);
        const addBtn = new Gtk.Button({ icon_name: 'list-add-symbolic', css_classes: ['flat'], valign: Gtk.Align.CENTER });
        group.set_header_suffix(addBtn);

        const rows = [];
        const load = () => { try { return JSON.parse(settings.get_string('quick-scripts')); } catch (e) { return []; } };
        const saveAll = () => settings.set_string('quick-scripts', JSON.stringify(rows.map(r => r.script)));
        const addRow = (script) => {
            const row = new ScriptRow(script, saveAll, (r) => {
                group.remove(r);
                const idx = rows.indexOf(r);
                if (idx >= 0) rows.splice(idx, 1);
                saveAll();
            });
            rows.push(row);
            group.add(row);
        };
        load().forEach(addRow);
        addBtn.connect('clicked', () => addRow({ name: '', command: '' }));
    }

    // ================= About =================
    _buildAboutPage(window) {
        const page = new Adw.PreferencesPage({ title: 'About', icon_name: 'help-about-symbolic' });
        window.add(page);

        const header = new Adw.PreferencesGroup();
        page.add(header);
        const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 8, halign: Gtk.Align.CENTER, margin_top: 24, margin_bottom: 12 });
        box.append(new Gtk.Image({ icon_name: 'preferences-desktop-display-symbolic', pixel_size: 64 }));
        box.append(new Gtk.Label({ label: this.metadata.name, css_classes: ['title-1'] }));
        const version = this.metadata['version-name'] ?? String(this.metadata.version ?? '');
        box.append(new Gtk.Label({ label: `${version ? `v${version} \u00b7 ` : ''}Made with \u2764 by Koustav`, css_classes: ['dim-label'] }));
        header.add(box);

        const links = new Adw.PreferencesGroup({ title: 'Links' });
        page.add(links);
        const repo = this.metadata.url;
        [['Source code', repo],
         ['Report an issue', `${repo}/issues`],
         ['Website', 'https://koustavbetal.github.io']]
            .forEach(([label, uri]) => {
                const row = new Adw.ActionRow({ title: label, subtitle: uri, activatable: true });
                row.add_suffix(new Gtk.Image({ icon_name: 'adw-external-link-symbolic' }));
                row.connect('activated', () => new Gtk.UriLauncher({ uri }).launch(window, null, null));
                links.add(row);
            });
    }
}
