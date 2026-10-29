#!/bin/bash
set -e

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${BLUE}Starting installation of YouTube MPRIS Fix...${NC}"

# 1. Build the native host
echo -e "${BLUE}Building native host...${NC}"
make host

# 2. Install the native host manifest
echo -e "${BLUE}Installing native messaging host manifest...${NC}"
make install-host

# 3. Verify installation
if [ -f "$HOME/.mozilla/native-messaging-hosts/mpris_volume_host.json" ]; then
    echo -e "${GREEN}✓ Successfully installed to ~/.mozilla/native-messaging-hosts/${NC}"
else
    echo -e "${RED}✗ Failed to install manifest to ~/.mozilla/native-messaging-hosts/${NC}"
    exit 1
fi

echo -e "${GREEN}Installation complete! Please restart your browser.${NC}"
