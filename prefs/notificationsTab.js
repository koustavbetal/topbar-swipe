// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Koustav Betal

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';

import {RuleRow} from './rows.js';
import {
    makeSwitchRow, makeColorRow, makeDirectionRow, makeSpinRow,
    makeHeaderPreviewButton, makeAddButton, sendTest, loadJsonList, connectSetting,
} from './widgets.js';

const RECENT_APPS_SHOWN = 6;

export function buildNotificationsTab(box, settings) {
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
    const addBtn = makeAddButton('Add rule');
    rulesGroup.set_header_suffix(addBtn);

    const rows = [];
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
    loadJsonList(settings, 'app-rules').forEach(addRow);
    saveAll(); // persists the appName -> match migration once
    const newRule = (match = '') => ({
        match, titleFilter: '', color: '#50a0ff', strokeCount: 2, cycleCount: 3, direction: 'ltr',
    });
    addBtn.connect('clicked', () => addRow(newRule()).set_expanded(true));

    // Recently seen senders, so the exact app name is one click away.
    const recentGroup = new Adw.PreferencesGroup({
        title: 'Recently Seen Apps',
        description: `The latest ${RECENT_APPS_SHOWN} apps that sent a notification. Click one to create a rule for it. ` +
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
        const apps = settings.get_strv('recent-notification-apps').slice(0, RECENT_APPS_SHOWN);
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
    connectSetting(settings, 'recent-notification-apps', refreshRecent);
}
