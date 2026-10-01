#!/bin/sh
# Builds the static site for Render: wraps index.html (written as an artifact
# page body) in a full HTML document so browsers render it in standards mode.
set -e
rm -rf dist
mkdir -p dist
{
  printf '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n</head>\n<body>\n'
  cat index.html
  printf '\n</body>\n</html>\n'
} > dist/index.html
echo "Built dist/index.html"
