"""Generate the three Drydock colour themes from one palette each. Run: python tools/themes.py

Dark is the default look. Glass is the same editor with neutral frosted chrome (alpha whites over the
workbench base; the fork's window patch makes them true glass). Paper is the light look.
"""
import json, os

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "themes")


def tokens(kw, s, fn, num, com, plain, typ, kw_style=None):
    kw_settings = {"foreground": kw}
    if kw_style:
        kw_settings["fontStyle"] = kw_style
    return [
        {"scope": ["keyword", "keyword.control", "storage.type", "storage.modifier", "keyword.operator.logical"], "settings": kw_settings},
        {"scope": ["string", "string.quoted", "string.interpolated"], "settings": {"foreground": s}},
        {"scope": ["entity.name.function", "support.function", "meta.function-call entity.name.function"], "settings": {"foreground": fn}},
        {"scope": ["constant.numeric", "constant.language"], "settings": {"foreground": num}},
        {"scope": ["comment", "punctuation.definition.comment"], "settings": {"foreground": com, "fontStyle": "italic"}},
        {"scope": ["variable", "variable.other", "punctuation", "keyword.operator"], "settings": {"foreground": plain}},
        {"scope": ["support.type", "entity.name.type", "storage.type.luau"], "settings": {"foreground": typ}},
    ]


def chrome(bg, surface, deep, fg, muted, faint, border, line, sel, button_bg, button_fg, accent, widget, widget_border, green, red, yellow, blue, magenta):
    return {
        "editor.background": bg, "editor.foreground": fg,
        "editorLineNumber.foreground": line, "editorLineNumber.activeForeground": fg,
        "editorCursor.foreground": fg, "editor.selectionBackground": sel, "editor.inactiveSelectionBackground": sel[:7] + "0A",
        "editor.lineHighlightBackground": fg + "08",
        "editorIndentGuide.background1": border, "editorIndentGuide.activeBackground1": faint, "editorWhitespace.foreground": border,
        "diffEditor.insertedTextBackground": green + "18", "diffEditor.removedTextBackground": red + "12",
        "diffEditor.insertedLineBackground": green + "0C", "diffEditor.removedLineBackground": red + "08",
        "sideBar.background": surface, "sideBar.foreground": fg, "sideBar.border": border,
        "sideBarTitle.foreground": muted, "sideBarSectionHeader.background": surface, "sideBarSectionHeader.foreground": muted,
        "activityBar.background": deep, "activityBar.foreground": fg, "activityBar.inactiveForeground": faint, "activityBar.border": border,
        "activityBarBadge.background": button_bg, "activityBarBadge.foreground": button_fg,
        "titleBar.activeBackground": surface, "titleBar.activeForeground": fg, "titleBar.inactiveBackground": surface,
        "titleBar.inactiveForeground": muted, "titleBar.border": border,
        "statusBar.background": surface, "statusBar.foreground": muted, "statusBar.border": border,
        "statusBar.noFolderBackground": surface, "statusBarItem.hoverBackground": fg + "14",
        "panel.background": surface, "panel.border": border,
        "panelTitle.activeForeground": fg, "panelTitle.inactiveForeground": muted, "panelTitle.activeBorder": accent,
        "tab.activeBackground": bg, "tab.inactiveBackground": surface, "tab.activeForeground": fg, "tab.inactiveForeground": muted,
        "tab.border": border, "tab.activeBorderTop": accent,
        "editorGroupHeader.tabsBackground": surface, "editorGroupHeader.tabsBorder": border,
        "list.activeSelectionBackground": fg + "14", "list.activeSelectionForeground": fg,
        "list.inactiveSelectionBackground": fg + "0C", "list.hoverBackground": fg + "08", "list.focusOutline": accent,
        "focusBorder": accent, "foreground": fg, "descriptionForeground": muted, "widget.shadow": "#00000040",
        "input.background": deep, "input.border": border, "input.foreground": fg, "input.placeholderForeground": faint,
        "button.background": button_bg, "button.foreground": button_fg, "button.hoverBackground": button_bg,
        "button.secondaryBackground": border, "button.secondaryForeground": fg,
        "badge.background": button_bg, "badge.foreground": button_fg, "progressBar.background": accent,
        "scrollbarSlider.background": fg + "14", "scrollbarSlider.hoverBackground": fg + "22",
        "menu.background": widget, "menu.foreground": fg, "menu.selectionBackground": fg + "14",
        "menu.selectionForeground": fg, "menu.separatorBackground": border, "menu.border": widget_border,
        "editorWidget.background": widget, "editorWidget.border": widget_border,
        "editorSuggestWidget.background": widget, "editorHoverWidget.background": widget, "editorHoverWidget.border": widget_border,
        "notifications.background": widget, "notifications.border": widget_border,
        "terminal.background": surface, "terminal.foreground": fg, "terminalCursor.foreground": fg,
        "terminal.ansiGreen": green, "terminal.ansiRed": red, "terminal.ansiYellow": yellow, "terminal.ansiBlue": blue,
        "terminal.ansiCyan": blue, "terminal.ansiMagenta": magenta, "terminal.ansiWhite": fg, "terminal.ansiBrightBlack": faint,
        "gitDecoration.modifiedResourceForeground": yellow, "gitDecoration.addedResourceForeground": green,
        "gitDecoration.untrackedResourceForeground": green, "gitDecoration.deletedResourceForeground": red,
        "editorError.foreground": red, "editorWarning.foreground": yellow, "editorInfo.foreground": blue,
        "textLink.foreground": fg, "textLink.activeForeground": fg, "minimap.background": bg,
        "breadcrumb.foreground": muted, "breadcrumb.focusForeground": fg,
    }


