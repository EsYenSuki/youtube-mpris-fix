#!/bin/bash
set -e

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Configuration
TARGET_DIR="$HOME/.config/youtube-mpris-fix"
HOST_DIR="$HOME/.mozilla/native-messaging-hosts"
BINARY_NAME="mpris_volume_host"
BINARY_PATH="$TARGET_DIR/$BINARY_NAME"
MANIFEST_NAME="mpris_volume_host.json"

echo -e "${BLUE}Starting installation of YouTube MPRIS Fix...${NC}"

# 1. Create target directory for the binary
echo -e "${BLUE}Creating directory $TARGET_DIR...${NC}"
mkdir -p "$TARGET_DIR"

# 2. Compile the native host
echo -e "${BLUE}Building native host...${NC}"
# We use the Makefile to build, but we'll move it after.
# Note: The Makefile builds to 'native/mpris_volume_host'
make host

# Move compiled binary to the config directory
echo -e "${BLUE}Moving binary to $BINARY_PATH...${NC}"
cp native/mpris_volume_host "$BINARY_PATH"
chmod +x "$BINARY_PATH"

# 3. Update the manifest JSON with the new path
echo -e "${BLUE}Updating manifest path in native/$MANIFEST_NAME...${NC}"
# Using python to safely edit the JSON file
python3 -c "
import json
import os

manifest_path = 'native/$MANIFEST_NAME'
new_path = '$BINARY_PATH'

with open(manifest_path, 'r') as f:
    data = json.load(f)

data['path'] = new_path

with open(manifest_path, 'w') as f:
    json.dump(data, f, indent=2)
"

# 4. Install the manifest to the browser's host directory
echo -e "${BLUE}Installing native messaging host manifest to $HOST_DIR...${NC}"
mkdir -p "$HOST_DIR"
cp "native/$MANIFEST_NAME" "$HOST_DIR/"

# 5. Verify installation
echo -e "${BLUE}Verifying installation...${NC}"

if [ -f "$BINARY_PATH" ]; then
    echo -e "${GREEN}✓ Binary installed to $BINARY_PATH${NC}"
else
    echo -e "${RED}✗ Failed to find binary at $BINARY_PATH${NC}"
    exit 1
fi

if [ -f "$HOST_DIR/$MANIFEST_NAME" ]; then
    echo -e "${GREEN}✓ Manifest installed to $HOST_DIR/$MANIFEST_NAME${NC}"
    # Verify the path inside the installed manifest
    INSTALLED_PATH=$(python3 -c "import json; print(json.load(open('$HOST_DIR/$MANIFEST_NAME'))['path'])")
    echo -e "   Manifest path is: $INSTALLED_PATH"
    if [ "$INSTALLED_PATH" == "$BINARY_PATH" ]; then
        echo -e "${GREEN}✓ Manifest path is correct.${NC}"
    else
        echo -e "${RED}✗ Manifest path mismatch! Expected $BINARY_PATH but found $INSTALLED_PATH${NC}"
        exit 1
    fi
else
    echo -e "${RED}✗ Failed to install manifest to $HOST_DIR/${NC}"
    exit 1
fi

echo -e "${GREEN}Installation complete! Please restart your browser.${NC}"
