#!/bin/sh
# Builds index.html from the source files in contract merge order.
cd "$(dirname "$0")/.."
{
  printf '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n<meta name="color-scheme" content="light dark">\n<title>SplitIt</title>\n<style>\n'
  cat styles.css; printf '\n'; cat input.css
  printf '\n</style>\n</head>\n<body>\n<div id="app"></div>\n<script>\n'
  cat engine.js; printf '\n'; cat shell.js; printf '\n'; cat input.js; printf '\n'; cat ui.js
  printf '\nSplitIt.start();\n</script>\n</body>\n</html>\n'
} > index.html

# Private copy with the Gemini key filled in (never commit index.local.html).
# The key is read from .gemini_key and is never printed.
if [ -f .gemini_key ]; then
  python3 - <<'PY'
key = open('.gemini_key').read().strip()
key = key.replace('\\', '\\\\').replace("'", "\\'")
html = open('index.html').read()
line = "const API_KEY = '';"
if html.count(line) != 1:
    raise SystemExit('build.sh: expected exactly one empty API_KEY line in index.html')
open('index.local.html', 'w').write(html.replace(line, "const API_KEY = '" + key + "';"))
PY
  chmod 600 index.local.html
  echo "built index.html and index.local.html"
else
  echo "built index.html (no .gemini_key, so no index.local.html)"
fi
