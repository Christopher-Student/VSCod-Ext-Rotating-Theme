import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

interface Palette {
    name: string;
    colors: Record<string, string>;
}

interface RGB { r: number; g: number; b: number; }
interface CancelToken { cancelled: boolean; }

let state = {
    running: false,
    cancelToken: { cancelled: false } as CancelToken,
    palettes: [] as Palette[],
    index: 0,
    baseStatic: {} as Record<string, string>,
    animatedKeys: new Set<string>()
};

function sleep(ms: number) {
    return new Promise(res => setTimeout(res, ms));
}

// ---- color utils ----
function hexToRgb(hex: string): RGB | null {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
    if (!m) return null;
    const i = parseInt(m[1], 16);
    return { r: (i >> 16) & 255, g: (i >> 8) & 255, b: i & 255 };
}
function rgbToHex({ r, g, b }: RGB): string {
    const toByte = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
    return (
        '#' +
        toByte(r).toString(16).padStart(2, '0') +
        toByte(g).toString(16).padStart(2, '0') +
        toByte(b).toString(16).padStart(2, '0')
    );
}
const srgbToLinear = (c: number) => {
    c = c / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
};
const linearToSrgb = (v: number) => {
    return v <= 0.0031308 ? v * 12.92 * 255 : (1.055 * Math.pow(v, 1 / 2.4) - 0.055) * 255;
};
function lerp(a: number, b: number, t: number) { return a + (b - a) * t; }
function lerpHex(aHex: string, bHex: string, t: number): string {
    const a = hexToRgb(aHex), b = hexToRgb(bHex);
    if (!a || !b) return bHex || aHex || '#000000';
    const ar = srgbToLinear(a.r), ag = srgbToLinear(a.g), ab = srgbToLinear(a.b);
    const br = srgbToLinear(b.r), bg = srgbToLinear(b.g), bb = srgbToLinear(b.b);
    const r = linearToSrgb(lerp(ar, br, t));
    const g = linearToSrgb(lerp(ag, bg, t));
    const b_ = linearToSrgb(lerp(ab, bb, t));
    return rgbToHex({ r, g, b: b_ });
}

// ---- palettes ----
function readPalettesFrom(folder: string, keysWhitelist: string[]): Palette[] {
    if (!folder || !fs.existsSync(folder)) {
        throw new Error('Theme folder not set or does not exist. Set "rotatingTheme.themeFolder" in Settings.');
    }
    const files = fs.readdirSync(folder)
        .filter(f => f.toLowerCase().endsWith('.json'))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
    if (files.length === 0) throw new Error('No .json files found in the theme folder.');

    const palettes: Palette[] = [];
    for (const file of files) {
        try {
            const p = path.join(folder, file);
            const raw = fs.readFileSync(p, 'utf8');
            const json = JSON.parse(raw);
            const colors = json.colors && typeof json.colors === 'object' ? json.colors : json;
            const entry: Palette = { name: path.basename(file, '.json'), colors: {} };
            for (const [k, v] of Object.entries(colors)) {
                if (typeof v === 'string') {
                    if (keysWhitelist.length && !keysWhitelist.includes(k)) continue;
                    entry.colors[k] = v;
                }
            }
            palettes.push(entry);
        } catch (e) {
            console.warn('Skipping invalid palette file:', file, (e as Error).message);
        }
    }
    if (palettes.length === 0) throw new Error('No usable palettes found.');
    return palettes;
}

function unionKeys(palA: Palette, palB: Palette): string[] {
    const s = new Set([...Object.keys(palA.colors), ...Object.keys(palB.colors)]);
    return [...s];
}

function getBaseStaticAndAnimatedKeys(allPalettes: Palette[]) {
    const allKeys = new Set<string>();
    for (const p of allPalettes) for (const k of Object.keys(p.colors)) allKeys.add(k);
    const cfg = vscode.workspace.getConfiguration();
    const base = cfg.get<Record<string, string>>('workbench.colorCustomizations') || {};
    const baseStatic: Record<string, string> = {};
    for (const [k, v] of Object.entries(base)) {
        if (!allKeys.has(k)) baseStatic[k] = v;
    }
    return { baseStatic, animatedKeys: allKeys };
}

