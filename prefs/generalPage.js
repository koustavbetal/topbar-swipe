// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Koustav Betal

import Adw from 'gi://Adw';

import {makeSpinRow, makeSwitchRow, makeColorRow, makeDirectionRow} from './widgets.js';

export function buildGeneralPage(window, settings) {
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
