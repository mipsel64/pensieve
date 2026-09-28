SHELL := /bin/sh
.DEFAULT_GOAL := build

OS := $(shell uname -s)
CARGO_TARGET_DIR ?= target
BIN_DIR := $(HOME)/.local/bin
BINS := pensieve-server pensieve
CONFIG := $(HOME)/.config/pensieve/environment
PLIST := $(HOME)/.config/pensieve/pensieve.plist
LAUNCHD_PLIST := /Library/LaunchDaemons/io.github.mipsel64.pensieve.plist
LAUNCHD_SERVICE := system/io.github.mipsel64.pensieve
BOOTOUT_TIMEOUT ?= 30
SYSTEMD_DIR := $(or $(XDG_CONFIG_HOME),$(HOME)/.config)/systemd/user

.PHONY: build install setup restart status clean ensure-config ensure-os

build:
	cargo build --locked --release --target-dir "$(CARGO_TARGET_DIR)"

install: build
	@set -eu; \
	mkdir -p "$(BIN_DIR)"; \
	tmp=; \
	trap 'rm -f "$$tmp"' 0; \
	for bin in $(BINS); do \
		tmp=$$(mktemp "$(BIN_DIR)/.$$bin.XXXXXX"); \
		install -m 755 "$(CARGO_TARGET_DIR)/release/$$bin" "$$tmp"; \
		mv -f "$$tmp" "$(BIN_DIR)/$$bin"; \
	done

ensure-config:
	@set -eu; \
	if ! test -f "$(CONFIG)"; then \
		umask 077; \
		mkdir -p "$$(dirname "$(CONFIG)")"; \
		token=$$(od -An -tx1 -N32 /dev/urandom | tr -d ' \n'); \
		sed "s/^PENSIEVE_TOKEN=$$/PENSIEVE_TOKEN=$$token/" pensieve.example.env > "$(CONFIG)"; \
		printf '%s\n' \
			"Created $(CONFIG) with a new PENSIEVE_TOKEN." \
			'Clients need the same token. Add PENSIEVE_JEV_KEY there to enable Jev, then run make restart.' >&2; \
	fi

ensure-os:
	@case "$(OS)" in Darwin|Linux) ;; *) printf 'Unsupported OS: %s\n' "$(OS)" >&2; exit 1 ;; esac

setup: ensure-os ensure-config
	$(MAKE) install
ifeq ($(OS),Darwin)
	@set -eu; umask 077; \
	mkdir -p "$(HOME)/Library/Logs/pensieve"; \
	chmod 700 "$(HOME)/Library/Logs/pensieve"; \
	test -e "$(PLIST)" || cp examples/pensieve.plist "$(PLIST)"; \
	plutil -replace UserName -string "$$(id -un)" "$(PLIST)"; \
	plutil -remove ProgramArguments.3 "$(PLIST)"; \
	plutil -insert ProgramArguments.3 -string "$(CONFIG)" "$(PLIST)"; \
	plutil -remove ProgramArguments.4 "$(PLIST)"; \
	plutil -insert ProgramArguments.4 -string "$(BIN_DIR)/pensieve-server" "$(PLIST)"; \
	plutil -replace EnvironmentVariables.HOME -string "$(HOME)" "$(PLIST)"; \
	plutil -replace StandardOutPath -string "$(HOME)/Library/Logs/pensieve/stdout.log" "$(PLIST)"; \
	plutil -replace StandardErrorPath -string "$(HOME)/Library/Logs/pensieve/stderr.log" "$(PLIST)"; \
	plutil -lint "$(PLIST)"; \
	sudo install -o root -g wheel -m 644 "$(PLIST)" "$(LAUNCHD_PLIST)"
	sudo launchctl enable "$(LAUNCHD_SERVICE)"
else ifeq ($(OS),Linux)
	mkdir -p "$(SYSTEMD_DIR)"
	install -m 644 examples/pensieve.service "$(SYSTEMD_DIR)/pensieve.service"
	systemctl --user daemon-reload
	systemctl --user enable pensieve.service
endif
	$(MAKE) restart REBUILD=0

restart: ensure-os
ifeq ($(REBUILD),1)
	$(MAKE) install
endif
ifeq ($(OS),Darwin)
	@set -eu; \
	if launchctl print "$(LAUNCHD_SERVICE)" >/dev/null 2>&1; then \
		sudo launchctl bootout "$(LAUNCHD_SERVICE)" || true; \
		waited=0; \
		while launchctl print "$(LAUNCHD_SERVICE)" >/dev/null 2>&1; do \
			if test "$$waited" -ge "$(BOOTOUT_TIMEOUT)"; then \
				printf 'Still loaded after %ss; rerun make restart once it exits.\n' "$(BOOTOUT_TIMEOUT)" >&2; \
				exit 1; \
			fi; \
			sleep 1; \
			waited=$$((waited + 1)); \
		done; \
	fi; \
	sudo launchctl bootstrap system "$(LAUNCHD_PLIST)"
else ifeq ($(OS),Linux)
	systemctl --user restart pensieve.service
endif

status: ensure-os
ifeq ($(OS),Darwin)
	launchctl print "$(LAUNCHD_SERVICE)"
else ifeq ($(OS),Linux)
	systemctl --user status --no-pager pensieve.service
endif

clean: ensure-os
ifeq ($(OS),Darwin)
	@if launchctl print "$(LAUNCHD_SERVICE)" >/dev/null 2>&1; then \
		sudo launchctl bootout "$(LAUNCHD_SERVICE)"; \
	fi
	@if test -e "$(LAUNCHD_PLIST)"; then sudo rm -f "$(LAUNCHD_PLIST)"; fi
else ifeq ($(OS),Linux)
	@set -eu; \
	if test -e "$(SYSTEMD_DIR)/pensieve.service" || systemctl --user is-active --quiet pensieve.service; then \
		systemctl --user stop pensieve.service; \
		if test -e "$(SYSTEMD_DIR)/pensieve.service"; then \
			systemctl --user disable pensieve.service; \
			rm -f "$(SYSTEMD_DIR)/pensieve.service"; \
		fi; \
		systemctl --user daemon-reload; \
	fi
endif
	cd "$(BIN_DIR)" && rm -f $(BINS)
