#import <AppKit/AppKit.h>
#import <CoreFoundation/CoreFoundation.h>
#import <Foundation/Foundation.h>
#import <objc/runtime.h>
#include <sys/stat.h>

static NSString *const MimiPortPrefix = @"com.mimi.wechat.bridge";

static NSString *MimiExpectedToken(void) {
  NSString *value = NSProcessInfo.processInfo.environment[@"MIMI_WECHAT_BRIDGE_TOKEN"];
  if (value.length >= 32) return value;
  NSString *path = NSProcessInfo.processInfo.environment[@"MIMI_WECHAT_BRIDGE_TOKEN_FILE"];
  struct stat metadata;
  if (path.length == 0 || lstat(path.fileSystemRepresentation, &metadata) != 0
    || !S_ISREG(metadata.st_mode) || metadata.st_uid != getuid()
    || (metadata.st_mode & (S_IRWXG | S_IRWXO)) != 0) {
    return nil;
  }
  NSString *fileValue = [NSString stringWithContentsOfFile:path
    encoding:NSUTF8StringEncoding error:nil];
  value = [fileValue stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
  return value.length >= 32 ? value : nil;
}

static NSData *MimiJSON(NSDictionary *value) {
  return [NSJSONSerialization dataWithJSONObject:value options:0 error:nil] ?: [NSData data];
}

static NSArray<NSString *> *MimiMethodNames(Class type) {
  NSMutableArray<NSString *> *names = [NSMutableArray array];
  for (Class current = type; current != Nil && names.count < 120;
    current = class_getSuperclass(current)) {
    unsigned int count = 0;
    Method *methods = class_copyMethodList(current, &count);
    for (unsigned int index = 0; index < count && names.count < 120; index += 1) {
      [names addObject:NSStringFromSelector(method_getName(methods[index]))];
    }
    free(methods);
  }
  return names;
}

static NSWindow *MimiChatWindow(void) {
  NSWindow *selected = nil;
  for (NSWindow *window in NSApp.windows) {
    NSSize size = window.frame.size;
    if (size.width >= 250 && size.height >= 300 && window.contentView != nil
      && (selected == nil
        || size.width * size.height > selected.frame.size.width * selected.frame.size.height)) {
      selected = window;
    }
  }
  return selected;
}

static NSDictionary *MimiStatus(void) {
  NSWindow *window = MimiChatWindow();
  BOOL chatReady = window != nil && window.frame.size.width >= 700 && window.frame.size.height >= 500;
  return @{
    @"status": window == nil ? @"blocked" : (chatReady ? @"ready" : @"login_required"),
    @"pid": @(NSProcessInfo.processInfo.processIdentifier),
    @"active": @(NSApp.active),
    @"window": window == nil ? [NSNull null] : @{
      @"number": @(window.windowNumber),
      @"title": window.title ?: @"",
      @"width": @(window.frame.size.width),
      @"height": @(window.frame.size.height),
      @"firstResponder": NSStringFromClass(window.firstResponder.class) ?: @"",
    },
  };
}

static NSEvent *MimiMouseEvent(
  NSEventType type,
  NSWindow *window,
  NSPoint location,
  NSInteger clickCount
) {
  return [NSEvent mouseEventWithType:type
    location:location
    modifierFlags:0
    timestamp:NSProcessInfo.processInfo.systemUptime
    windowNumber:window.windowNumber
    context:nil
    eventNumber:0
    clickCount:clickCount
    pressure:type == NSEventTypeLeftMouseDown ? 1.0 : 0.0];
}

static NSDictionary *MimiClick(NSDictionary *request) {
  if (NSApp.active) {
    return @{@"status": @"failed", @"error": @"target_in_use"};
  }
  NSWindow *window = MimiChatWindow();
  NSView *content = window.contentView;
  NSNumber *xValue = request[@"x"];
  NSNumber *yValue = request[@"y"];
  if (window == nil || content == nil || ![xValue isKindOfClass:NSNumber.class]
    || ![yValue isKindOfClass:NSNumber.class]) {
    return @{@"status": @"failed", @"error": @"invalid_target"};
  }
  double x = xValue.doubleValue;
  double y = yValue.doubleValue;
  if (x < 0 || x > 1 || y < 0 || y > 1) {
    return @{@"status": @"failed", @"error": @"coordinate_out_of_bounds"};
  }
  NSRect bounds = content.bounds;
  NSPoint contentPoint = NSMakePoint(
    NSMinX(bounds) + x * NSWidth(bounds),
    NSMinY(bounds) + (1.0 - y) * NSHeight(bounds)
  );
  NSPoint windowPoint = [content convertPoint:contentPoint toView:nil];
  NSView *hit = [content hitTest:contentPoint];
  if (hit == nil) {
    return @{@"status": @"failed", @"error": @"hit_test_failed"};
  }
  BOOL wasMainWindow = window.mainWindow;
  if (!wasMainWindow) [window makeMainWindow];
  if (NSApp.active) {
    return @{@"status": @"uncertain", @"error": @"foreground_violation"};
  }
  NSPoint screenPoint = [window convertPointToScreen:windowPoint];
  id accessibilityHit = [content accessibilityHitTest:screenPoint];
  NSArray *accessibilityActions = [accessibilityHit respondsToSelector:@selector(accessibilityActionNames)]
    ? [accessibilityHit accessibilityActionNames]
    : @[];
  BOOL accessibilityPressed = NO;
  if (accessibilityHit != nil && accessibilityHit != content
    && [accessibilityHit respondsToSelector:@selector(accessibilityPerformPress)]) {
    accessibilityPressed = [accessibilityHit accessibilityPerformPress];
    if (!accessibilityPressed && [accessibilityActions containsObject:NSAccessibilityPressAction]
      && [accessibilityHit respondsToSelector:@selector(accessibilityPerformAction:)]) {
      [accessibilityHit accessibilityPerformAction:NSAccessibilityPressAction];
      accessibilityPressed = YES;
    }
  } else if ([hit isKindOfClass:NSControl.class]) {
    [(NSControl *)hit performClick:nil];
  } else {
    [window sendEvent:MimiMouseEvent(NSEventTypeLeftMouseDown, window, windowPoint, 1)];
    [window sendEvent:MimiMouseEvent(NSEventTypeLeftMouseUp, window, windowPoint, 1)];
  }
  if (NSApp.active) {
    return @{@"status": @"uncertain", @"error": @"foreground_violation"};
  }
  return @{
    @"status": @"applied",
    @"delivery": @"background",
    @"viewClass": NSStringFromClass(hit.class) ?: @"",
    @"wasMainWindow": @(wasMainWindow),
    @"isMainWindow": @(window.mainWindow),
    @"accessibilityClass": NSStringFromClass([accessibilityHit class]) ?: @"",
    @"accessibilityRole": [accessibilityHit accessibilityRole] ?: @"",
    @"accessibilityLabel": [accessibilityHit accessibilityLabel] ?: @"",
    @"accessibilityTitle": [accessibilityHit accessibilityTitle] ?: @"",
    @"accessibilityIdentifier": [accessibilityHit accessibilityIdentifier] ?: @"",
    @"accessibilityActions": accessibilityActions ?: @[],
    @"accessibilityMethods": MimiMethodNames([accessibilityHit class]),
    @"accessibilityPressed": @(accessibilityPressed),
    @"firstResponder": NSStringFromClass(window.firstResponder.class) ?: @"",
  };
}

static NSDictionary *MimiType(NSDictionary *request) {
  if (NSApp.active) {
    return @{@"status": @"failed", @"error": @"target_in_use"};
  }
  NSWindow *window = MimiChatWindow();
  NSString *value = request[@"text"];
  NSResponder *responder = window.firstResponder;
  if (window == nil || ![value isKindOfClass:NSString.class] || value.length == 0) {
    return @{@"status": @"failed", @"error": @"invalid_text"};
  }
  if (![responder conformsToProtocol:@protocol(NSTextInputClient)]) {
    return @{
      @"status": @"failed",
      @"error": @"input_not_focused",
      @"firstResponder": NSStringFromClass(responder.class) ?: @"",
    };
  }
  [(id<NSTextInputClient>)responder insertText:value replacementRange:NSMakeRange(NSNotFound, 0)];
  if (NSApp.active) {
    return @{@"status": @"uncertain", @"error": @"foreground_violation"};
  }
  return @{
    @"status": @"applied",
    @"delivery": @"background",
    @"textLength": @(value.length),
    @"firstResponder": NSStringFromClass(responder.class) ?: @"",
  };
}

static NSDictionary *MimiKey(NSDictionary *request) {
  if (NSApp.active) {
    return @{@"status": @"failed", @"error": @"target_in_use"};
  }
  NSWindow *window = MimiChatWindow();
  NSString *key = request[@"key"];
  NSResponder *responder = window.firstResponder;
  if (window == nil || ![key isEqualToString:@"return"] || responder == nil) {
    return @{@"status": @"failed", @"error": @"invalid_key_target"};
  }
  NSEvent *event = [NSEvent keyEventWithType:NSEventTypeKeyDown
    location:NSZeroPoint
    modifierFlags:0
    timestamp:NSProcessInfo.processInfo.systemUptime
    windowNumber:window.windowNumber
    context:nil
    characters:@"\r"
    charactersIgnoringModifiers:@"\r"
    isARepeat:NO
    keyCode:36];
  [responder keyDown:event];
  if (NSApp.active) {
    return @{@"status": @"uncertain", @"error": @"foreground_violation"};
  }
  return @{@"status": @"applied", @"delivery": @"background"};
}

static NSDictionary *MimiHandle(NSDictionary *request) {
  NSString *expected = MimiExpectedToken();
  NSString *actual = request[@"token"];
  if (expected.length < 32 || ![actual isKindOfClass:NSString.class]
    || ![actual isEqualToString:expected]) {
    return @{@"status": @"failed", @"error": @"unauthorized"};
  }
  NSString *action = request[@"action"];
  if ([action isEqualToString:@"status"]) return MimiStatus();
  if ([action isEqualToString:@"click"]) return MimiClick(request);
  if ([action isEqualToString:@"type"]) return MimiType(request);
  if ([action isEqualToString:@"key"]) return MimiKey(request);
  return @{@"status": @"failed", @"error": @"unsupported_action"};
}

static CFDataRef MimiPortCallback(
  CFMessagePortRef local,
  SInt32 messageId,
  CFDataRef data,
  void *info
) {
  @autoreleasepool {
    if (messageId != 1 || data == nil) {
      return CFBridgingRetain(MimiJSON(@{@"status": @"failed", @"error": @"invalid_request"}));
    }
    NSDictionary *request = [NSJSONSerialization JSONObjectWithData:(__bridge NSData *)data
      options:0 error:nil];
    if (![request isKindOfClass:NSDictionary.class]) {
      return CFBridgingRetain(MimiJSON(@{@"status": @"failed", @"error": @"invalid_json"}));
    }
    __block NSDictionary *response;
    dispatch_sync(dispatch_get_main_queue(), ^{
      response = MimiHandle(request);
    });
    return CFBridgingRetain(MimiJSON(response));
  }
}

static void MimiRunServer(void) {
  @autoreleasepool {
    NSString *name = [NSString stringWithFormat:@"%@.%u", MimiPortPrefix, getuid()];
    CFMessagePortContext context = {0, NULL, NULL, NULL, NULL};
    Boolean shouldFreeInfo = false;
    CFMessagePortRef port = CFMessagePortCreateLocal(
      kCFAllocatorDefault,
      (__bridge CFStringRef)name,
      MimiPortCallback,
      &context,
      &shouldFreeInfo
    );
    if (port == NULL) return;
    CFRunLoopSourceRef source = CFMessagePortCreateRunLoopSource(kCFAllocatorDefault, port, 0);
    CFRunLoopAddSource(CFRunLoopGetCurrent(), source, kCFRunLoopDefaultMode);
    CFRunLoopRun();
    CFRelease(source);
    CFRelease(port);
  }
}

__attribute__((constructor))
static void MimiInstallBridge(void) {
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
    MimiRunServer();
  });
}
