#!/usr/bin/env bash
# LICENSE.rtf for the Inno installer (build/win32/code.iss shows it when present). After VSCodium's
# build/windows/rtf/make.sh: the plain-text licence, paragraphs kept, in a Consolas RTF shell.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

{
	printf '%s\n' '{\rtf1\ansi\deff0{\fonttbl{\f0\fnil\fcharset0 Consolas;}}' '\viewkind4\uc1\pard\lang1033\f0\fs22' ''
	sed -zE -e 's/([A-Za-z,])\r?\n([A-Za-z])/\1 \2/g' -e 's/\r?\n\r?\n/\\par\n\n/g' -e 's/(\\par\n)/\\line\1/g' -e 's/\s*(Copyright)/\\line\n\1/g' -e 's/(\\par)\\line/\1\n/g' LICENSE.txt
	printf '\n%s\n%s\n' '\par' '}'
} > LICENSE.rtf
