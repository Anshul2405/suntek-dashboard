#!/bin/zsh
set -e
cd "$(dirname "$0")/.."
firebase login --reauth
firebase deploy --only hosting
echo "Done → https://suntek-86ae6.web.app"
