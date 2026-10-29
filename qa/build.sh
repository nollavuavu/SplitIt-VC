#!/bin/sh
# Builds index.html from the source files in contract merge order.
cd "$(dirname "$0")/.."
{
  printf '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n<meta name="color-scheme" content="light dark">\n<title>SplitIt</title>\n'
  # PWA tags (Agent 3): manifest (sent with cookies because the site is behind
  # a Netlify login), theme colours from styles.css, home-screen and tab icons.
  # Links are relative (no leading /) so opening index.html as a file does not
  # log "file not found" errors; served from the site root they mean the same.
  printf '<link rel="manifest" href="manifest.webmanifest" crossorigin="use-credentials">\n'
  printf '<meta name="theme-color" content="#f7f7f8" media="(prefers-color-scheme: light)">\n'
  printf '<meta name="theme-color" content="#121316" media="(prefers-color-scheme: dark)">\n'
  printf '<link rel="apple-touch-icon" href="icons/apple-touch-icon.png">\n'
  printf '<link rel="icon" type="image/png" sizes="32x32" href="icons/favicon-32.png">\n'
  printf '<link rel="icon" type="image/png" sizes="16x16" href="icons/favicon-16.png">\n'
  printf '<style>\n'
  cat styles.css; printf '\n'; cat input.css
  printf '\n</style>\n</head>\n<body>\n<div id="app"></div>\n<script>\n'
  cat engine.js; printf '\n'; cat shell.js; printf '\n'; cat input.js; printf '\n'; cat ui.js
  printf '\nSplitIt.start();\n</script>\n</body>\n</html>\n'
} > index.html

echo "built index.html"
