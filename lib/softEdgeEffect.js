// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Koustav Betal

import Shell from 'gi://Shell';
import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';

// Fades the actor it is attached to across its right-hand edge: alpha
// ramps linearly from full at (1 - softWidth) to 0 at the right end, the
// same solid-to-clear ramp the battery fill's soft edge uses. Colors are
// premultiplied, so every channel is scaled.
export const SoftRightEdgeEffect = GObject.registerClass(
class SoftRightEdgeEffect extends Shell.GLSLEffect {
    _init(params) {
        super._init(params);
        this._softWidthLocation = this.get_uniform_location('soft_width');
    }

    vfunc_build_pipeline() {
        const hook = (Shell.SnippetHook ?? Cogl.SnippetHook).FRAGMENT;
        this.add_glsl_snippet(hook,
            'uniform float soft_width;',
            'float edge = clamp((1.0 - cogl_tex_coord_in[0].x) / max(soft_width, 0.0001), 0.0, 1.0);\n' +
            'cogl_color_out *= edge;',
            false);
    }

    // `fraction` of the actor's width (0..1) that makes up the soft edge.
    setSoftWidth(fraction) {
        this.set_uniform_float(this._softWidthLocation, 1, [fraction]);
    }
});