dark_colors = chrome(
    bg="#16181D", surface="#111317", deep="#0E1013", fg="#D7DAE0", muted="#9AA0A6", faint="#6B7280", border="#23262E",
    line="#7A818E", sel="#FFFFFF1A", button_bg="#E6E8EB", button_fg="#0D0D0D", accent="#8A9099",
    widget="#1C1F26", widget_border="#2C303A", green="#7BB78F", red="#D08484", yellow="#C9B27C", blue="#9FB3C8", magenta="#B3A3C8",
)
dark_tokens = tokens("#9FB3C8", "#A3B99A", "#E6E8EB", "#C9B27C", "#7B8290", "#D7DAE0", "#B3A3C8")

# Glass chrome: dark tints with alpha over the window's acrylic, so the desktop shows through but light text
# stays readable over a bright backdrop too. Alpha A6 = 65%, 8C = 55%, B3 = 70%.
glass_colors = dict(dark_colors)
glass_colors.update({
    "sideBar.background": "#0E1013A6", "sideBar.border": "#FFFFFF1F", "sideBarSectionHeader.background": "#00000000",
    "activityBar.background": "#0B0D10B3", "activityBar.border": "#FFFFFF1F",
    "titleBar.activeBackground": "#0E1013A6", "titleBar.inactiveBackground": "#0E10138C", "titleBar.border": "#FFFFFF1F",
    "statusBar.background": "#0E1013A6", "statusBar.border": "#FFFFFF1F", "statusBar.noFolderBackground": "#0E1013A6",
    "panel.background": "#0E10138C", "panel.border": "#FFFFFF1F",
    "tab.inactiveBackground": "#0E10138C", "tab.border": "#FFFFFF14",
    "editorGroupHeader.tabsBackground": "#0E10138C", "editorGroupHeader.tabsBorder": "#FFFFFF1F",
    "editorGroup.emptyBackground": "#0E10138C",
    "menu.background": "#2A2E36", "menu.border": "#FFFFFF33", "editorWidget.background": "#2A2E36", "editorWidget.border": "#FFFFFF33",
    "editorSuggestWidget.background": "#2A2E36", "editorHoverWidget.background": "#2A2E36", "editorHoverWidget.border": "#FFFFFF33",
    "notifications.background": "#2A2E36", "notifications.border": "#FFFFFF33",
    "input.background": "#FFFFFF0A", "input.border": "#FFFFFF22", "widget.shadow": "#00000066",
    "terminal.background": "#111317",
})

paper_colors = chrome(
    bg="#FFFFFF", surface="#F9F9F9", deep="#F9F9F9", fg="#0D0D0D", muted="#5D5D5D", faint="#8F8F8F", border="#ECECEC",
    line="#8F8F8F", sel="#0D0D0D14", button_bg="#0D0D0D", button_fg="#FFFFFF", accent="#0D0D0D",
    widget="#FFFFFF", widget_border="#ECECEC", green="#10A37F", red="#D92D20", yellow="#8A5D0C", blue="#3B5B7A", magenta="#5D5D5D",
)
paper_colors.update({"diffEditor.insertedLineBackground": "#F0FDF4", "diffEditor.removedLineBackground": "#FEF3F2", "widget.shadow": "#00000014"})
paper_tokens = tokens("#0D0D0D", "#5D5D5D", "#0D0D0D", "#3B5B7A", "#8F8F8F", "#0D0D0D", "#5D5D5D", kw_style="bold")

THEMES = {
    "drydock-dark": {"name": "Drydock Dark", "type": "dark", "semanticHighlighting": True, "colors": dark_colors, "tokenColors": dark_tokens},
    "drydock-glass": {"name": "Drydock Glass", "type": "dark", "semanticHighlighting": True, "colors": glass_colors, "tokenColors": dark_tokens},
    "drydock-paper": {"name": "Drydock Paper", "type": "light", "semanticHighlighting": True, "colors": paper_colors, "tokenColors": paper_tokens},
}

if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    for name, theme in THEMES.items():
        with open(os.path.join(OUT, f"{name}.json"), "w", encoding="utf-8") as f:
            json.dump(theme, f, indent=1)
    print("themes:", ", ".join(THEMES))
