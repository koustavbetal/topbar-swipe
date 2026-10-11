// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Koustav Betal

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
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
const RUN_ICON = 'media-playback-start-symbolic';
const DEFAULT_SCRIPT_ICON = 'utilities-terminal-symbolic';

function makeChoiceRow(title, settings, key, values, labels, subtitle = null) {
    const row = new Adw.ComboRow({title, subtitle, model: new Gtk.StringList({strings: labels})});
    row.set_selected(Math.max(0, values.indexOf(settings.get_string(key))));
    row.connect('notify::selected', () => settings.set_string(key, values[row.get_selected()]));
    return row;
}

function makeDirectionRow(title, settings, key) {
    return makeChoiceRow(title, settings, key, DIRECTIONS, DIRECTION_LABELS);
}

function makeColorButton(hex, onChange) {
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

function makeColorRow(title, settings, key, subtitle = null) {
    const row = new Adw.ActionRow({title, subtitle});
    row.add_suffix(makeColorButton(settings.get_string(key), hex => settings.set_string(key, hex)));
    return row;
}

// `digits` matters: without it Adw.SpinRow rounds to integers even for a
// double key (that was the opacity bug).
function makeSpinRow(title, subtitle, settings, key, lower, upper, step, digits = 0) {
    const row = new Adw.SpinRow({
        title, subtitle, digits,
        adjustment: new Gtk.Adjustment({lower, upper, step_increment: step}),
    });
    settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function makeSwitchRow(title, subtitle, settings, key) {
    const row = new Adw.SwitchRow({title, subtitle});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function makePreviewButton(tooltip, onClick) {
    const btn = new Gtk.Button({
        icon_name: RUN_ICON, valign: Gtk.Align.CENTER,
        css_classes: ['flat'], tooltip_text: tooltip,
    });
    btn.connect('clicked', onClick);
    return btn;
}

function makeHeaderPreviewButton(onClick) {
    const btn = new Gtk.Button({
        child: new Adw.ButtonContent({icon_name: RUN_ICON, label: 'Preview'}),
        css_classes: ['flat'], valign: Gtk.Align.CENTER,
        tooltip_text: 'Play this on the top bar now',
    });
    btn.connect('clicked', onClick);
    return btn;
}

// The running extension listens to this key and plays the reaction.
function sendTest(settings, payload) {
    settings.set_string('test-trigger', JSON.stringify({...payload, t: Date.now()}));
}

// ---------- icon picker ----------

function setImageIcon(image, name) {
    if (name && name.startsWith('/'))
        image.set_from_file(name);
    else
        image.set_from_icon_name(name || DEFAULT_SCRIPT_ICON);
}

let _iconNames = null;
function installedIconNames() {
    // Every icon in the current theme chain (Adwaita + hicolor + extras).
    // The top bar uses the same theme, so anything listed here renders.
    if (!_iconNames) {
        const theme = Gtk.IconTheme.get_for_display(Gdk.Display.get_default());
        _iconNames = [...new Set(theme.get_icon_names())].sort();
    }
    return _iconNames;
}

function makeIconPicker(current, onChange) {
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

// Adw.AlertDialog on libadwaita 1.5+, Adw.MessageDialog before that.
function askForText(parent, heading, body, current, onSave) {
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
    if (Adw.AlertDialog) {
        dialog.present(parent);
    } else {
        dialog.set_transient_for(parent);
        dialog.present();
    }
}

// '' = hide that line.
const TIME_FORMATS = ['%H:%M', '%I:%M %p', '%H:%M:%S', ''];
const DATE_FORMATS = ['%A, %d %B', '%a %d %b', '%A, %d %B %Y', '%d/%m/%Y', ''];

// ---------- tabs inside one page ----------

function makeTabbed(tabs) {
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

// ---------- notification rule row ----------

const RuleRow = GObject.registerClass(
class RuleRow extends Adw.ExpanderRow {
    _init(rule, onChanged, onDelete, onTest) {
        // Older rules stored an exact app name; it becomes the match text.
        if (rule.match === undefined) {
            rule.match = rule.appName || '';
            delete rule.appName;
        }
        super._init({title: RuleRow._title(rule), subtitle: RuleRow._subtitle(rule), use_markup: false});
        this.rule = rule;
        this._onChanged = onChanged;

        const matchRow = new Adw.EntryRow({title: 'Match text (app name or title)'});
        matchRow.set_text(rule.match || '');
        matchRow.connect('changed', () => {
            this.rule.match = matchRow.get_text().trim();
            this._commit();
        });
        this.add_row(matchRow);

        const titleRow = new Adw.EntryRow({title: 'And title contains (optional)'});
        titleRow.set_text(rule.titleFilter || '');
        titleRow.connect('changed', () => {
            this.rule.titleFilter = titleRow.get_text().trim();
            this._commit();
        });
        this.add_row(titleRow);
        this.add_row(new Adw.ActionRow({
            subtitle: 'Case-insensitive. Separate alternatives with commas, e.g. “whatsapp, zapzap”. ' +
                'The message body is never read.',
            sensitive: false,
        }));

        const colorRow = new Adw.ActionRow({title: 'Color'});
        colorRow.add_suffix(makeColorButton(rule.color || '#50a0ff', hex => {
            this.rule.color = hex;
            this._commit();
        }));
        this.add_row(colorRow);

        const strokeAdj = new Gtk.Adjustment({lower: 1, upper: 10, step_increment: 1, value: rule.strokeCount || 2});
        this.add_row(new Adw.SpinRow({title: 'Strokes per cycle', adjustment: strokeAdj}));
        strokeAdj.connect('value-changed', () => {
            this.rule.strokeCount = strokeAdj.get_value();
            this._commit();
        });

        const cycleAdj = new Gtk.Adjustment({
            lower: 0, upper: 20, step_increment: 1,
            value: rule.cycleCount !== undefined ? rule.cycleCount : 3,
        });
        this.add_row(new Adw.SpinRow({
            title: 'Total cycles', subtitle: '0 = keep going until dismissed or opened', adjustment: cycleAdj,
        }));
        cycleAdj.connect('value-changed', () => {
            this.rule.cycleCount = cycleAdj.get_value();
            this._commit();
        });

        const dirRow = new Adw.ComboRow({title: 'Direction', model: new Gtk.StringList({strings: DIRECTION_LABELS})});
        dirRow.set_selected(Math.max(0, DIRECTIONS.indexOf(rule.direction || 'ltr')));
        dirRow.connect('notify::selected', () => {
            this.rule.direction = DIRECTIONS[dirRow.get_selected()];
            this._commit();
        });
        this.add_row(dirRow);

        this.add_suffix(makePreviewButton('Preview this rule', () => onTest(this.rule)));
        const delBtn = new Gtk.Button({
            icon_name: 'user-trash-symbolic', valign: Gtk.Align.CENTER,
            css_classes: ['flat'], tooltip_text: 'Delete rule',
        });
        delBtn.connect('clicked', () => onDelete(this));
        this.add_suffix(delBtn);
    }

    _commit() {
        this.set_title(RuleRow._title(this.rule));
        this.set_subtitle(RuleRow._subtitle(this.rule));
        this._onChanged();
    }

    static _title(rule) {
        return rule.match || 'New rule';
    }

    static _subtitle(rule) {
        const cycles = rule.cycleCount !== undefined ? rule.cycleCount : 3;
        const cycleText = cycles === 0 ? 'until dismissed' : `${cycles} cycle(s)`;
        const title = rule.titleFilter ? ` · title has “${rule.titleFilter}”` : '';
        return `${rule.strokeCount || 2} stroke(s) × ${cycleText} · ${rule.direction || 'ltr'}${title}`;
    }
});

// ---------- quick script row ----------

const ScriptRow = GObject.registerClass(
class ScriptRow extends Adw.ExpanderRow {
    _init(script, onChanged, onDelete, onRun) {
        // Plain text: commands are full of & < > that markup would choke on.
        super._init({title: script.name || 'New script', subtitle: script.command || '', use_markup: false});
        this.script = script;
        this._onChanged = onChanged;

        this._prefixIcon = new Gtk.Image();
        setImageIcon(this._prefixIcon, script.icon);
        this.add_prefix(this._prefixIcon);

        const nameRow = new Adw.EntryRow({title: 'Name (shown in the menu)'});
        nameRow.set_text(script.name || '');
        nameRow.connect('changed', () => {
            this.script.name = nameRow.get_text().trim();
            this._commit();
        });
        this.add_row(nameRow);

        const cmdRow = new Adw.EntryRow({title: 'Command'});
        cmdRow.set_text(script.command || '');
        cmdRow.connect('changed', () => {
            this.script.command = cmdRow.get_text().trim();
            this._commit();
        });
        this.add_row(cmdRow);

        const iconRow = new Adw.ActionRow({title: 'Icon'});
        iconRow.add_suffix(makeIconPicker(script.icon || DEFAULT_SCRIPT_ICON, name => {
            this.script.icon = name;
            setImageIcon(this._prefixIcon, name);
            this._commit();
        }));
        this.add_row(iconRow);

        // Runs it through the extension, exactly like clicking it in the
        // top-bar menu: the answer shows on the bar and in the menu.
        this._runBtn = makePreviewButton('Run it like the menu does', () => onRun(this));
        this.add_suffix(this._runBtn);
        const delBtn = new Gtk.Button({
            icon_name: 'user-trash-symbolic', valign: Gtk.Align.CENTER,
            css_classes: ['flat'], tooltip_text: 'Delete script',
        });
        delBtn.connect('clicked', () => onDelete(this));
        this.add_suffix(delBtn);
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

export default class TopBarSwipePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.set_default_size(600, 720);

        this._buildGeneralPage(window, settings);
        this._buildReactPage(window, settings);
        this._buildAdvancedPage(window, settings);
        this._buildAboutPage(window);
    }

    // ================= General =================
    _buildGeneralPage(window, settings) {
        const page = new Adw.PreferencesPage({title: 'General', icon_name: 'preferences-system-symbolic'});
        window.add(page);

        const shared = new Adw.PreferencesGroup({title: 'Appearance'});
        page.add(shared);
        shared.add(makeSpinRow('Max Opacity', null, settings, 'swipe-opacity', 0.05, 1.0, 0.05, 2));
        shared.add(makeSpinRow('Border Radius (px)', null, settings, 'swipe-radius', 0, 200, 1));

        const lr = new Adw.PreferencesGroup({
            title: 'Side Timing', description: 'Left-to-right and right-to-left, used everywhere in the extension',
        });
        page.add(lr);
        lr.add(makeSpinRow('Stroke Length (px)', null, settings, 'swipe-lr-width', 20, 2000, 10));
        lr.add(makeSpinRow('Stroke Duration (ms)', null, settings, 'swipe-lr-duration', 100, 10000, 50));
        lr.add(makeSpinRow('Gap Between Strokes (ms)', null, settings, 'swipe-lr-stroke-gap', 0, 5000, 25));
        lr.add(makeSpinRow('Gap Between Cycles (ms)', 'Also the ambient idle interval', settings, 'swipe-lr-cycle-gap', 0, 60000, 100));

        const center = new Adw.PreferencesGroup({
            title: 'Center Timing', description: 'Center-out, used everywhere in the extension',
        });
        page.add(center);
        center.add(makeSpinRow('Stroke Length (px)', null, settings, 'swipe-center-width', 20, 2000, 10));
        center.add(makeSpinRow('Stroke Duration (ms)', null, settings, 'swipe-center-duration', 100, 10000, 50));
        center.add(makeSpinRow('Gap Between Strokes (ms)', null, settings, 'swipe-center-stroke-gap', 0, 5000, 25));
        center.add(makeSpinRow('Gap Between Cycles (ms)', 'Also the ambient idle interval', settings, 'swipe-center-cycle-gap', 0, 60000, 100));

        const ambient = new Adw.PreferencesGroup({title: 'Ambient Mode'});
        page.add(ambient);
        ambient.add(makeSwitchRow('Enabled', 'Keep swiping continuously with no notifications', settings, 'idle-loop-enabled'));
        ambient.add(makeColorRow('Color', settings, 'swipe-color'));
        ambient.add(makeDirectionRow('Direction', settings, 'swipe-direction'));
        ambient.add(makeSpinRow('Strokes per Cycle', null, settings, 'ambient-stroke-count', 1, 10, 1));
    }

    // ================= React =================
    _buildReactPage(window, settings) {
        const page = new Adw.PreferencesPage({title: 'React', icon_name: 'preferences-system-notifications-symbolic'});
        window.add(page);

        const {group} = makeTabbed([
            {id: 'notif', title: 'Notifications', build: box => this._buildNotificationsTab(box, settings)},
            {id: 'device', title: 'Device', build: box => this._buildDeviceTab(box, settings)},
        ]);
        page.add(group);
    }

    _buildNotificationsTab(box, settings) {
        const master = new Adw.PreferencesGroup({
            title: 'Notifications', description: 'Used when no rule below matches',
        });
        master.set_header_suffix(makeHeaderPreviewButton(() => sendTest(settings, {kind: 'notif', rule: null})));
        box.append(master);
        master.add(makeSwitchRow('React to Notifications', null, settings, 'notifications-enabled'));
        master.add(makeColorRow('Fallback Color', settings, 'notif-default-color'));
        master.add(makeDirectionRow('Fallback Direction', settings, 'notif-default-direction'));
        master.add(makeSpinRow('Fallback Strokes per Cycle', null, settings, 'default-stroke-count', 1, 10, 1));
        master.add(makeSpinRow('Fallback Cycles', null, settings, 'default-cycle-count', 1, 20, 1));

        const rulesGroup = new Adw.PreferencesGroup({
            title: 'Rules',
            description: 'Matched against the app name and the title, top to bottom; the first match wins',
        });
        box.append(rulesGroup);
        const addBtn = new Gtk.Button({
            icon_name: 'list-add-symbolic', css_classes: ['flat'],
            valign: Gtk.Align.CENTER, tooltip_text: 'Add rule',
        });
        rulesGroup.set_header_suffix(addBtn);

        const rows = [];
        const loadRules = () => {
            try {
                return JSON.parse(settings.get_string('app-rules'));
            } catch {
                return [];
            }
        };
        const saveAll = () => settings.set_string('app-rules', JSON.stringify(rows.map(r => r.rule)));
        const addRow = rule => {
            const row = new RuleRow(rule, saveAll, r => {
                rulesGroup.remove(r);
                const idx = rows.indexOf(r);
                if (idx >= 0)
                    rows.splice(idx, 1);
                saveAll();
            }, r => sendTest(settings, {kind: 'notif', rule: r}));
            rows.push(row);
            rulesGroup.add(row);
            return row;
        };
        loadRules().forEach(addRow);
        saveAll(); // persists the appName -> match migration once
        const newRule = (match = '') => ({
            match, titleFilter: '', color: '#50a0ff', strokeCount: 2, cycleCount: 3, direction: 'ltr',
        });
        addBtn.connect('clicked', () => addRow(newRule()).set_expanded(true));

        // Recently seen senders, so the exact app name is one click away.
        const recentGroup = new Adw.PreferencesGroup({
            title: 'Recently Seen Apps',
            description: 'The latest 6 apps that sent a notification. Click one to create a rule for it. ' +
                'Only app names are kept, never titles or messages.',
        });
        box.append(recentGroup);
        const flow = new Gtk.FlowBox({
            selection_mode: Gtk.SelectionMode.NONE, max_children_per_line: 4,
            column_spacing: 6, row_spacing: 6,
        });
        recentGroup.add(flow);
        const refreshRecent = () => {
            let child;
            while ((child = flow.get_first_child()))
                flow.remove(child);
            const apps = settings.get_strv('recent-notification-apps').slice(0, 6);
            if (apps.length === 0) {
                flow.append(new Gtk.Label({label: 'None yet. They appear as notifications arrive.', css_classes: ['dim-label']}));
                return;
            }
            apps.forEach(name => {
                const b = new Gtk.Button({label: name, css_classes: ['pill']});
                b.connect('clicked', () => addRow(newRule(name)).set_expanded(true));
                flow.append(b);
            });
        };
        refreshRecent();
        settings.connect('changed::recent-notification-apps', refreshRecent);
    }

    _buildDeviceTab(box, settings) {
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
        power.add_row(this._makeBatteryAlertsRow(settings));
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

        // ----- Fill bar (open by default) -----
        const battery = new Adw.ExpanderRow({
            title: 'Fill Bar',
            subtitle: 'Solid up to the level; swipes run inside it for the device\u2019s Cycles, then it fades away',
            expanded: true,
        });
        // The switch is the toggle; text, font and color open under it.
        const textExpander = new Adw.ExpanderRow({
            title: 'Show text', subtitle: 'Just right of the top bar\u2019s left section',
            show_enable_switch: true,
        });
        settings.bind('battery-show-percent', textExpander, 'enable-expansion', Gio.SettingsBindFlags.DEFAULT);
        battery.add_row(textExpander);

        const formatRow = new Adw.EntryRow({title: 'Text  ({percent} and {name} are filled in)', use_markup: false});
        formatRow.set_text(settings.get_string('battery-text-format'));
        formatRow.connect('changed', () => settings.set_string('battery-text-format', formatRow.get_text()));
        const textRows = [
            formatRow,
            this._makeBatteryFontRow(settings),
            makeColorRow('Text color', settings, 'battery-text-color'),
        ];
        textRows.forEach(r => textExpander.add_row(r));
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
        settings.connect('changed::battery-mid-threshold', syncHigh);
        syncHigh();
        battery.add_row(high);
        section(battery);
    }

    // One font button: family, weight (bold) and size all come from it.
    // An empty key means "the top bar's own font", shown in the subtitle.
    _makeBatteryFontRow(settings) {
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
        settings.connect('changed::battery-text-font', sync);
        sync();

        row.add_suffix(resetBtn);
        row.add_suffix(fontBtn);
        return row;
    }

    // Battery alerts live inside Power Adapter: the switch is on the row,
    // and the dropdowns only open under it while it's on.
    _makeBatteryAlertsRow(settings) {
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

    // ================= Advanced =================
    _buildAdvancedPage(window, settings) {
        const page = new Adw.PreferencesPage({title: 'Advanced', icon_name: 'applications-engineering-symbolic'});
        window.add(page);

        const master = new Adw.PreferencesGroup({
            title: 'Trigger Button', description: 'Run your own scripts from the top bar. Off by default.',
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
        const shortcutRow = this._makeShortcutRow(settings);
        master.add(shortcutRow);
        settings.bind('trigger-button-hidden', shortcutRow, 'visible', Gio.SettingsBindFlags.GET);

        const iconRow = new Adw.ActionRow({title: 'Icon'});
        iconRow.add_suffix(makeIconPicker(settings.get_string('trigger-button-icon'),
            name => settings.set_string('trigger-button-icon', name)));
        master.add(iconRow);

        master.add(this._makeHeaderExpander(settings));
        master.add(this._makeMenuItemsExpander(settings));

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
        outputGroup.add(this._makeFontRow(settings));
        outputGroup.add(this._makePreviewTextRow(window, settings));

        const {group: tabs} = makeTabbed([
            {id: 'scripts', title: 'Scripts', build: box => this._buildScriptsGroup(box, settings)},
            {id: 'schedule', title: 'Schedule', build: box => this._buildScheduleTab(box, settings)},
        ]);
        page.add(tabs);
    }

    _makeHeaderExpander(settings) {
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
        this._addFormatRows(expander, settings, 'menu-clock-time-format', 'Time (large, top line)', TIME_FORMATS, sample, sync);
        this._addFormatRows(expander, settings, 'menu-clock-date-format', 'Date (second line)', DATE_FORMATS, sample, sync);
        settings.connect('changed::menu-clock-enabled', sync);
        sync();
        return expander;
    }

    // A preset dropdown (labels rendered with the current time) plus a
    // "Custom" entry that only shows when chosen.
    _addFormatRows(expander, settings, key, title, presets, sample, onChange) {
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
        settings.connect(`changed::${key}`, onChange);

        expander.add_row(combo);
        expander.add_row(custom);
    }

    _makeMenuItemsExpander(settings) {
        const keys = [['menu-show-icon', 'Icon'], ['menu-show-name', 'Name'], ['menu-show-run', 'Run arrow']];
        const expander = new Adw.ExpanderRow({title: 'Menu Items'});
        const sync = () => {
            const on = keys.filter(([k]) => settings.get_boolean(k)).map(([, l]) => l);
            expander.set_subtitle(on.join(' · ') + (settings.get_boolean('menu-show-name') ? '' : '  (side by side)'));
        };
        keys.forEach(([key, label]) => {
            expander.add_row(makeSwitchRow(label, null, settings, key));
            settings.connect(`changed::${key}`, () => {
                // Keep at least one visible.
                if (keys.every(([k]) => !settings.get_boolean(k)))
                    settings.set_boolean(key, true);
                sync();
            });
        });
        sync();
        return expander;
    }

    _makePreviewTextRow(window, settings) {
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
            text => settings.set_string('output-preview-text', text.trim() || 'Your output will appear here!!')));
        settings.connect('changed::output-preview-text',
            () => row.set_subtitle(settings.get_string('output-preview-text')));

        const toggle = new Gtk.Switch({valign: Gtk.Align.CENTER, tooltip_text: 'Show the preview instead of running scripts'});
        settings.bind('output-label-debug', toggle, 'active', Gio.SettingsBindFlags.DEFAULT);
        row.add_suffix(editBtn);
        row.add_suffix(toggle);
        row.set_activatable_widget(toggle);
        return row;
    }

    _makeShortcutRow(settings) {
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

    _makeFontRow(settings) {
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

    _buildScriptsGroup(box, settings) {
        const group = new Adw.PreferencesGroup({
            title: 'Scripts', description: 'Each one becomes an item in the trigger menu',
        });
        box.append(group);
        const addBtn = new Gtk.Button({
            icon_name: 'list-add-symbolic', css_classes: ['flat'],
            valign: Gtk.Align.CENTER, tooltip_text: 'Add script',
        });
        group.set_header_suffix(addBtn);

        const rows = [];
        const load = () => {
            try {
                return JSON.parse(settings.get_string('quick-scripts'));
            } catch {
                return [];
            }
        };
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
            settings.bind('api-enabled', row._runBtn, 'sensitive', Gio.SettingsBindFlags.GET);
            rows.push(row);
            group.add(row);
            return row;
        };
        load().forEach(addRow);
        addBtn.connect('clicked', () => addRow({name: '', command: '', icon: DEFAULT_SCRIPT_ICON}).set_expanded(true));
    }

    // ================= Advanced › Schedule =================

    // Shared editor for a JSON list setting: header "+" button, one row per
    // entry, saved on every change.
    _buildJsonList(box, settings, key, {title, description, addTooltip, makeEntry, makeRow}) {
        const group = new Adw.PreferencesGroup({title, description});
        box.append(group);
        const addBtn = new Gtk.Button({
            icon_name: 'list-add-symbolic', css_classes: ['flat'],
            valign: Gtk.Align.CENTER, tooltip_text: addTooltip,
        });
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
        let saved = [];
        try {
            saved = JSON.parse(settings.get_string(key));
        } catch {
            // start empty
        }
        (Array.isArray(saved) ? saved : []).forEach(add);
        addBtn.connect('clicked', () => {
            add(makeEntry()).set_expanded(true);
            save();
        });
    }

    // Expander whose own switch is the entry's on/off.
    _makeEntryExpander(entry, save, remove, extraSuffix = null) {
        const row = new Adw.ExpanderRow({
            show_enable_switch: true, enable_expansion: entry.enabled !== false, use_markup: false,
        });
        row.connect('notify::enable-expansion', () => {
            entry.enabled = row.get_enable_expansion();
            save();
        });
        if (extraSuffix)
            row.add_suffix(extraSuffix);
        const delBtn = new Gtk.Button({
            icon_name: 'user-trash-symbolic', valign: Gtk.Align.CENTER,
            css_classes: ['flat'], tooltip_text: 'Delete',
        });
        delBtn.connect('clicked', remove);
        row.add_suffix(delBtn);
        return row;
    }

    _buildScheduleTab(box, settings) {
        const NONE = 'Choose a script…';
        const scriptNames = () => {
            try {
                return JSON.parse(settings.get_string('quick-scripts'))
                    .map(s => s?.name).filter(Boolean);
            } catch {
                return [];
            }
        };
        const pad = n => String(n).padStart(2, '0');
        const intervalText = total => {
            const h = Math.floor(total / 60), m = total % 60;
            return [h ? `${h} h` : '', m ? `${m} min` : ''].filter(Boolean).join(' ');
        };
        const timerSubtitle = e => {
            if (!e.mode)
                return 'Not set up yet';
            return e.mode === 'daily'
                ? `Daily at ${pad(e.hour ?? 9)}:${pad(e.minute ?? 0)}`
                : `Every ${intervalText(Math.max(1, e.minutes ?? 60))}`;
        };

        // Two-digit spin button, used for both clock times and intervals.
        const makeClockSpin = (upper, value, onChange) => {
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
        };
        const unit = label => new Gtk.Label({label, css_classes: ['dim-label'], valign: Gtk.Align.CENTER});

        this._buildJsonList(box, settings, 'timed-scripts', {
            title: 'Schedule Scripts',
            description: 'Run a saved script on a schedule, like a cron job: every so often, or daily at a set time. ' +
                'Its answer shows on the top bar and in the menu. Needs the Trigger Button on and a named script. ' +
                'Schedules pause while the computer sleeps.',
            addTooltip: 'Add schedule',
            // Blank: nothing is picked until you pick it.
            makeEntry: () => ({script: '', mode: '', enabled: true}),
            makeRow: (entry, save, remove) => {
                const row = this._makeEntryExpander(entry, save, remove);
                const sync = () => {
                    row.set_title(entry.script || 'New schedule');
                    row.set_subtitle(timerSubtitle(entry));
                };
                sync();

                // Script picker. Item 0 is the empty choice; refreshed when
                // scripts are added or renamed.
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
                const scriptsChangedId = settings.connect('changed::quick-scripts', fillScripts);
                row.connect('destroy', () => settings.disconnect(scriptsChangedId));
                row.add_row(scriptRow);

                const MODES = ['', 'every', 'daily'];
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
            },
        });
    }

    // ================= About =================
    _buildAboutPage(window) {
        const page = new Adw.PreferencesPage({title: 'About', icon_name: 'help-about-symbolic'});
        window.add(page);

        const header = new Adw.PreferencesGroup();
        page.add(header);
        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL, spacing: 8,
            halign: Gtk.Align.CENTER, margin_top: 24, margin_bottom: 12,
        });
        box.append(new Gtk.Image({icon_name: 'preferences-desktop-display-symbolic', pixel_size: 64}));
        box.append(new Gtk.Label({label: this.metadata.name, css_classes: ['title-1']}));
        const version = this.metadata['version-name'] ?? String(this.metadata.version ?? '');
        box.append(new Gtk.Label({label: `${version ? `v${version} · ` : ''}Made with ❤ by Koustav`, css_classes: ['dim-label']}));
        header.add(box);

        const links = new Adw.PreferencesGroup({title: 'Links'});
        page.add(links);
        const repo = this.metadata.url;
        [['Source code', repo],
            ['Report an issue', `${repo}/issues`],
            ['Website', 'https://koustavbetal.github.io']]
            .forEach(([label, uri]) => {
                const row = new Adw.ActionRow({title: label, subtitle: uri, activatable: true});
                row.add_suffix(new Gtk.Image({icon_name: 'adw-external-link-symbolic'}));
                row.connect('activated', () => new Gtk.UriLauncher({uri}).launch(window, null, null));
                links.add(row);
            });
    }
}
