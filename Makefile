# SPDX-License-Identifier: GPL-2.0-or-later

UUID := topbar-swipe@koustavbetal.github.io
ZIP  := $(UUID).shell-extension.zip
BUILD := dist/$(UUID)

# Everything that ships. Compiled schemas are left out on purpose: GNOME 44+
# compiles them on install, and extensions.gnome.org rejects them for 45+.
SOURCES := extension.js prefs.js metadata.json stylesheet.css LICENSE
DIRS    := lib prefs icons

.PHONY: all schemas pack install lint logs clean

all: pack

# For running straight from the source folder.
schemas:
	glib-compile-schemas schemas/

pack: clean
	mkdir -p $(BUILD)/schemas
	cp $(SOURCES) $(BUILD)/
	cp -r $(DIRS) $(BUILD)/
	cp schemas/*.gschema.xml $(BUILD)/schemas/
	cd $(BUILD) && zip -qr ../../$(ZIP) .
	rm -rf dist
	@echo "Built $(ZIP):"
	@unzip -Z1 $(ZIP)

# Replaces the installed folder. Don't use this when the repo itself lives
# in ~/.local/share/gnome-shell/extensions/ (it would wipe .git); use
# `make schemas` there instead.
install: pack
	gnome-extensions install --force $(ZIP)
	@echo "Log out and back in (Wayland), then: gnome-extensions enable $(UUID)"

lint:
	npx eslint .

logs:
	journalctl -f -o cat /usr/bin/gnome-shell

clean:
	rm -rf dist $(ZIP)