async function applyStep(stepColors: Record<string, string>, baseStatic: Record<string, string>) {
    const cfg = vscode.workspace.getConfiguration();
    const final = { ...baseStatic, ...stepColors };
    await cfg.update('workbench.colorCustomizations', final, vscode.ConfigurationTarget.Global);
}

// ---- rotation engine ----
async function fadeBetween(
    fromPal: Palette,
    toPal: Palette,
    durationMs: number,
    steps: number,
    baseStatic: Record<string, string>,
    cancelToken: CancelToken
) {
    const keys = unionKeys(fromPal, toPal);
    const perStepMs = Math.max(5, Math.floor(durationMs / steps));

    const pairs = keys.map(k => ({ key: k, a: fromPal.colors[k], b: toPal.colors[k] }));

    for (let i = 0; i <= steps; i++) {
        if (cancelToken.cancelled) return;
        const t = i / steps;
        const stepColors: Record<string, string> = {};
        for (const { key, a, b } of pairs) {
            if (typeof a === 'string' && typeof b === 'string' && hexToRgb(a) && hexToRgb(b)) {
                stepColors[key] = lerpHex(a, b, t);
            } else if (typeof b === 'string') {
                stepColors[key] = b;
            } else if (typeof a === 'string') {
                stepColors[key] = a;
            }
        }
        await applyStep(stepColors, baseStatic);
        if (i < steps) await sleep(perStepMs);
    }
}

async function startRotation() {
    if (state.running) {
        vscode.window.showInformationMessage('Rotating Theme: already running.');
        return;
    }
    const cfg = vscode.workspace.getConfiguration();
    const folder = cfg.get<string>('rotatingTheme.themeFolder') || '';
    const durationMs = cfg.get<number>('rotatingTheme.transitionDurationMs') || 1500;
    const steps = cfg.get<number>('rotatingTheme.transitionSteps') || 30;
    const dwellMs = cfg.get<number>('rotatingTheme.dwellMs') || 4000;
    const whitelist = cfg.get<string[]>('rotatingTheme.keysWhitelist') || [];

    let palettes: Palette[];
    try {
        palettes = readPalettesFrom(folder, whitelist);
    } catch (e) {
        vscode.window.showErrorMessage(`Rotating Theme: ${(e as Error).message}`);
        return;
    }

    const { baseStatic, animatedKeys } = getBaseStaticAndAnimatedKeys(palettes);
    state.baseStatic = baseStatic;
    state.animatedKeys = animatedKeys;
    state.palettes = palettes;
    state.index = 0;
    state.cancelToken = { cancelled: false };
    state.running = true;

    await applyStep(palettes[state.index].colors, baseStatic);

    (async () => {
        try {
            while (!state.cancelToken.cancelled) {
                const from = palettes[state.index];
                const to = palettes[(state.index + 1) % palettes.length];
                await fadeBetween(from, to, durationMs, steps, baseStatic, state.cancelToken);
                if (state.cancelToken.cancelled) break;
                state.index = (state.index + 1) % palettes.length;
                if (dwellMs > 0) await sleep(dwellMs);
            }
        } finally {
            state.running = false;
        }
    })();
}

async function stopRotation() {
    if (!state.running) {
        if (Object.keys(state.baseStatic).length) {
            const cfg = vscode.workspace.getConfiguration();
            await cfg.update('workbench.colorCustomizations', state.baseStatic, vscode.ConfigurationTarget.Global);
        }
        return;
    }
    state.cancelToken.cancelled = true;
    setTimeout(async () => {
        const cfg = vscode.workspace.getConfiguration();
        await cfg.update('workbench.colorCustomizations', state.baseStatic, vscode.ConfigurationTarget.Global);
    }, 50);
}

async function nextNow() {
    if (!state.running || state.palettes.length < 2) return;
    state.index = (state.index + 1) % state.palettes.length;
    await applyStep(state.palettes[state.index].colors, state.baseStatic);
}

export function activate(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.commands.registerCommand('rotatingTheme.start', () => startRotation()),
        vscode.commands.registerCommand('rotatingTheme.stop', () => stopRotation()),
        vscode.commands.registerCommand('rotatingTheme.nextNow', () => nextNow())
    );
}

export function deactivate() {
    if (state.running) {
        state.cancelToken.cancelled = true;
    }
}
