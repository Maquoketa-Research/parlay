"""Generate fork/patches/drydock-glass.patch against a prepared VS Code tree.

The glass look needs three small source changes that no theme can make:
  1. windows.ts       the BrowserWindow gets Windows 11 acrylic behind a transparent background
  2. workbench.ts     the workbench root and <body> get a class when the setting is on
  3. style.css        that class makes them transparent, so the acrylic shows through the
                      alpha-coloured chrome of the Drydock Glass theme. The editor stays opaque.
All gated on the setting `drydock.glass`, which the extension flips when the Glass theme is chosen.

Usage: python tools/glass-patch.py <path-to-vscode-checkout>
The checkout must already carry VSCodium's patches (run after get_repo.sh + prepare, or on the tree a
previous build left behind); user patches are applied after theirs, so the diff is taken on top of them.
"""
import os, subprocess, sys

IDE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(IDE, "fork", "patches", "drydock-glass.patch")

FILES = {
    "src/vs/platform/windows/electron-main/windows.ts": (
        "\tif (isWindows) {\n\t\tlet borderSetting = windowSettings?.border || 'default';",
        "\t// Drydock: glass chrome. Windows 11 draws acrylic behind the window; the window itself is transparent\n"
        "\t// so the alpha-coloured parts of the Drydock Glass theme let it through. Gated on drydock.glass.\n"
        "\tif (isWindows && configurationService.getValue<boolean>('drydock.glass') === true) {\n"
        "\t\toptions.backgroundMaterial = 'acrylic';\n"
        "\t\toptions.backgroundColor = '#00000000';\n"
        "\t}\n\n"
        "\tif (isWindows) {\n\t\tlet borderSetting = windowSettings?.border || 'default';",
    ),
    "src/vs/workbench/browser/workbench.ts": (
        "\t\tthis.mainContainer.classList.add(...workbenchClasses);\n",
        "\t\tthis.mainContainer.classList.add(...workbenchClasses);\n\n"
        "\t\t// Drydock: glass chrome marks the root so style.css can make it transparent\n"
        "\t\tif (configurationService.getValue<boolean>('drydock.glass') === true) {\n"
        "\t\t\tthis.mainContainer.classList.add('drydock-glass');\n"
        "\t\t\tthis.mainContainer.ownerDocument.body.classList.add('drydock-glass');\n"
        "\t\t}\n"
        "\t\t// Drydock: two-row header (mark and title above the menu); the title bar reports the extra height\n"
        "\t\tif (configurationService.getValue<boolean>('drydock.stackedHeader') === true) {\n"
        "\t\t\tthis.mainContainer.classList.add('drydock-stacked');\n"
        "\t\t}\n",
    ),
    "src/vs/workbench/browser/parts/titlebar/titlebarPart.ts": (
        "\t\tlet value = this.isCommandCenterVisible || wcoEnabled ? DEFAULT_CUSTOM_TITLEBAR_HEIGHT : 30;\n",
        "\t\tlet value = this.isCommandCenterVisible || wcoEnabled ? DEFAULT_CUSTOM_TITLEBAR_HEIGHT : 30;\n"
        "\t\t// Drydock: a second row for the menu when the header is stacked (drydock.css lays it out)\n"
        "\t\tif (!this.isAuxiliary && this.configurationService.getValue<boolean>('drydock.stackedHeader') === true) {\n"
        "\t\t\tvalue += 26;\n"
        "\t\t}\n",
    ),
    "src/vs/platform/theme/electron-main/themeMainServiceImpl.ts": (
        "\t\t\tif (window.id === windowId) {\n\t\t\t\twindow.setBackgroundColor(splash.colorInfo.background);\n",
        "\t\t\tif (window.id === windowId) {\n"
        "\t\t\t\t// Drydock: a glass window keeps its transparent background; the splash colour would paint it opaque\n"
        "\t\t\t\tif (this.configurationService.getValue<boolean>('drydock.glass') === true) {\n"
        "\t\t\t\t\tbreak;\n"
        "\t\t\t\t}\n"
        "\t\t\t\twindow.setBackgroundColor(splash.colorInfo.background);\n",
    ),
    "src/vs/workbench/browser/media/style.css": (
        None,  # append
        "\n/* Drydock: glass chrome (setting drydock.glass). The root is transparent so the window's acrylic\n"
        "   shows through the theme's alpha-coloured chrome; the editor keeps its own opaque background. */\n"
        "body.drydock-glass,\n"
        ".monaco-workbench.drydock-glass {\n"
        "\tbackground-color: transparent !important;\n"
        "}\n\n"
        + open(os.path.join(IDE, "fork", "drydock.css"), encoding="utf-8").read().replace("\r\n", "\n"),
    ),
}


def git(root, *args):
    return subprocess.run(["git", "-C", root, *args], check=True, capture_output=True, text=True).stdout


def main(root):
    paths = list(FILES)
    # Refuse a tree that already carries this patch: diffing against it yields a patch whose pre-image
    # includes our own earlier hunks, which then silently fails to add anything on a fresh checkout.
    marker = open(os.path.join(root, "src/vs/workbench/browser/media/style.css"), encoding="utf-8", newline="").read()
    if "drydock-glass" in marker:
        sys.exit("the tree already has the Drydock patch applied; revert it first: git apply -R fork/patches/drydock-glass.patch")
    git(root, "add", "--", *paths)  # index = the tree as VSCodium left it
    try:
        for rel, (anchor, replacement) in FILES.items():
            p = os.path.join(root, rel)
            text = open(p, encoding="utf-8", newline="").read()
            nl = "\r\n" if "\r\n" in text else "\n"          # the checkout may be CRLF on Windows
            replacement = replacement.replace("\n", nl)
            if anchor is None:
                new = text.rstrip("\r\n") + nl + replacement
            else:
                anchor = anchor.replace("\n", nl)
                if text.count(anchor) != 1:
                    sys.exit(f"anchor not found exactly once in {rel} (found {text.count(anchor)}); upstream moved, update glass-patch.py")
                new = text.replace(anchor, replacement)
            open(p, "w", encoding="utf-8", newline="").write(new)
        diff = git(root, "diff", "--", *paths)
    finally:
        git(root, "checkout", "--", *paths)   # back to VSCodium's state
        git(root, "reset", "-q", "--", *paths)
    if not diff.strip():
        sys.exit("empty diff")
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    open(OUT, "w", encoding="utf-8", newline="\n").write(diff)
    print(f"wrote {OUT} ({diff.count(chr(10))} lines, {len(paths)} files)")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser("~/dd/harness/vscode"))
