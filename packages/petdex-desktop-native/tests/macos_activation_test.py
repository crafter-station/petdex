import os
from pathlib import Path
import re
import subprocess
import tempfile

sdk = Path(os.environ["NATIVE_SDK_PATH"])
source = (sdk / "src/platform/macos/appkit_host.m").read_text()
helper = re.search(r"static void NativeSdkActivateApplication\(void\) \{.*?\n\}", source, re.S)
if helper is None:
    raise SystemExit("Missing macOS activation compatibility helper")

probe = r'''#import <AppKit/AppKit.h>
#include <stdio.h>

static int simulatedMajor = 12;
int __isPlatformVersionAtLeast(unsigned platform, unsigned major, unsigned minor, unsigned patch) {
    return simulatedMajor >= (int)major;
}

static int legacyCalls = 0;
static int modernCalls = 0;
@interface LegacyApp : NSObject
- (void)activateIgnoringOtherApps:(BOOL)ignore;
@end
@implementation LegacyApp
- (void)activateIgnoringOtherApps:(BOOL)ignore { if (ignore) legacyCalls++; }
@end
@interface ModernApp : LegacyApp
- (void)activate;
@end
@implementation ModernApp
- (void)activate { modernCalls++; }
@end

__SDK_ACTIVATION_HELPER__

int main(void) {
    @autoreleasepool {
        LegacyApp *legacy = [LegacyApp new];
        NSApp = (NSApplication *)legacy;
        BOOL reproduced = NO;
        @try { [NSApp performSelector:@selector(activate)]; }
        @catch (NSException *exception) {
            reproduced = [exception.name isEqualToString:NSInvalidArgumentException];
            printf("Old call: %s\n", exception.reason.UTF8String);
        }
        if (!reproduced) return 1;
        NativeSdkActivateApplication();
        if (legacyCalls != 1 || modernCalls != 0) return 2;
        simulatedMajor = 14;
        ModernApp *modern = [ModernApp new];
        NSApp = (NSApplication *)modern;
        NativeSdkActivateApplication();
        if (legacyCalls != 1 || modernCalls != 1) return 3;
        NSApp = nil;
        printf("PASS: unavailable selector reproduced; legacy and modern activation paths verified\n");
    }
    return 0;
}
'''
probe = probe.replace("__SDK_ACTIVATION_HELPER__", helper.group(0))
with tempfile.TemporaryDirectory(prefix="petdex-macos-activation-") as temp:
    path = Path(temp)
    (path / "activation.m").write_text(probe)
    subprocess.run([
        "xcrun", "clang", "-fobjc-arc", "-mmacosx-version-min=11.0",
        "-Werror=unguarded-availability", "-Werror=unguarded-availability-new",
        "-framework", "AppKit", str(path / "activation.m"), "-o", str(path / "activation"),
    ], check=True)
    subprocess.run([str(path / "activation")], check=True)
