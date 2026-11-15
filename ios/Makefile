RUST := rust
RUST_DIR := $(RUST)
HEADERS := $(RUST)/crates/securechannel-dialect-c/include
LIBRARY := libsecurechannel_dialect.a
FRAMEWORK := build/SecureChannelDialect.xcframework
STABLE_TARGETS := aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios aarch64-apple-tvos aarch64-apple-tvos-sim aarch64-apple-darwin x86_64-apple-darwin
NIGHTLY_TARGETS := x86_64-apple-tvos
DEPLOYMENT := IPHONEOS_DEPLOYMENT_TARGET=16.0 TVOS_DEPLOYMENT_TARGET=16.0 MACOSX_DEPLOYMENT_TARGET=13.0
STABLE_DIR := $(RUST)/target
NIGHTLY_DIR := $(RUST)/target-nightly

stable = $(STABLE_DIR)/$(1)/release/$(LIBRARY)
nightly = $(NIGHTLY_DIR)/$(1)/release/$(LIBRARY)

.PHONY: all libraries targets clean-framework

all: $(FRAMEWORK)

targets:
	rustup target add $(STABLE_TARGETS)
	rustup toolchain install nightly --profile minimal --component rust-src

libraries:
	cd $(RUST) && for target in $(STABLE_TARGETS); do $(DEPLOYMENT) cargo build --release -p securechannel-dialect-c --target $$target || exit 1; done
	cd $(RUST) && for target in $(NIGHTLY_TARGETS); do $(DEPLOYMENT) cargo +nightly build --release -Z build-std=std -p securechannel-dialect-c --target $$target --target-dir target-nightly || exit 1; done

$(FRAMEWORK): libraries
	mkdir -p build/ios-simulator build/tvos-simulator build/macos
	lipo -create $(call stable,aarch64-apple-ios-sim) $(call stable,x86_64-apple-ios) -output build/ios-simulator/$(LIBRARY)
	lipo -create $(call stable,aarch64-apple-tvos-sim) $(call nightly,x86_64-apple-tvos) -output build/tvos-simulator/$(LIBRARY)
	lipo -create $(call stable,aarch64-apple-darwin) $(call stable,x86_64-apple-darwin) -output build/macos/$(LIBRARY)
	rm -rf $(FRAMEWORK)
	xcodebuild -create-xcframework \
		-library $(call stable,aarch64-apple-ios) -headers $(HEADERS) \
		-library build/ios-simulator/$(LIBRARY) -headers $(HEADERS) \
		-library $(call stable,aarch64-apple-tvos) -headers $(HEADERS) \
		-library build/tvos-simulator/$(LIBRARY) -headers $(HEADERS) \
		-library build/macos/$(LIBRARY) -headers $(HEADERS) \
		-output $(FRAMEWORK)

-include $(HOME)/Projects/omarchy/rust-policy/policy.mk
