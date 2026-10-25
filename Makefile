# Bootstrap and manage the local Pi configuration.
# The default target installs every missing prerequisite, generates the default
# configuration when missing, installs the shared skills globally, and installs
# Cellar. Never run automatically (no CI, no hooks); review upstream skill content
# before installation.

.NOTPARALLEL:

ALEXANDRU_SKILLS_TAG := v13.2.1
MATTPOCOCK_SKILLS_TAG := v1.3.1
# The skills CLI installs `-a pi` into ~/.pi/agent/skills, which
# PI_CODING_AGENT_DIR setups do not read. Target the universal location
# (~/.agents/skills) that Pi discovers natively and shares with the other harnesses.
SKILLS_AGENT := universal
SKILLS_INSTALL_FLAGS := -g -a $(SKILLS_AGENT) -y
COURSIER_LINUX_X86_64_URL := https://github.com/coursier/launchers/raw/master/cs-x86_64-pc-linux.gz
COURSIER_LINUX_AARCH64_URL := https://github.com/VirtusLab/coursier-m1/releases/latest/download/cs-aarch64-pc-linux.gz
# Coursier installs launchers outside the default PATH of a non-login shell.
COURSIER_BIN_PATHS := $(HOME)/.local/bin:$(HOME)/.local/share/coursier/bin:$(HOME)/Library/Application Support/Coursier/bin

.PHONY: all install-pipx generate-config check-mattpocock-skills-tag install-skills update-skills install-coursier install-cellar test-pi-switch

all: install-pipx generate-config install-skills install-cellar

# pi-switch runs through pipx.
install-pipx:
	@set -e; \
	if command -v pipx >/dev/null 2>&1; then \
		echo "pipx already installed: $$(pipx --version)"; exit 0; \
	fi; \
	case "$$(uname -s)" in \
		Darwin) brew install pipx ;; \
		Linux) sudo apt-get install -y pipx ;; \
		*) echo "Unsupported platform: $$(uname -s)" >&2; exit 1 ;; \
	esac

generate-config:
	@if [ -f settings.json ] && [ -f agents.models.json ]; then \
		echo "settings.json and agents.models.json already exist; leaving them untouched"; \
	else \
		./bin/pi-switch default; \
	fi

check-mattpocock-skills-tag:
	@latest=$$(git ls-remote --tags --refs --sort=-version:refname https://github.com/mattpocock/skills.git 'v*' 2>/dev/null | sed -n '1s#.*refs/tags/##p'); \
	if [ -z "$$latest" ]; then \
		echo "WARN: unable to check the latest mattpocock/skills tag"; \
	elif [ "$$latest" != "$(MATTPOCOCK_SKILLS_TAG)" ]; then \
		echo "WARN: mattpocock/skills is pinned to $(MATTPOCOCK_SKILLS_TAG); latest tag is $$latest"; \
	fi

install-skills:
	npx skills add https://github.com/alexandru/skills/tree/$(ALEXANDRU_SKILLS_TAG) $(SKILLS_INSTALL_FLAGS) --skill \
		code-review \
		code-reviewing \
		code-refine \
		code-refinements \
		external-research
	npx skills add https://github.com/mattpocock/skills/tree/$(MATTPOCOCK_SKILLS_TAG) $(SKILLS_INSTALL_FLAGS) --skill \
		codebase-design \
		diagnosing-bugs \
		domain-modeling \
		grill-me \
		grill-with-docs \
		grilling \
		handoff \
		implement \
		improve-codebase-architecture \
		setup-matt-pocock-skills \
		tdd \
		teach \
		to-spec \
		to-tickets
	npx skills add https://github.com/VirtusLab/cellar/ $(SKILLS_INSTALL_FLAGS)
	npx skills add https://github.com/JuliusBrussee/caveman $(SKILLS_INSTALL_FLAGS) --skill caveman
	@echo "Shared skills installed in ~/.agents/skills."

update-skills: check-mattpocock-skills-tag
	$(MAKE) install-skills

# The cellar skill shells out to the cellar CLI, installed through Coursier.
install-coursier:
	@set -e; \
	export PATH="$(COURSIER_BIN_PATHS):$$PATH"; \
	if command -v cs >/dev/null 2>&1; then \
		echo "coursier already installed: $$(cs version)"; exit 0; \
	elif command -v coursier >/dev/null 2>&1; then \
		echo "coursier already installed: $$(coursier version)"; exit 0; \
	fi; \
	case "$$(uname -s)" in \
		Darwin) \
			brew install coursier; \
			coursier setup --yes ;; \
		Linux) \
			case "$$(uname -m)" in \
				x86_64|amd64) url="$(COURSIER_LINUX_X86_64_URL)" ;; \
				aarch64|arm64) url="$(COURSIER_LINUX_AARCH64_URL)" ;; \
				*) echo "Unsupported architecture: $$(uname -m)" >&2; exit 1 ;; \
			esac; \
			mkdir -p "$$HOME/.local/bin"; \
			archive=$$(mktemp); \
			trap 'rm -f "$$archive"' 0; \
			curl -fL "$$url" -o "$$archive"; \
			gzip -dc "$$archive" > "$$HOME/.local/bin/cs"; \
			chmod +x "$$HOME/.local/bin/cs"; \
			"$$HOME/.local/bin/cs" setup --yes ;; \
		*) echo "Unsupported platform: $$(uname -s)" >&2; exit 1 ;; \
	esac

install-cellar: install-coursier
	@set -e; \
	export PATH="$(COURSIER_BIN_PATHS):$$PATH"; \
	if command -v cellar >/dev/null 2>&1; then \
		echo "cellar already installed: $$(cellar --version)"; exit 0; \
	fi; \
	if command -v cs >/dev/null 2>&1; then cs=cs; else cs=coursier; fi; \
	"$$cs" install --contrib cellar; \
	cellar --version; \
	cellar telemetry disable --global

test-pi-switch:
	./bin/pi-switch-test.py
