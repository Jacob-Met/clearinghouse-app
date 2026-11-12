#!/usr/bin/env python3
"""Turn a dark stylesheet into a light, neutral one, property by property.

  retheme.py to-light|to-dark <accent-hex> <css-file>...

Writes <name>.light.css or <name>.dark.css beside each file; the original is not touched. The second
sheet has the same selectors, so loading it after the original swaps every colour and nothing else.
Text, surfaces, rules and accent fills are each mapped by the property they appear in, and a faint
trace of the original hue is kept so the result still belongs to the product.
"""
import colorsys, os, re, shutil, sys

mode, accent, files = sys.argv[1], sys.argv[2], sys.argv[3:]
DARK = mode == 'to-dark'
KEEP = os.environ.get('RETHEME_KEEP_LIGHT_FILLS') == '1'   # the product's accent is already a light fill with dark text
TEXT = ('color', 'fill', 'caret-color', 'text-decoration-color', '-webkit-text-fill-color', 'text-decoration', 'accent-color')
EDGE = ('border', 'outline', 'box-shadow', 'stroke', 'column-rule', 'text-shadow')

def parse(h):
    h = h[1:]
    if len(h) in (3, 4): h = ''.join(c * 2 for c in h)
    return [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)], (h[6:8] if len(h) == 8 else '')

def fmt(rgb, a): return '#' + ''.join('%02x' % max(0, min(255, round(c * 255))) for c in rgb) + a

def warm(h): return h < 0.2 or h > 0.9

def remap(hexv, kind):
    (r, g, b), a = parse(hexv)
    h, l, s = colorsys.rgb_to_hls(r, g, b)
    if DARK:
        if warm(h) and s > 0.3 or (0.2 <= h <= 0.48 and s > 0.3):   # ambers, reds, greens keep their meaning
            if kind == 'text': l, s = max(l, 0.72), min(s, 0.8)
            elif kind == 'edge': l, s = 0.5, s * 0.7
            elif 0.5 < l <= 0.85 and s > 0.6: return hexv                    # a bright brand or status fill stays
            else: l, s = (0.2 if l > 0.5 else 0.16), s * 0.55
        elif kind == 'text':
            if l < 0.5: l, s = max(0.62, 0.94 - l * 0.9), s * 0.25           # dark text -> light text
            else: return hexv                                                # light text sits on a fill: keep
        elif kind == 'edge':
            l, s = (0.78 if l < 0.2 else 0.27), s * 0.2
        else:
            if l >= 0.5: l, s = max(0.085, 0.085 + (1 - l) * 0.9), min(s, 0.18)   # light surface -> near black
            elif s > 0.45 and l > 0.3: return accent + a                         # a true accent fill
            else: l, s = 0.15, min(s, 0.3)                                       # dark bar or chip -> raised surface
        return fmt(colorsys.hls_to_rgb(h, l, s), a)
    if KEEP and kind == 'fill' and l >= 0.5: return hexv
    if KEEP and kind == 'text' and l < 0.5: return hexv
    if (warm(h) or 0.2 <= h <= 0.48) and s > 0.3:   # ambers, reds, greens: keep meaning, fit a light page
        if kind == 'text': l, s = min(l, 0.36), min(s, 0.85)
        elif kind == 'edge': l, s = 0.62, s * 0.8
        elif l > 0.5: l, s = 0.95, s * 0.9
        else: return hexv                            # a solid status colour stays solid
    elif kind == 'text':
        if l >= 0.5: l, s = min(0.46, 0.12 + (1 - l) * 1.35), s * 0.35     # light text -> dark text
        else: l, s = 1.0, 0                                              # dark text on a fill -> white
    elif kind == 'edge':
        l, s = (0.34 if l > 0.86 else 0.84), s * 0.22
    else:                                        # surfaces
        if l < 0.5: l, s = min(1.0, 0.955 + l * 0.16), s * 0.28           # dark surface -> near white
        else: return accent + a                                           # light fill -> accent
    return fmt(colorsys.hls_to_rgb(h, l, s), a)

VAR_USE = {}

def kind_of(prop):
    p = prop.strip().lower()
    if p.startswith('--'):
        if p in VAR_USE: return VAR_USE[p]           # how the sheet actually uses this variable
        if re.search(r'ink|muted|text|fg|label', p): return 'text'
        if re.search(r'line|rule|border|stroke|divider', p): return 'edge'
        return 'fill'
    if p in TEXT or p.endswith('-color') and p.startswith(('text', 'caret')): return 'text'
    if any(p.startswith(e) for e in EDGE): return 'edge'
    return 'fill'

HEX = re.compile(r'#[0-9a-fA-F]{3,8}\b')
DECL = re.compile(r'([\w-]+)(\s*:\s*)([^;{}]+)')

def convert(css):
    # A custom property is mapped by where it is used most (text, rule or surface), not by its name.
    VAR_USE.clear(); votes = {}
    for m in DECL.finditer(css):
        prop = m.group(1).strip().lower()
        if prop.startswith('--'): continue
        for name in re.findall(r'var\((--[\w-]+)', m.group(3)):
            votes.setdefault(name.lower(), []).append(kind_of(prop))
    for name, kinds in votes.items(): VAR_USE[name] = max(set(kinds), key=kinds.count)
    def decl(m):
        prop, sep, val = m.group(1), m.group(2), m.group(3)
        k = kind_of(prop)
        if prop.strip().lower() == 'background-image' and 'linear-gradient(#' in val and '1px,transparent 1px' in val:
            return prop + sep + 'none'                 # drop drawn grid backgrounds
        val = re.sub(r'\bwhite\b', '#fff', re.sub(r'\bblack\b', '#000', val))
        return prop + sep + HEX.sub(lambda h: remap(h.group(0), k), val)
    return DECL.sub(decl, css)

for f in files:
    out = f[:-4] + ('.dark.css' if DARK else '.light.css')
    open(out, 'w').write(convert(open(f).read()))
    print(out)
