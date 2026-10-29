all: run

run: manifest.json content.js background.js LICENSE host

# Native messaging host (C). Builds the binary that the browser launches.
host: native/mpris_volume_host

native/mpris_volume_host: native/mpris_volume_host.c
	$(CC) -O2 -Wall -Wextra -Werror -std=c11 -D_DEFAULT_SOURCE -o $@ $< $(shell pkg-config --cflags --libs gio-2.0) -lm

# Installs the native host manifest where Firefox/Zen look for it.
install-host: host
	mkdir -p $(HOME)/.mozilla/native-messaging-hosts
	cp native/mpris_volume_host.json $(HOME)/.mozilla/native-messaging-hosts/


test-host: host
	python3 native/test_host.py

# Simulates content.js + background.js against a fake page and native host.
# Needs node, not a browser.
test-js:
	node test/volume_sync.test.js

test: test-host test-js

.PHONY: all run host install-host test test-host test-js zip clean

zip: manifest.json content.js background.js LICENSE icons/*
	zip firefoxpkg.zip manifest.json content.js background.js LICENSE icons/*

clean:
	$(RM) firefoxpkg.zip native/mpris_volume_host
