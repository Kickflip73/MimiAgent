#import <AppKit/AppKit.h>

@interface BridgeHostDelegate : NSObject
@property(nonatomic, strong) NSWindow *window;
@property(nonatomic, strong) NSTextView *textView;
@end

@implementation BridgeHostDelegate
- (void)start {
  [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
  self.window = [[NSWindow alloc]
    initWithContentRect:NSMakeRect(-2000, -2000, 800, 600)
    styleMask:NSWindowStyleMaskBorderless
    backing:NSBackingStoreBuffered
    defer:NO];
  self.textView = [[NSTextView alloc] initWithFrame:NSMakeRect(300, 20, 480, 160)];
  NSButton *button = [[NSButton alloc] initWithFrame:NSMakeRect(20, 480, 240, 80)];
  button.title = @"Target";
  button.target = self;
  button.action = @selector(selectTarget:);
  [self.window.contentView addSubview:self.textView];
  [self.window.contentView addSubview:button];
}

- (void)selectTarget:(id)sender {
  [self.window makeFirstResponder:self.textView];
}
@end

int main(void) {
  @autoreleasepool {
    NSApplication *application = NSApplication.sharedApplication;
    BridgeHostDelegate *delegate = [BridgeHostDelegate new];
    [delegate start];
    [application run];
  }
  return 0;
}
