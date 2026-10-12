// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Koustav Betal

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import GObject from 'gi://GObject';

import {DEFAULT_SCRIPT_ICON} from '../lib/common.js';
import {makeIconPicker} from './iconPicker.js';
import {
    DIRECTIONS, DIRECTION_LABELS,
    makeColorButton, makePreviewButton, makeDeleteButton, setImageIcon,
} from './widgets.js';

// ---------- notification rule ----------

export const RuleRow = GObject.registerClass(
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
        this.add_suffix(makeDeleteButton('Delete rule', () => onDelete(this)));
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

// ---------- quick script ----------

export const ScriptRow = GObject.registerClass(
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
        this.runButton = makePreviewButton('Run it like the menu does', () => onRun(this));
        this.add_suffix(this.runButton);
        this.add_suffix(makeDeleteButton('Delete script', () => onDelete(this)));
    }

    _commit() {
        this.set_title(this.script.name || 'New script');
        this.set_subtitle(this.script.command || '');
        this._onChanged();
    }
});
